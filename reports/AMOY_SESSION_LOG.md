# Polygon Amoy Session Log

**Status:** ONE verified session (2026-06-21, n=18). A second session on 2026-07-15 was attempted
but **NOT EXECUTED — EVIDENCE REQUIRED**: at the observed gas price (~35 gwei) the residual wallet
balance (0.00173 POL) could not afford even a single ~110k-gas operation
(110{,}000 × 35 gwei ≈ 0.00385 POL > 0.00173 POL), so the budget guard correctly refused every
operation and recorded zero confirmed transactions (`results/live-network/polygonAmoy/session_s2_*.json`).

No Amoy latency values were invented. Reaching multiple Amoy sessions requires faucet-funded POL,
which is human-gated.

## Verified session (2026-06-21)
- Contract deployed `0x40aBAe00C9308159e66Bf86fCF6E33df175732AE`, tx
  `0x81f7bbf5789f9fe3afb3fa15246c5403e6a527db67d69bec104875c3b614d228`, block 40,537,293.
- Latency n=18: mean 3,415 ms, P95 4,966 ms (of 20 planned; 18 funded).
- Full hashes in `3_OnChain_Evidence/onchain_evidence.md` and `results/exp04_polygonAmoy_*.json`,
  `exp06_latency_polygonAmoy_LIVE_*.json`.

## To complete (candidate action)
Fund the wallet via a Polygon Amoy faucet, then:
`SESSION_TAG=s2 npx hardhat run scripts/experiments/exp_live_session_lite.js --network polygonAmoy`
(repeat s3..s5 on different dates/times), then re-run `verify_and_analyse_live.mjs`.
