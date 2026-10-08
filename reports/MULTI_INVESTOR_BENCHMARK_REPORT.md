# Multi-Investor Distribution Benchmark Report (Benchmark B)

**Status:** EXECUTED. Raw evidence: `results/token-benchmarks/raw/multi_investor_*.json`;
processed: `results/token-benchmarks/processed/benchmarkB_multi_investor.csv`.
**Script:** `scripts/experiments/exp_multi_investor_bench.js` (Benchmark B).
**Environment:** solc 0.8.27 (optimizer 200, cancun), OpenZeppelin 5.6.1, Hardhat 2.28.6,
ethers 6.17.0, Node 18.14.0, Windows 11 x64, Intel i7-1165G7 (8 logical cores, 16.9 GB),
local Hardhat EVM block gas limit 60,000,000. Determinism verified (gas SD = 0 across 10 reps).

## Purpose

The pre-existing thesis benchmark measured issuance of *quantity to one wallet* and reported
"94 gas per token," which does not represent distributing fractions to many investors. This
experiment measures the semantically correct multi-investor workload: **1 fraction credited to
each of X distinct investor wallets**, under three representations.

## Results (1 unit to each of X investors)

| Investors | ERC-1155 total gas (tx) | gas/investor | ERC-20 total (tx=1) | gas/investor | ERC-721 total | gas/investor |
|--:|--:|--:|--:|--:|--:|--:|
| 10  | 316,100 (1)   | 31,610 | 300,120    | 30,012 | 524,722    | 52,472 |
| 50  | 1,481,494 (1) | 29,630 | 1,314,752  | 26,295 | 2,436,874  | 48,737 |
| 100 | 2,938,456 (1) | 29,385 | 2,583,054  | 25,831 | 4,827,076  | 48,271 |
| 500 | 14,692,316 (5)| 29,385 | 12,846,906 | 25,694 | 24,067,016 | 48,134 |

*(ERC-1155 individual-transaction path, X separate txs, was also measured for X ≤ 100 and is in
the raw JSON; it adds the 21,000-gas base cost per transaction.)*

## Key findings (corrective, honest)

1. **The per-token advantage does not carry over to distribution.** When fractions are
   distributed one-per-investor, gas is dominated by one balance write per recipient, which every
   standard must pay. Per-investor cost is roughly flat in X: ERC-1155 ≈ 29,385, ERC-20 ≈ 25,694,
   ERC-721 ≈ 48,134 gas.
2. **ERC-20 is actually the cheapest per investor** for pure distribution (a single fungible
   balance slot per holder), ~13% below ERC-1155, because ERC-1155 stores balances in a nested
   `(id → address → amount)` mapping with slightly higher per-write overhead.
3. **ERC-721 costs ~1.6× ERC-1155 per investor** because each fraction is a separate token id
   with owner/approval bookkeeping.
4. **Single-transaction distribution has a hard ceiling.** Distributing to 500 investors in one
   transaction exceeds a practical per-transaction gas budget; the workload was chunked into
   5 transactions of 100 recipients. On the local node the block gas limit is 60M; Polygon PoS
   and Ethereum target ~30M, so a production deployment would use **smaller** chunks and more
   transactions. Distribution to a large investor base is therefore a multi-transaction
   operation on any standard.

## Corrected thesis claim

Replace "ERC-1155 falls to 94 gas per token, making distribution to thousands of investors
economical" with: *"ERC-1155's low amortised per-unit cost applies to issuing quantity to a
single holder; distributing fractions to N distinct investors costs approximately one balance
write per investor under every standard (ERC-1155 ≈ 29k, ERC-20 ≈ 26k, ERC-721 ≈ 48k gas per
investor in the measured workload), and large distributions must be split across multiple
transactions."*

## Limitations

- Local EVM (Ethereum gas schedule); Polygon PoS applies its cold-storage repricing, so absolute
  per-investor gas on Polygon is higher (see the cross-network gas analysis).
- Recipient wallets are freshly generated (cold balance slots), which is the realistic
  first-distribution case; repeat credits to a warm slot are cheaper and are covered by
  Benchmark A / Experiment 2.
