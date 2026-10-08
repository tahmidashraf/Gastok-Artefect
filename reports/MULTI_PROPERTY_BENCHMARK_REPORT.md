# Multi-Property Benchmark Report (Benchmark C)

**Status:** EXECUTED. Raw: `results/token-benchmarks/raw/multi_investor_*.json` (section C);
processed: `results/token-benchmarks/processed/benchmarkC_multi_property.csv`.
**Script:** `scripts/experiments/exp_multi_investor_bench.js` (Benchmark C).
Environment as in the multi-investor report.

## Purpose

Measure the architectural cost of representing a *catalogue of P properties*, each distributed to
a fixed set of 10 investors, under three architectures:
- **ERC-1155:** one contract, one token id per property (deploy once, mint per id);
- **ERC-20-per-property:** one deployed ERC-20 contract per property (via a factory);
- **ERC-721:** one contract, each fraction a distinct token id.

## Results (P properties × 10 investors each, total gas incl. deployment)

| Properties | ERC-1155 (1 contract) | ERC-20 (P contracts) | ERC-721 (1 contract) |
|--:|--:|--:|--:|
| 1  | 1,667,644  | 1,969,209 (1)   | 1,708,507  |
| 10 | 4,512,544  | 10,737,324 (10) | 4,737,997  |
| 25 | 9,254,344  | 25,351,554 (25) | 9,787,447  |
| 50 | 17,157,144 | 49,708,404 (50) | 18,202,997 |

## Key findings

1. **This is where ERC-1155's architecture wins decisively.** For 50 properties, one ERC-1155
   contract costs **17.16M** gas total, versus **49.71M** for 50 separate ERC-20 contracts —
   the ERC-20-per-property model pays a fresh ~1M-gas contract deployment for every property.
   ERC-1155 amortises a single deployment across the whole catalogue.
2. **ERC-1155 and ERC-721 are close on total gas** (17.16M vs 18.20M at P=50) because both use one
   contract; the difference is ERC-721's per-fraction token-id overhead. ERC-1155 remains cheaper
   and, unlike ERC-721, represents a fraction as fungible balance rather than a distinct NFT.
3. **The genuine, defensible justification for ERC-1155 is multi-property management, not
   per-token distribution gas.** A fractional-real-estate platform manages many properties in one
   contract with per-property token ids; the multi-property benchmark quantifies that advantage
   (≈ 2.9× cheaper than ERC-20-per-property at 50 properties), which the single-holder and
   multi-investor benchmarks do not.

## Corrected thesis framing

The ERC-1155 selection rationale in the thesis should rest primarily on **multi-property
capability and catalogue-scale deployment amortisation** (Benchmark C), with single-holder
issuance efficiency (Benchmark A) as a secondary benefit and honest acknowledgement that
per-investor distribution cost (Benchmark B) is comparable across standards.

## Limitations

- 10 investors per property (fixed) to keep the grid tractable; scaling investors-per-property
  scales all three roughly linearly (dominated by per-investor balance writes, see Benchmark B).
- Local Ethereum gas schedule; Polygon PoS repricing raises absolute values.
- ERC-20 factory uses `new BenchERC20(...)`; an alternative minimal-proxy (EIP-1167) factory
  would lower ERC-20-per-property deployment cost and is noted as a fairness caveat — even so, a
  per-property proxy still costs a deployment per property that ERC-1155 avoids entirely.
