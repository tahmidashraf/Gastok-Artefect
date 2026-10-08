# Database Reconciliation and Recovery Report

**Status:** EXECUTED. Evidence: `results/database-faults/raw/faults_*.json` (scenarios 3–5, 8,
10–14, 17, 19, 20, 24) and the `reconciliation_runs` / `audit_log` / `dead_letter_queue` tables
in the durable SQLite files under `db/data/`.
Component: `Reconciler` in `src/sync-service.js`.

## Reconciliation mechanism

`Reconciler.run({repair})` iterates every `token_holdings` row, fetches the authoritative on-chain
balance via `contract.balanceOf(wallet, propertyId)`, and:
- records a `reconciliation_runs` row with `checked`, `mismatches`, `repaired`;
- when `repair` is set, overwrites the off-chain balance with the on-chain value and writes an
  `audit_log` entry (`reconcile_repair`, old→new).

## Executed reconciliation result (scenario 19)

An off-chain balance was deliberately corrupted (set to 999 while the chain held 100):

| Phase | checked | mismatches | repaired | residual |
|---|--:|--:|--:|--:|
| Detect (no repair) | 1 | 1 | 0 | — |
| Repair | 1 | 1 | 1 | — |
| Verify (post-repair) | 1 | 0 | 0 | 0 |

Final off-chain balance = 100 (= on-chain). **Inconsistency detection rate 100%, repair success
100%, residual mismatch 0.**

## Recovery-time summary (across recovery scenarios)

Recovery (re-sync / retry / replay / restart) succeeded in every scenario where it was exercised:

- Recovery success rate: **100%**
- Mean recovery time: **45.9 ms**; P95: **179 ms** (local EVM + embedded DB; absolute times are
  environment-specific and dominated by re-reading the log range and re-applying events).

## Dead-letter and audit durability

- Permanent-failure events (scenario 20) are routed to `dead_letter_queue` after 3 retries and
  require manual intervention; this is the single intentional "unresolved" item and is **not** a
  data-loss event (the chain remains authoritative and the DLQ preserves the event for replay).
- The `audit_log` (scenario 24) survives a DB restart (close+reopen from the durable file),
  confirming audit history completeness after recovery.

## Honest limitations

- Reconciliation compares only balances that already have a `token_holdings` row; a full
  reconciliation would also scan the chain for holdings absent from the DB (a `Transfer`-log
  sweep), noted as a hardening item.
- Recovery times are local-EVM/embedded-DB measurements; a PostgreSQL + live-RPC deployment would
  have different (higher) absolute latencies.
- Reorg handling reverses effects by stored block hash; a production indexer would also track a
  rolling window of recent block hashes to detect deeper reorgs, noted as future work.
