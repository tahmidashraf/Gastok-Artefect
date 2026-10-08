# PostgreSQL Fault-Injection and Concurrency Report

**Status:** EXECUTED on real PostgreSQL 18. **Faults: 19/19 passed. Concurrency: 15/15 cells
consistent.** Raw: `results/postgres/raw/pg_faults_*.json`, `pg_concurrency_*.json`.

## Part 1 — Normal operation + fault injection (19/19)

| # | Scenario | Real PostgreSQL behaviour exercised | Result |
|--:|---|---|:--:|
| 1 | Mint event updates balance | transaction commit | PASS |
| 2 | Transfer updates sender+recipient atomically | multi-row transaction | PASS |
| 3 | Duplicate event ignored | `ON CONFLICT DO NOTHING` idempotency | PASS |
| 4 | Checkpoint persists/resumes | durable upsert | PASS |
| 5 | Reconciliation confirms agreement | scan vs authoritative | PASS |
| 6 | Audit log records entries | append | PASS |
| 7 | Mid-transaction failure rolls back | no partial write (ACID atomicity) | PASS |
| 8 | Explicit ROLLBACK discards changes | rollback | PASS |
| 9 | UNIQUE constraint violation raised | error code **23505** | PASS |
| 10 | **Deadlock detected** | error code **40P01** (two txns, opposite lock order) | PASS |
| 11 | **Lock timeout** | error code **55P03** (`SET lock_timeout`) | PASS |
| 12 | 50 concurrent credits to one holding | `SELECT ... FOR UPDATE` serialises correctly | PASS |
| 13 | Crash-after-commit retry | idempotency prevents double-apply | PASS |
| 14 | **Connection-pool exhaustion** | pool `max=2`, third acquire times out | PASS |
| 15 | Connection to unavailable server | clean failure | PASS |
| 16 | **REAL server stop/start** | `pg.stop()`/`pg.start()`; state durable; resume (755 ms) | PASS |
| 17 | Dead-letter then manual replay | DLQ + idempotent replay | PASS |
| 18 | Reconciliation detects + repairs corruption | detect 1, repair 1, residual 0 | PASS |
| 19 | 3 concurrent listeners, one event | applied exactly once | PASS |

Key point: scenarios 9–16 exercise behaviours the SQLite prototype **could not** — real deadlock
detection, lock timeouts, pool exhaustion, and a genuine database-server stop/start (not a
close/reopen of an embedded file).

## Part 2 — Concurrency and isolation matrix (all consistent)

Workers 1–25 concurrently credit the **same** holding (maximum row contention), across three
isolation levels; each cell repeated. Final balance equalled the expected total in **every cell**
(0 terminal failures).

| Isolation | W=1 | W=2 | W=5 | W=10 | W=25 |
|---|--:|--:|--:|--:|--:|
| READ COMMITTED — throughput (ev/s) | 990 | 597 | 848 | 1105 | 1260 |
| READ COMMITTED — serialization retries | 0 | 0 | 0 | 0 | 0 |
| REPEATABLE READ — throughput | 1381 | 709 | 443 | 432 | 474 |
| REPEATABLE READ — serialization retries | 0 | 0 | 6.5 | 27.5 | 146 |
| SERIALIZABLE — throughput | 1484 | 684 | 386 | 375 | 436 |
| SERIALIZABLE — serialization retries | 0 | 0 | 7 | 31 | 167.5 |

**Finding.** Under `READ COMMITTED` with explicit `SELECT ... FOR UPDATE`, concurrent credits are
serialised by row locks with **zero** serialization retries and the highest throughput, always
consistent. Under `REPEATABLE READ`/`SERIALIZABLE`, PostgreSQL raises serialization failures
(`40001`) that grow with contention (up to ~167 retries at 25 workers); the retry-with-backoff
logic absorbs them and consistency is preserved, at a throughput cost. **The appropriate
production choice for this workload is `READ COMMITTED` with row-level locking**, because the
correctness-critical section is a single-row balance update already protected by `FOR UPDATE`.

## Metrics (aggregate)
- Processing success rate: 100% (19/19 fault scenarios).
- Consistency rate: 100% (15/15 concurrency cells; 0 terminal failures, 0 data loss).
- Deadlocks and serialization failures: detected and either resolved by PostgreSQL (deadlock
  victim) or retried to success (serialization).
- Real server restart recovery: 755 ms (single observation; environment-specific).

## Honest limitations
- Single-node PostgreSQL; no replication/HA. Recovery time is local and environment-specific.
- Blockchain events are synthetic fixtures (the workload) so contention can be controlled; this
  is a DATABASE-layer evaluation, complementary to the chain-driven SQLite Experiment 12.
- The server-restart recovery time is a single observation, not a distribution.

## Addendum — cold backup-and-restore (scenario 48)

**Status:** EXECUTED. Script: `scripts/experiments/exp_pg_backup_restore.mjs`. Raw:
`results/postgres/raw/pg_backup_restore_*.json`.

A known state (balance 50 across 5 events) was applied, the server stopped, a filesystem cold
backup of the data directory taken, the data directory deleted to simulate loss, restored from the
backup, and the server restarted. Result: **PASS** — `beforeBackup=50, afterRestore=50`, recovery
5,059 ms; re-applying an already-processed event after restore was correctly detected as a
duplicate (idempotency held), so the balance stayed 50. This demonstrates durable
backup-and-restore of the synchronisation state on real PostgreSQL. (A production deployment would
use `pg_basebackup` + WAL archiving for online backup; the cold filesystem backup tested here is
the offline equivalent.)

## Addendum — historical on-chain evidence re-verified

`scripts/analysis/verify_historical.mjs` re-queried the public RPCs on 2026-07-15 and confirmed the
original 2026-06-21 evidence transactions are still on-chain with matching status, block, and gas:
Amoy deploy (block 40,537,293, gas 1,712,159), Amoy mint (block 40,537,303, gas 101,258), Sepolia
deploy (block 11,108,169, gas 1,703,759), Sepolia mint (block 11,108,173, gas 81,098). The
cross-network gas-schedule difference is therefore independently re-verifiable at any time.
