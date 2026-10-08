/**
 * PostgreSQL-backed synchronisation store for RealShare.
 *
 * Uses the `pg` driver with a real connection Pool against a genuine PostgreSQL server
 * (PostgreSQL 18 via embedded-postgres in the experiments). Implements real transaction
 * semantics: idempotent event insertion via ON CONFLICT, row-level locking via
 * SELECT ... FOR UPDATE, advisory locks for single-writer sections, configurable isolation
 * level, retry-with-backoff on serialization/deadlock failures, checkpointing, a dead-letter
 * queue, reconciliation, and an audit log.
 */
import pg from "pg";
const { Pool } = pg;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS properties (
  property_id     BIGINT PRIMARY KEY,
  total_fractions BIGINT NOT NULL CHECK (total_fractions > 0),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS investors (
  wallet     TEXT PRIMARY KEY,
  kyc        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS token_holdings (
  property_id BIGINT NOT NULL,
  wallet      TEXT   NOT NULL,
  balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, wallet)
);
CREATE TABLE IF NOT EXISTS blockchain_events (
  id              BIGSERIAL PRIMARY KEY,
  chain_id        BIGINT NOT NULL,
  contract        TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  block_number    BIGINT NOT NULL,
  block_hash      TEXT,
  tx_index        INT,
  log_index       INT NOT NULL,
  event_sig       TEXT NOT NULL,
  property_id     BIGINT,
  token_id        BIGINT,
  sender          TEXT,
  receiver        TEXT,
  amount          BIGINT,
  confirmation_state TEXT NOT NULL DEFAULT 'confirmed',
  processing_state   TEXT NOT NULL DEFAULT 'new',
  retries         INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_event UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS ix_events_new ON blockchain_events (processing_state, block_number, log_index);
CREATE TABLE IF NOT EXISTS sync_checkpoints (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  checked INT NOT NULL DEFAULT 0,
  mismatches INT NOT NULL DEFAULT 0,
  repaired INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  log_index INT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export class PgStore {
  constructor(config, opts = {}) {
    // config: { host, port, user, password, database }
    this.pool = new Pool({ ...config, max: opts.poolMax ?? 10, idleTimeoutMillis: 2000,
      connectionTimeoutMillis: opts.connTimeoutMs ?? 3000, statement_timeout: opts.stmtTimeoutMs ?? 8000 });
    this.isolation = opts.isolation ?? "READ COMMITTED"; // READ COMMITTED | REPEATABLE READ | SERIALIZABLE
    this.maxRetries = opts.maxRetries ?? 4;
    this.stats = { applied: 0, duplicatesSkipped: 0, retries: 0, serializationRetries: 0, deadlockRetries: 0, deadLettered: 0 };
  }

  async init() { const c = await this.pool.connect(); try { await c.query(SCHEMA); } finally { c.release(); } }
  async end() { await this.pool.end(); }
  async query(q, p) { return this.pool.query(q, p); }

  async audit(action, detail) { await this.pool.query(`INSERT INTO audit_log(action, detail) VALUES ($1,$2)`, [action, detail || ""]); }

  async setCheckpoint(block) {
    await this.pool.query(
      `INSERT INTO sync_checkpoints(id, last_block) VALUES (1,$1)
       ON CONFLICT (id) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`, [block]);
  }
  async getCheckpoint() { const r = await this.pool.query(`SELECT last_block FROM sync_checkpoints WHERE id=1`); return r.rows[0] ? Number(r.rows[0].last_block) : -1; }

  async balanceOf(propertyId, wallet) {
    const r = await this.pool.query(`SELECT balance FROM token_holdings WHERE property_id=$1 AND wallet=$2`, [propertyId, wallet]);
    return r.rows[0] ? Number(r.rows[0].balance) : 0;
  }

  isRetryable(err) {
    // 40001 serialization_failure, 40P01 deadlock_detected, 55P03 lock_not_available, 57014 statement_timeout
    return ["40001", "40P01", "55P03"].includes(err.code);
  }

  /**
   * Apply one event atomically and idempotently. Uses a real transaction at the configured
   * isolation level, inserts the event with ON CONFLICT DO NOTHING (idempotency), and updates
   * balances with SELECT ... FOR UPDATE (row-level locking). Retries on serialization/deadlock.
   * Returns { applied, duplicate }.
   */
  async applyEvent(ev, { failHook } = {}) {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${this.isolation}`);
        const ins = await client.query(
          `INSERT INTO blockchain_events(chain_id,contract,tx_hash,block_number,block_hash,tx_index,log_index,event_sig,property_id,token_id,sender,receiver,amount,processing_state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'processed')
           ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`,
          [ev.chainId ?? 31337, ev.contract ?? "0x0", ev.txHash, ev.blockNumber ?? 0, ev.blockHash ?? null,
           ev.txIndex ?? 0, ev.logIndex, ev.eventSig, ev.propertyId ?? null, ev.tokenId ?? ev.propertyId ?? null,
           ev.sender ?? null, ev.receiver ?? null, ev.amount ?? null]);
        if (ins.rowCount === 0) { await client.query("ROLLBACK"); this.stats.duplicatesSkipped++; return { applied: false, duplicate: true }; }

        if (failHook) await failHook(client); // fault-injection point (may throw / disconnect)

        if (ev.eventSig === "FractionsMinted") {
          await this._credit(client, ev.propertyId, ev.receiver, ev.amount);
        } else { // transfer
          await this._credit(client, ev.propertyId, ev.sender, -ev.amount);
          await this._credit(client, ev.propertyId, ev.receiver, ev.amount);
        }
        await client.query("COMMIT");
        this.stats.applied++;
        return { applied: true, duplicate: false };
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch {}
        if (this.isRetryable(err) && attempt < this.maxRetries) {
          this.stats.retries++;
          if (err.code === "40001") this.stats.serializationRetries++;
          if (err.code === "40P01") this.stats.deadlockRetries++;
          await new Promise(r => setTimeout(r, 10 * (attempt + 1) + Math.random() * 20)); // backoff
          continue;
        }
        throw err;
      } finally { client.release(); }
    }
  }

  async _credit(client, propertyId, wallet, delta) {
    // lock the row (or create it) then update — real row-level locking
    await client.query(
      `INSERT INTO token_holdings(property_id, wallet, balance) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [propertyId, wallet]);
    const cur = await client.query(`SELECT balance FROM token_holdings WHERE property_id=$1 AND wallet=$2 FOR UPDATE`, [propertyId, wallet]);
    const next = Number(cur.rows[0].balance) + delta;
    await client.query(`UPDATE token_holdings SET balance=$3, updated_at=now() WHERE property_id=$1 AND wallet=$2`, [propertyId, wallet, next]);
  }

  async deadLetter(ev, reason) {
    await this.pool.query(`INSERT INTO dead_letter_queue(tx_hash, log_index, reason) VALUES ($1,$2,$3)`, [ev.txHash, ev.logIndex, reason]);
    this.stats.deadLettered++;
  }

  /** Reconcile DB holdings against an authoritative source (map of key->balance). */
  async reconcile(authoritative, { repair = false } = {}) {
    const run = await this.pool.query(`INSERT INTO reconciliation_runs(checked,mismatches,repaired) VALUES (0,0,0) RETURNING id`);
    const runId = run.rows[0].id;
    const rows = (await this.pool.query(`SELECT property_id, wallet, balance FROM token_holdings`)).rows;
    let checked = 0, mismatches = 0, repaired = 0;
    for (const r of rows) {
      checked++;
      const key = `${r.property_id}:${r.wallet}`;
      const truth = authoritative.has(key) ? authoritative.get(key) : 0;
      if (Number(r.balance) !== truth) {
        mismatches++;
        if (repair) { await this.pool.query(`UPDATE token_holdings SET balance=$3 WHERE property_id=$1 AND wallet=$2`, [r.property_id, r.wallet, truth]); repaired++; }
      }
    }
    await this.pool.query(`UPDATE reconciliation_runs SET finished_at=now(), checked=$2, mismatches=$3, repaired=$4 WHERE id=$1`, [runId, checked, mismatches, repaired]);
    return { checked, mismatches, repaired };
  }

  async advisoryLock(client, key) { await client.query(`SELECT pg_advisory_lock($1)`, [key]); }
  async advisoryUnlock(client, key) { await client.query(`SELECT pg_advisory_unlock($1)`, [key]); }
}
