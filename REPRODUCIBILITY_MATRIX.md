# Reproducibility Matrix

Every measured result in the thesis maps to a script, a command, and a raw output file.
Repo root: `E:\PHD Application\RealShare\`. Setup: Node 18+, `npm install` (root) and
`cd api && npm install`; `npx hardhat compile`. Python 3.10 for figures/analysis
(`pip install matplotlib numpy`) and Slither (`pip install slither-analyzer`).

| Exp | Thesis § | Source file | Command | Raw output | Figure/Table | Status |
|--|--|--|--|--|--|--|
| 1 | Ch4 Exp 1 | `scripts/experiments/exp_gasbench.js` | `npx hardhat run scripts/experiments/exp_gasbench.js` | `results/gasbench_*.json` | Tab exp1 | REPRODUCIBLE |
| 2,3,9 | Ch4 Exp 2/3/9 | `exp_gasbench.js` | same | `results/gasbench_*.json` | Tab exp2,exp3,exp9 | REPRODUCIBLE |
| 4 | Ch4 Exp 4 | `exp04_network_comparison.js` | `... --network polygonAmoy\|sepolia` (funded) | `results/exp04_*.json`, `onchain_evidence.md` | Tab exp4, gasdiff | REPRODUCIBLE (needs funding to re-run) |
| 5 | Ch4 Exp 5 | `exp05_gas_fees.js` + gasbench | `npx hardhat run ...` | `results/exp05_*.json` | Tab exp5 | REPRODUCIBLE |
| 6 | Ch4 Exp 6 | `exp06_latency.js` | `EXP06_TXNS=20 ... --network X` (funded) | `results/exp06_*LIVE*.json`, `exp06_*sepolia*.json` | Tab exp6 | REPRODUCIBLE (single verified session) |
| 7 | Ch4 Exp 7 | `exp_local_evm_throughput.js` | `TPS_REPS=5 npx hardhat run scripts/experiments/exp_local_evm_throughput.js` | `results/token-benchmarks/raw/local_evm_throughput_*.json` | Tab exp7, figX_local_evm_throughput | **REPRODUCIBLE (new)** |
| 8 | Ch4 Exp 8 | `exp08_scalability.js` | `npx hardhat run scripts/experiments/exp08_scalability.js` | `results/exp08_*.json` | Tab exp8 | REPRODUCIBLE |
| 10,15 | Ch4 Exp 10/15 | `api/exp14_security_test.js`, `api/exp_api_security_expanded.js` | `cd api && node exp_api_security_expanded.js` | `api/results/api_security_expanded_*.json` | Tab exp14 | **REPRODUCIBLE (new: 31/31)** |
| 11 | Ch4 Exp 11 | `scripts/experiments/exp_multi_investor_bench.js` | `BENCH_REPS=10 npx hardhat run scripts/experiments/exp_multi_investor_bench.js` | `results/token-benchmarks/raw/multi_investor_*.json` | Tab exp11b/c, figA/B/C | **REPRODUCIBLE (new)** |
| 12 | Ch4 Exp 12 | `scripts/experiments/exp_db_fault_injection.js`, `db/persistent-db.js`, `src/sync-service.js` | `npx hardhat run scripts/experiments/exp_db_fault_injection.js` | `results/database-faults/raw/faults_*.json` | Tab exp12, figX_db_recovery_times | **REPRODUCIBLE (new)** |
| 13 | Ch4 Exp 13 | `test/security/adversarial.test.js`, `test/security/fuzz_invariant.test.js`, `contracts/attacks/MaliciousReceiver1155.sol` | `npx hardhat test test/security/adversarial.test.js test/security/fuzz_invariant.test.js` | `results/security/raw/adversarial_*.json`, `fuzz_invariant_*.json` | Ch4 Exp 13 text | **REPRODUCIBLE (new)** |
| 14 | Ch4 Exp 14 | Slither/solhint | `slither contracts/RealShareERC1155.sol --solc-remaps @openzeppelin=node_modules/@openzeppelin`; `npx solhint contracts/**/*.sol` | `results/security/raw/slither_*.json`, `solhint.txt` | Ch4 Exp 14 text | **REPRODUCIBLE (new)** |
| A1 | Ch4 A1 | analytical | n/a | thesis Tab exp19 | Tab exp19 | ANALYTICAL |
| — (blocked) | Ch4 §Exp 6 future | `scripts/experiments/exp_live_sessions.js` | `SESSION_TAG=s1 npx hardhat run ... --network polygonAmoy` (funded) | `results/live-network/<net>/session_*.json` | — | NOT EXECUTED — EVIDENCE REQUIRED (needs faucet funding) |

## Environment captured in each raw file
solc 0.8.27 (optimizer 200, cancun); OpenZeppelin 5.6.1; Hardhat 2.28.6; ethers 6.17.0;
Node 18.14.0; Windows 11 x64; Intel i7-1165G7 (8 logical cores, 16.9 GB). Slither 0.11.5;
solhint 6.2.3; fast-check 4.x; sql.js (WASM SQLite).

## Tooling substitutions (documented, not hidden)
- **PostgreSQL → file-backed SQLite (WASM, sql.js):** no PostgreSQL server / native build
  toolchain available; schema is Postgres-portable, semantics engine-independent.
- **Foundry → fast-check:** Foundry not installed; property-based fuzzing drives the compiled
  contract through its ABI (12,400 executed cases).
- **Mythril:** not run (requires a container runtime that was unavailable). Slither + solhint +
  npm audit used instead.

## Secrets policy
No private keys, RPC secrets, or database passwords are committed. Live-network scripts read a
testnet key from a local `.env` (see `.env.example`) and refuse to run on a zero-balance wallet.

## Added in the PostgreSQL + multi-session upgrade (2026-07-15)

| Exp | Thesis § | Source file | Command | Raw output | Status |
|--|--|--|--|--|--|
| 16 | Ch4 Exp 16 | `db/pg/pg-store.mjs`, `scripts/experiments/exp_pg_faults.mjs` | `node scripts/experiments/exp_pg_faults.mjs` | `results/postgres/raw/pg_faults_*.json` | **REPRODUCIBLE (real PostgreSQL 18)** |
| 17 | Ch4 Exp 17 | `scripts/experiments/exp_pg_concurrency.mjs` | `PG_CONC_REPS=2 node scripts/experiments/exp_pg_concurrency.mjs` | `results/postgres/raw/pg_concurrency_*.json` | **REPRODUCIBLE (real PostgreSQL 18)** |
| Live s2/s3 | Ch4 Exp 6 | `scripts/experiments/exp_live_session_lite.js`, `scripts/analysis/verify_and_analyse_live.mjs` | `SESSION_TAG=s2 npx hardhat run ... --network sepolia` (funded) | `results/live-network/sepolia/session_*.json`, `LIVE_TRANSACTION_INDEX.csv` | **EXECUTED (3 Sepolia sessions verified on-chain)** |
| Live Amoy (repeat) | Ch4 Exp 6 | same | same `--network polygonAmoy` (funded) | — | NOT EXECUTED — EVIDENCE REQUIRED (residual POL insufficient at 35 gwei) |

PostgreSQL engine: PostgreSQL 18.4 via `embedded-postgres` (real binary, no Docker). Production
deployment: `docker-compose.yml` + `database/migrations/001_init.sql` + `POSTGRESQL_SETUP.md`.
