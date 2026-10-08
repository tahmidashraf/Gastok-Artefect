# Repeated Live-Network Session Report (Stage 7)

## Status: NOT EXECUTED — EVIDENCE REQUIRED (partial prior evidence exists)

Repeated multi-session live measurements require a **faucet-funded testnet wallet** (POL on
Polygon Amoy, ETH on Ethereum Sepolia). Funding a faucet is human-gated and could not be
performed in this environment. Per the integrity rule, the repeated-session experiment is
therefore **not claimed as executed**, and no new latency numbers are invented.

## What already exists (one verified session, 2026-06-21)

The single live session from the original work **is** real and independently verifiable and
remains in the thesis:
- Contract deployed on both testnets at `0x40aBAe00C9308159e66Bf86fCF6E33df175732AE`.
- Amoy latency n=18 (mean 3.42 s, P95 4.97 s); Sepolia n=20 (mean 12.09 s, P95 13.23 s).
- Cross-network gas-schedule difference measured (Polygon cold-storage repricing).
- Full transaction hashes in `3_OnChain_Evidence/onchain_evidence.md` and the exp04/exp06 JSONs.

## What is prepared and ready to run once funded

- `scripts/experiments/exp_live_sessions.js` — runs one timed session (deploy, list, KYC, single
  mint, multi mint), recording submission/hash/inclusion/receipt timestamps, block, gas used,
  effective gas price, fee, confirmation latency, and any nonce/RPC errors, to
  `results/live-network/<network>/session_<tag>_<ts>.json`. It **refuses to run and prints
  "NOT EXECUTED — EVIDENCE REQUIRED"** if the wallet balance is zero.
- `scripts/analysis/verify_transaction_hashes.js` — re-checks every recorded hash against the
  chain and builds `LIVE_TRANSACTION_INDEX_<network>.csv`.

## Procedure for the candidate (to complete this experiment)

1. Put a testnet private key in `.env` (`PRIVATE_KEY=...`); never commit it.
2. Fund the wallet: Polygon Amoy faucet (POL) and Sepolia faucet (ETH).
3. Run ≥5 sessions per network on different dates/times:
   `SESSION_TAG=s1 npx hardhat run scripts/experiments/exp_live_sessions.js --network polygonAmoy`
   (repeat with s2..s5 and `--network sepolia`).
4. Analyse: `node scripts/analysis/analyse_live_results.js` (aggregates per-op mean/median/SD/
   P90/P95 and session-to-session variance), then verify hashes.
5. Update Chapter 4 Experiment 6 with the multi-session distribution, reporting
   *"during the measured sessions…"* — never *"Ethereum always confirms in…"*.

## Honest statement for the thesis

Chapter 4 must continue to say the live latency figures come from a **single measured session**
(n=18 / n=20) and that **repeated multi-session measurement is future work pending wallet
funding**. It must not present the single session as a guaranteed or multi-session result.
