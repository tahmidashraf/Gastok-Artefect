# PostgreSQL Implementation Report

**Status:** EXECUTED against a **real PostgreSQL 18 server** (via `embedded-postgres`, which runs
the genuine PostgreSQL binary with no Docker or admin rights). This is not an emulation and not
SQLite.
**Files:** `db/pg/pg-store.mjs` (schema + pooled DAO), `scripts/experiments/exp_pg_faults.mjs`
(normal ops + faults), `scripts/experiments/exp_pg_concurrency.mjs` (isolation matrix).
**Raw:** `results/postgres/raw/pg_faults_*.json`, `results/postgres/raw/pg_concurrency_*.json`.

## Why this supersedes the SQLite prototype

The SQLite (WASM) prototype validated the recovery *logic* under controlled local conditions but
could not exercise PostgreSQL's networked, concurrent, transaction-isolation behaviour. This
implementation adds genuine PostgreSQL semantics:

- **Connection pooling** via `pg.Pool` (configurable `max`, connection + statement timeouts).
- **Real transactions** at a configurable isolation level (`READ COMMITTED` / `REPEATABLE READ` /
  `SERIALIZABLE`).
- **Idempotency** via `INSERT ... ON CONFLICT (tx_hash, log_index) DO NOTHING` on a `UNIQUE`
  constraint.
- **Row-level locking** via `SELECT ... FOR UPDATE` when crediting a holding.
- **Advisory locks** (`pg_advisory_lock`) available for single-writer sections.
- **Retry-with-backoff** on serialization (`40001`) and deadlock (`40P01`) failures.
- **Constraints**: `CHECK (balance >= 0)`, `CHECK (total_fractions > 0)`, primary/unique keys.
- **Checkpointing, dead-letter queue, reconciliation, audit log** as durable tables.

## Schema (14 relations)

`properties`, `investors`, `token_holdings`, `blockchain_events` (with `UNIQUE(tx_hash,
log_index)` and an index on `(processing_state, block_number, log_index)`), `sync_checkpoints`,
`reconciliation_runs`, `dead_letter_queue`, `audit_log`. Each event row stores chain id, contract,
tx hash, block number, block hash, tx index, log index, event signature, property id, token id,
sender, receiver, amount, confirmation state, processing state, retries, created/updated
timestamps.

## `applyEvent` transaction (the core path)

```
BEGIN ISOLATION LEVEL <configured>;
  INSERT INTO blockchain_events(... ) ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id;
  -- if no row returned -> duplicate -> ROLLBACK, skip (idempotent)
  -- else: for each affected holding:
  INSERT INTO token_holdings(...) ON CONFLICT DO NOTHING;
  SELECT balance FROM token_holdings WHERE ... FOR UPDATE;   -- row lock
  UPDATE token_holdings SET balance = balance +/- amount ...;
COMMIT;                                                       -- retry on 40001/40P01
```

## Environment
PostgreSQL 18.4 (embedded-postgres, native binary); `pg` driver; Node 18.14; Windows 11 x64;
Intel i7-1165G7. A production `docker-compose.yml`, migrations, and setup guide are provided in
`POSTGRESQL_SETUP.md` for deployment on a standalone PostgreSQL server.

## Honest scope
Single-node PostgreSQL (no replication/HA cluster). High-availability, streaming replication, and
`pg_basebackup`-based restore are production steps identified as future work.
