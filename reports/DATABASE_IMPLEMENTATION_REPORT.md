# Persistent Database Synchronisation — Implementation Report

**Status:** EXECUTED (implemented and exercised). **Engine:** sql.js (WASM SQLite), file-persistent.
**Honest substitution:** PostgreSQL was the intended engine; the evaluation environment had no
PostgreSQL server and no native build toolchain (`better-sqlite3` failed to compile), so a
file-backed SQLite (WASM) database was used. The schema and data-access layer are written to be
portable to PostgreSQL; the evaluated consistency and recovery semantics (idempotency,
confirmation depth, checkpointing, reconciliation, dead-letter queue) are engine-independent.
"Persistent" means state is durably written to a `.sqlite` file and survives a full DB
handle close-and-reopen (used to emulate a DB-server restart).

**Files:** `db/persistent-db.js` (schema + DAO), `src/sync-service.js` (SyncService, Reconciler,
FaultyProvider). Driver: `scripts/experiments/exp_db_fault_injection.js`.

## Schema (10 tables)

`properties`, `investors`, `token_holdings`, `blockchain_events`, `sync_checkpoints`,
`reconciliation_runs`, `dead_letter_queue`, `audit_log` (plus derived state). Every processed
event row stores: chain id, contract, tx hash, block number, block hash, tx index, **log index**,
event signature, property id, token id, sender, receiver, amount, confirmation state, processing
state, retries, created/updated timestamps. Idempotency is enforced by `UNIQUE(tx_hash, log_index)`.

## Processing model (authoritative trigger = confirmed events, not API requests)

1. `SyncService.poll()` reads logs over `[checkpoint+1, head − CONFIRMATIONS]` via
   `provider.getLogs` — so only events buried at least `CONFIRMATIONS` (=2) blocks deep are ever
   applied. Shallow events are withheld until confirmed.
2. Each decoded `FractionsMinted` / `TransferSingle` / `TransferBatch` event is inserted into
   `blockchain_events`; a duplicate `(tx_hash, log_index)` is skipped (idempotency).
3. New events are applied to `token_holdings` in canonical `(block_number, log_index)` order, so
   the final state is independent of arrival order.
4. On an apply failure the event is marked `failed`, retried up to `maxRetries` (=3); on repeated
   failure it is moved to the `dead_letter_queue` for manual intervention.
5. `setCheckpoint()` records the last safely-processed block for restart/replay.
6. `handleReorg()` compares each processed event's stored `block_hash` against the canonical
   chain and reverses the DB effect of any event whose block was reorged out.
7. `Reconciler.run({repair})` compares every DB holding against the authoritative on-chain
   `balanceOf` and optionally repairs mismatches, recording a `reconciliation_runs` row.

## Design-to-PostgreSQL portability notes

- All SQL is standard (no SQLite-only constructs beyond `AUTOINCREMENT`, trivially mapped to
  `SERIAL`/`IDENTITY`). `ON CONFLICT ... DO UPDATE` is supported by both engines.
- The DAO layer (`run/get/all`) is a thin wrapper that a `pg` client implements identically.
- Concurrency: the fault harness is single-threaded (deterministic); a PostgreSQL deployment
  would add row-level locking / `SELECT ... FOR UPDATE` on `token_holdings`, noted as future work.

This is a **prototype technical interoperability and consistency implementation**, not a
production database tier and not "legal interoperability".
