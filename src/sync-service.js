/**
 * Event-driven synchronisation service for RealShare.
 *
 * Authoritative trigger = confirmed blockchain events (NOT API requests). The service polls
 * logs via provider.getLogs over [checkpoint+1, head - CONFIRMATIONS], decodes FractionsMinted
 * and TransferSingle/Batch, and applies them to the off-chain DB with:
 *   - idempotent processing (UNIQUE(tx_hash, log_index));
 *   - confirmation-depth policy (only events buried >= CONFIRMATIONS blocks are applied);
 *   - retry with a dead-letter queue on repeated failure;
 *   - checkpointing for replay/restart;
 *   - reorg handling (events whose block hash changed are marked reorged and reversed).
 *
 * The provider is wrapped so fault-injection tests can make getLogs / getBlockNumber throw
 * (RPC outage), delay, or return reorged data.
 */
const { ethers } = require("ethers");

const IFACE = new ethers.Interface([
  "event FractionsMinted(uint256 indexed propertyId, address indexed to, uint256 amount)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);

class SyncService {
  constructor(db, provider, contractAddress, opts = {}) {
    this.db = db;
    this.provider = provider;
    this.address = contractAddress;
    this.confirmations = opts.confirmations ?? 2;
    this.maxRetries = opts.maxRetries ?? 3;
    this.chainId = opts.chainId ?? 31337;
    this.stats = { ingested: 0, applied: 0, duplicatesSkipped: 0, retries: 0, deadLettered: 0, reorged: 0 };
  }

  _decode(log) {
    let parsed;
    try { parsed = IFACE.parseLog(log); } catch { return null; }
    if (!parsed) return null;
    const base = {
      tx_hash: log.transactionHash, block_number: log.blockNumber, block_hash: log.blockHash,
      tx_index: log.transactionIndex, log_index: log.index ?? log.logIndex, event_sig: parsed.name,
    };
    if (parsed.name === "FractionsMinted") {
      return [{ ...base, property_id: Number(parsed.args.propertyId), token_id: Number(parsed.args.propertyId),
        sender: ethers.ZeroAddress, receiver: parsed.args.to, amount: Number(parsed.args.amount), kind: "mint" }];
    }
    if (parsed.name === "TransferSingle") {
      // skip mints (from == 0) here; FractionsMinted already credits them
      if (parsed.args.from === ethers.ZeroAddress) return [];
      return [{ ...base, property_id: Number(parsed.args.id), token_id: Number(parsed.args.id),
        sender: parsed.args.from, receiver: parsed.args.to, amount: Number(parsed.args.value), kind: "transfer" }];
    }
    if (parsed.name === "TransferBatch") {
      if (parsed.args.from === ethers.ZeroAddress) return [];
      const out = [];
      parsed.args.ids.forEach((id, i) => out.push({ ...base, log_index: (base.log_index * 1000) + i,
        property_id: Number(id), token_id: Number(id), sender: parsed.args.from, receiver: parsed.args.to,
        amount: Number(parsed.args.values[i]), kind: "transfer" }));
      return out;
    }
    return [];
  }

  /** Ingest confirmed events into blockchain_events (idempotent), then apply them. */
  async poll() {
    const head = await this.provider.getBlockNumber();
    const safeHead = head - this.confirmations;
    const from = this.db.getCheckpoint() + 1;
    if (safeHead < from) return this.stats; // nothing buried deep enough yet

    const logs = await this.provider.getLogs({ address: this.address, fromBlock: from, toBlock: safeHead });
    const events = [];
    for (const log of logs) { const decoded = this._decode(log); if (decoded) events.push(...decoded); }

    const now = new Date().toISOString();
    for (const e of events) {
      // idempotency: UNIQUE(tx_hash, log_index)
      const existing = this.db.get(`SELECT id, processing_state FROM blockchain_events WHERE tx_hash=? AND log_index=?`,
        [e.tx_hash, e.log_index]);
      if (existing) { this.stats.duplicatesSkipped++; continue; }
      this.db.run(
        `INSERT INTO blockchain_events(chain_id,contract,tx_hash,block_number,block_hash,tx_index,log_index,event_sig,property_id,token_id,sender,receiver,amount,confirmation_state,processing_state,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'confirmed','new', ?, ?)`,
        [this.chainId, this.address, e.tx_hash, e.block_number, e.block_hash, e.tx_index, e.log_index, e.event_sig,
         e.property_id, e.token_id, e.sender, e.receiver, e.amount, now, now]);
      this.stats.ingested++;
    }

    await this._applyNew();
    this.db.setCheckpoint(safeHead);
    return this.stats;
  }

  async _applyNew() {
    const rows = this.db.all(`SELECT * FROM blockchain_events WHERE processing_state='new' ORDER BY block_number, log_index`);
    for (const r of rows) {
      try {
        if (r.event_sig === "FractionsMinted") {
          this.db.upsertHolding(r.property_id, r.receiver, r.amount);
        } else if (r.event_sig === "TransferSingle" || r.event_sig === "TransferBatch") {
          this.db.upsertHolding(r.property_id, r.sender, -r.amount);
          this.db.upsertHolding(r.property_id, r.receiver, r.amount);
        }
        this.db.run(`UPDATE blockchain_events SET processing_state='processed', updated_at=? WHERE id=?`,
          [new Date().toISOString(), r.id]);
        this.stats.applied++;
        this.db.audit("apply_event", `${r.event_sig} tx=${r.tx_hash} li=${r.log_index}`);
      } catch (err) {
        const retries = r.retries + 1;
        this.stats.retries++;
        if (retries >= this.maxRetries) {
          this.db.run(`UPDATE blockchain_events SET processing_state='dead', retries=?, updated_at=? WHERE id=?`,
            [retries, new Date().toISOString(), r.id]);
          this.db.run(`INSERT INTO dead_letter_queue(tx_hash,log_index,reason,created_at) VALUES (?,?,?,?)`,
            [r.tx_hash, r.log_index, String(err.message || err), new Date().toISOString()]);
          this.stats.deadLettered++;
        } else {
          this.db.run(`UPDATE blockchain_events SET processing_state='failed', retries=?, updated_at=? WHERE id=?`,
            [retries, new Date().toISOString(), r.id]);
        }
      }
    }
  }

  /** Retry failed (non-dead) events, e.g. after the DB recovers. */
  async retryFailed() {
    this.db.run(`UPDATE blockchain_events SET processing_state='new' WHERE processing_state='failed'`);
    await this._applyNew();
    return this.stats;
  }

  /** Replay from a block: reset checkpoint so poll() re-reads (idempotency prevents double-apply). */
  replayFrom(block) { this.db.setCheckpoint(block - 1); this.db.audit("replay_from", String(block)); }

  /** Detect + reverse events whose recorded block hash no longer matches the canonical chain. */
  async handleReorg() {
    const rows = this.db.all(`SELECT * FROM blockchain_events WHERE processing_state='processed' AND confirmation_state='confirmed'`);
    let reorged = 0;
    for (const r of rows) {
      const blk = await this.provider.getBlock(r.block_number);
      if (!blk || (r.block_hash && blk.hash && blk.hash !== r.block_hash)) {
        // reverse the effect and mark reorged
        if (r.event_sig === "FractionsMinted") this.db.upsertHolding(r.property_id, r.receiver, -r.amount);
        else { this.db.upsertHolding(r.property_id, r.sender, r.amount); this.db.upsertHolding(r.property_id, r.receiver, -r.amount); }
        this.db.run(`UPDATE blockchain_events SET confirmation_state='reorged', processing_state='new', updated_at=? WHERE id=?`,
          [new Date().toISOString(), r.id]);
        this.stats.reorged++; reorged++;
        this.db.audit("reorg_reverse", `tx=${r.tx_hash} li=${r.log_index}`);
      }
    }
    return reorged;
  }
}

class Reconciler {
  constructor(db, contract) { this.db = db; this.contract = contract; }
  /** Compare every DB holding against the authoritative on-chain balance; optionally repair. */
  async run({ repair = false } = {}) {
    const start = new Date().toISOString();
    this.db.run(`INSERT INTO reconciliation_runs(started_at,checked,mismatches,repaired) VALUES (?,0,0,0)`, [start]);
    const runId = this.db.get(`SELECT last_insert_rowid() AS id`).id;
    const holdings = this.db.all(`SELECT property_id, wallet FROM token_holdings`);
    let checked = 0, mismatches = 0, repaired = 0;
    const details = [];
    for (const h of holdings) {
      checked++;
      const onchain = Number(await this.contract.balanceOf(h.wallet, h.property_id));
      const offchain = this.db.balanceOf(h.property_id, h.wallet);
      if (onchain !== offchain) {
        mismatches++;
        details.push({ property_id: h.property_id, wallet: h.wallet, onchain, offchain });
        if (repair) { this.db.upsertHolding(h.property_id, h.wallet, onchain, true); repaired++; this.db.audit("reconcile_repair", `${h.wallet}#${h.property_id} ${offchain}->${onchain}`); }
      }
    }
    this.db.run(`UPDATE reconciliation_runs SET finished_at=?, checked=?, mismatches=?, repaired=? WHERE id=?`,
      [new Date().toISOString(), checked, mismatches, repaired, runId]);
    return { checked, mismatches, repaired, details };
  }
}

/** Provider wrapper for fault injection: toggles RPC outage / delay. */
class FaultyProvider {
  constructor(inner) { this.inner = inner; this.down = false; this.delayMs = 0; }
  async _guard() { if (this.down) throw new Error("RPC provider unavailable"); if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs)); }
  async getBlockNumber() { await this._guard(); return this.inner.getBlockNumber(); }
  async getLogs(f) { await this._guard(); return this.inner.getLogs(f); }
  async getBlock(b) { await this._guard(); return this.inner.getBlock(b); }
}

module.exports = { SyncService, Reconciler, FaultyProvider, IFACE };
