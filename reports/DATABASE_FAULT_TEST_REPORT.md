# Database Fault-Injection Test Report

**Status:** EXECUTED. **Result: 24/24 scenarios passed.**
**Raw evidence:** `results/database-faults/raw/faults_*.json`.
**Driver:** `scripts/experiments/exp_db_fault_injection.js` (against the real `RealShareERC1155`
on a local Hardhat EVM + the persistent sql.js database).

This is **prototype technical interoperability and consistency validation** — not complete legal
interoperability. The 24 scenarios cover the 30 fault conditions listed in the upgrade brief;
conditions that form two halves of one flow (miss-blocks + replay-recovers; detect + repair) are
exercised within a single scenario, and several near-duplicate conditions are consolidated.

## Aggregate metrics (computed from raw output)

| Metric | Value |
|---|---|
| Scenarios | 24 |
| Passed / Failed | 24 / 0 |
| Event-processing success rate | 100% |
| Duplicate-prevention rate | 100% |
| Recovery success rate | 100% |
| Reconciliation success rate | 100% |
| Inconsistency detection rate | 100% |
| Mean recovery time | 45.9 ms |
| P95 recovery time | 179 ms |
| Total data loss | 0 |
| Unresolved errors | 1 (the dead-letter scenario, by design — permanent failure is *meant* to remain in the DLQ for manual intervention) |

## Scenario outcomes

| # | Scenario | Fault | Result |
|--:|---|---|:--:|
| 1 | Normal sync | none | PASS |
| 2 | Chain tx + DB update both succeed | none | PASS |
| 3 | Chain succeeds, DB unavailable, then recovers | DB write throws | PASS |
| 4 | DB available after temporary failure | transient DB error | PASS |
| 5 | Failed event retried successfully | single apply failure | PASS |
| 6 | Duplicate event re-delivered | same tx/log re-ingested | PASS |
| 7 | Same event replayed 5× | 5 replays | PASS |
| 8 | Listener misses blocks; replay recovers | checkpoint advanced past events | PASS |
| 9 | Out-of-order event delivery | canonical-order processing | PASS |
| 10 | Recovery after API server restart | restart mid-op | PASS |
| 11 | Recovery after event-listener restart | restart mid-op | PASS |
| 12 | Recovery after DB server restart | close+reopen from file | PASS |
| 13 | RPC provider unavailable, then recovery | provider throws | PASS |
| 14 | Network timeout, then recovery | provider delay | PASS |
| 15 | Tx submitted but reverts | non-KYC recipient | PASS |
| 16 | Pending tx withheld until confirmation depth | shallow event | PASS |
| 17 | Chain reorg reverses affected DB rows | snapshot/revert reorg | PASS |
| 18 | Confirmation depth prevents premature finalisation | 1-conf event | PASS |
| 19 | Conflicting/stale/corrupted balance detected + repaired | manual corruption | PASS |
| 20 | Permanent failure → dead-letter queue | apply always throws | PASS |
| 21 | Multiple listeners receive same event | overlapping ranges | PASS |
| 22 | Concurrent updates to same holding | mint+transfer | PASS |
| 23 | Transaction ordering stable under reprocessing | replay | PASS |
| 24 | Audit history complete and durable after restart | restart | PASS |

## Emulation honesty

- **Chain reorg** (17) is emulated with Hardhat `evm_snapshot`/`evm_revert`: a snapshot is taken,
  the mint block is created and processed into the DB, then the snapshot is reverted (removing the
  block) and a different chain is mined; `handleReorg()` detects the block-hash mismatch and
  reverses the DB effect. This is a faithful emulation of a reorg's *effect on the indexer*, not a
  live network reorg.
- **DB server restart** (12, 24) is emulated by closing the SQLite handle and reopening from the
  durable file — the durability property being tested (checkpoint + applied state survive) holds.
- **RPC outage / timeout** (13, 14) are emulated with a provider wrapper that throws / delays.
- The one unresolved error (20) is the intended dead-letter outcome, not a defect.

## Corrected thesis claim

Replace the old "100% on-/off-chain synchronisation across 19 endpoints" (which had no
implementation) with: *"A prototype event-driven synchronisation layer with confirmation-depth
finalisation, idempotent processing, checkpoint/replay recovery, reorg reversal, reconciliation,
and a dead-letter queue passed 24/24 fault-injection scenarios with 100% event-processing,
recovery, and reconciliation success and zero data loss under the documented (emulated-fault)
configuration."*
