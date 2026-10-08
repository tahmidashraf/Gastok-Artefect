# Ethereum Sepolia Multi-Session Log

**Status:** PARTIALLY EXECUTED. Three sessions across two dates; **all transactions publicly
verifiable** (9/9 new txs verified on-chain, plus the original 20-tx June session).
**Not** the 5+ sessions the brief targets — additional sessions are **NOT EXECUTED — EVIDENCE
REQUIRED** because they need faucet funding, which is human-gated (see `RISK_AND_BLOCKER_REGISTER.md`).
Raw: `results/live-network/sepolia/session_*.json`; index: `results/live-network/LIVE_TRANSACTION_INDEX.csv`;
processed: `results/live-network/processed/session_variability.json`.
Script: `scripts/experiments/exp_live_session_lite.js` (reuses the deployed contract; refuses ops
it cannot afford). Contract: `0x40aBAe00C9308159e66Bf86fCF6E33df175732AE`; wallet
`0x71C59a35b79A18b0A44540501cB900761DC32fD0`.

## Sessions

| Session | Date (UTC) | Ops confirmed | Latency mean (ms) | Median | SD | CV |
|---|---|--:|--:|--:|--:|--:|
| June baseline (Exp 6) | 2026-06-21 | 20 | 12,091 | 11,857 | ~700 | 0.06 |
| s2 (lite) | 2026-07-15 | 6 | 12,483 | 12,283 | 1,061 | 0.085 |
| s3 (lite) | 2026-07-15 | 3 | 15,326 | 11,228 | 7,527 | 0.491 |

**Session-to-session:** the three session means (12,091 / 12,483 / 15,326 ms) confirm that Sepolia
confirmation latency clusters near its ~12 s block interval but varies session to session, and that
individual transactions can spike well above the mean (a 25,883 ms outlier in s3, a genuine
congestion/propagation event). The tight s2 (CV 0.085) versus the wide s3 (CV 0.491) shows the
distribution is right-skewed and session-dependent; a single-session mean understates tail latency.

## Example verified transactions (s2, 2026-07-15)

| Operation | Tx hash | Gas | Latency (ms) |
|---|---|--:|--:|
| listProperty | `0x44565ae98e46a04c5627f125502d92c0ddb3ce602ca6a3afb3a6551c7ac6392d` | 96,585 | 13,410 |
| approveKYC | `0x2b65640407919b12172997c6eb21975f65e2bee588bf4faf727066aa85061d3f` | 47,316 | 11,733 |
| mintFractions | `0x7bb99feeae1d374211e259c44bcb7604d91afd595b57217fa66b0f8eeca1f9c0` | 83,610 | 12,216 |
| safeTransferFrom | `0x5120e47a0a9a57ca38f5c4aa8363e43eba645bcb9bb88fcb5374b2162a2ea763` | 46,982 | 14,238 |

All hashes are on Sepolia and were re-verified against the chain (status + block match) by
`scripts/analysis/verify_and_analyse_live.mjs`. Gas values vary slightly from the June session
(e.g., mint 83,610 vs 81,098) because of warm/cold storage-slot differences in the pre-existing
contract state — an honest, expected effect.

## Honest scope statement for the thesis
"Across the measured Sepolia sessions (2026-06-21 and 2026-07-15), confirmation latency averaged
12.1–15.3 s per session with individual transactions ranging 8.9–25.9 s." Do **not** generalise to
Ethereum mainnet or to permanent behaviour. Reaching five independent sessions per network requires
additional faucet funding and is identified as the remaining live-network work.
