# SQLite vs PostgreSQL Comparison

Both implementations are real and executed. The SQLite prototype (Experiment 12) validated the
synchronisation and recovery *logic* under controlled local conditions; the PostgreSQL
implementation (Experiments 16–17) extends the evaluation to networked, concurrent, and
transaction-isolation conditions. SQLite results are **not** invalidated — they cover a different,
narrower regime.

| Dimension | SQLite (WASM, file-backed) — Exp 12 | PostgreSQL 18 (embedded) — Exp 16–17 |
|---|---|---|
| Engine type | Embedded, single-process, file | Client–server, networked |
| Persistence | File; survives process restart | Durable data dir; survives server stop/start |
| Concurrency model | Single-writer (serialised) | Multi-connection pool; real MVCC |
| Row-level locking | Not applicable (serialised) | `SELECT ... FOR UPDATE` (tested, 50 concurrent credits) |
| Isolation levels | Effectively serialised | READ COMMITTED / REPEATABLE READ / SERIALIZABLE (all tested) |
| Deadlock detection | N/A | Real (`40P01`) — tested |
| Lock timeout | N/A | Real (`55P03`) — tested |
| Serialization failures | N/A | Real (`40001`), retried — tested up to 167 retries |
| Connection pool | N/A | `pg.Pool`; exhaustion tested |
| Server stop/start | Emulated (close/reopen file) | **Real server stop/start** (755 ms recovery) |
| Constraint enforcement | Basic | `UNIQUE`, `CHECK`, FKs (`23505` tested) |
| Fault scenarios | 24 (chain-driven, some emulated) | 19 (real DB faults) + 15 concurrency cells |
| Recovery/consistency | 100% recovery, 0 data loss | 19/19 pass; 15/15 consistent; 0 data loss |
| Deployment complexity | Trivial (in-process) | Requires a server (docker-compose provided) |
| Best role | Fast logic validation; embeddable | Production concurrency, isolation, HA path |

## What each experiment proves
- **SQLite (Exp 12):** the *event-processing and recovery design* is correct end-to-end against
  the real contract — idempotency, confirmation depth, missed-block replay, reorg reversal,
  reconciliation, dead-letter — under controlled local faults.
- **PostgreSQL (Exp 16–17):** that same design holds under *real database concurrency and
  isolation*, with row-level locking and retry-on-serialization maintaining consistency at up to
  25 concurrent workers, and that the engine's own failure modes (deadlock, lock timeout, pool
  exhaustion, server restart) are handled.

## Recommended production configuration
PostgreSQL, `READ COMMITTED` isolation with `SELECT ... FOR UPDATE` on the balance row (0
serialization retries, highest throughput, always consistent in the matrix), a bounded connection
pool sized to the worker count, retry-with-backoff retained as a safety net, and a single-writer
advisory lock only where a cross-row invariant requires it.
