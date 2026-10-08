# Secondary-Transfer Benchmark Report (Benchmark D)

**Status:** EXECUTED. Raw: `results/token-benchmarks/raw/multi_investor_*.json` (section D).
**Script:** `scripts/experiments/exp_multi_investor_bench.js` (Benchmark D).
Environment as in the multi-investor report; transfers executed by real signers that own the
balances (so `msg.sender` authorisation is genuine).

## Results

| Transfer pattern | Standard | Total gas | Per recipient / sender |
|---|---|--:|--:|
| One-to-one (1 unit) | ERC-1155 | 57,079 | 57,079 |
| Batch two ids (5+5) | ERC-1155 `safeBatchTransferFrom` | 71,868 | 35,934 / id |
| One-to-many (10 recipients, 1 each) | ERC-1155 | 570,910 | 57,091 |
| One-to-many (10 recipients, 1 each) | ERC-20 | 515,310 | 51,531 |
| Many-to-one (5 senders → 1 collector) | ERC-1155 | 217,055 | 43,411 |

## Key findings

1. **Batch transfer amortises the per-transaction base cost, not the per-recipient balance
   writes.** Two ids in one `safeBatchTransferFrom` cost 71,868 gas versus 2 × 57,079 = 114,158
   for two separate one-to-one transfers — a **37% saving**, entirely from paying the 21,000-gas
   transaction base and calldata overhead once. Distributing to distinct recipients cannot be
   batched into one balance-write, so one-to-many still pays per recipient.
2. **ERC-20 one-to-many is marginally cheaper per recipient than ERC-1155** (51,531 vs 57,091),
   consistent with Benchmark B: a fungible balance write is slightly cheaper than an ERC-1155
   `(id, address)` write.
3. **Many-to-one consolidation** is the cheapest per-participant transfer pattern (43,411/sender)
   because each sender's balance decreases toward zero (a storage refund partially offsets the
   collector's single growing balance).

## Interpretation for the platform

Secondary-market activity in RealShare is dominated by one-to-one and small one-to-many transfers,
each ≈ 57k gas on the Ethereum schedule (sub-cent on Polygon at the measured gas price). The
`safeBatchTransferFrom` path is worth using whenever a single holder moves multiple property ids
at once. No transfer pattern collapses per-recipient cost, which is an honest limit on
distribution economics and is stated as such.

## Limitations

- Small recipient counts (≤10) to keep patterns interpretable; larger fan-out scales linearly.
- Local Ethereum gas schedule; Polygon absolute values differ per the cross-network analysis.
- Storage-refund behaviour (EIP-3529 caps) is reflected in the measured many-to-one figure and is
  network-parameter-dependent.
