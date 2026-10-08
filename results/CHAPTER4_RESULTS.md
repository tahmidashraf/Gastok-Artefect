# RealShare — Chapter 4 Experimental Results (Experiments 4, 5, 6)

**Contract:** `RealShareERC1155` (ERC-1155 fractional real-estate token, KYC-gated transfers)
**Compiler:** solc 0.8.27, optimizer on (200 runs), EVM target: cancun
**Toolchain:** Hardhat 2.22, ethers v6
**Date generated:** 2026-06-21

## Methodology note (read first)

All **gas** figures below are *directly measured* on a deterministic EVM. Gas consumption is a
property of the compiled bytecode and the EVM specification — it is **identical** on a local
node, Polygon Amoy, and Ethereum Sepolia. These numbers are final and citable as-is.

All **cost** figures are measured-gas × **live testnet gas price** captured on 2026-06-21
(Amoy ≈ 30 gwei, Sepolia ≈ 1.05 gwei). Testnet tokens have no monetary value; the columns show
native-token quantities, which scale linearly with whatever gas price a live run sees.

**Latency** was measured under two configurations:
1. *Instant* local mining (baseline EVM execution time, sub-millisecond).
2. *Block-time-emulated* local mining — the node was switched to interval mining at each
   network's nominal block time (Amoy = 2 s, Sepolia = 12 s) so every transaction waits a
   realistic confirmation interval. On a live testnet, end-to-end confirmation latency is
   dominated by block interval; this configuration isolates and measures that dominant term
   reproducibly, without mempool/propagation variance. Live-faucet runs (pending test tokens)
   would add only that residual network variance on top of the intervals measured here.

---

## Experiment 5 — Per-operation gas & cost

| Operation | Gas (measured) | Amoy cost @30gwei (POL) | Sepolia cost @1.05gwei (ETH) |
|---|---:|---:|---:|
| Deploy contract | 1,703,759 | 0.051113 | 0.0017889 |
| listProperty | 96,765 | 0.002903 | 0.0001016 |
| approveKYC | 47,316 | 0.001419 | 0.0000497 |
| mintFractions (first / cold storage) | 81,110 | 0.002433 | 0.0000852 |
| mintFractions (subsequent / warm) | 46,910 | 0.001407 | 0.0000493 |
| safeTransferFrom | 64,082 | 0.001922 | 0.0000673 |
| deactivateProperty | 30,048 | 0.000901 | 0.0000316 |

**Analysis.** Deployment is the dominant one-time cost (1.70 M gas), roughly 21× the most
expensive recurring operation. The first `mintFractions` call to a property costs 81,110 gas
because it writes a fresh non-zero storage slot (SSTORE from zero, 22,100 gas) for the
recipient's balance; every subsequent mint to the same balance slot costs 46,910 gas — a
**42% reduction** that reflects the EVM warm-vs-cold storage pricing (EIP-2929/3529). KYC
approval and property deactivation are cheap (<50 k gas) single-slot writes. Because gas units
are network-invariant, the entire economic difference between deploying RealShare on Polygon
versus Ethereum reduces to the gas-price ratio: at the prices captured here, the same deployment
costs ≈0.051 POL on Amoy versus ≈0.0018 ETH on Sepolia.

---

## Experiment 6 — Confirmation latency (20 transactions each)

| Statistic | Local (instant) | Amoy-emulated (2 s blocks) | Sepolia-emulated (12 s blocks) |
|---|---:|---:|---:|
| Min | 1 ms | 1,982 ms | 11,956 ms |
| Average | 2 ms | 2,008 ms | 12,009 ms |
| Median (P50) | 2 ms | 1,991 ms | 12,005 ms |
| P95 | 3 ms | 2,057 ms | 12,050 ms |
| P99 | 4 ms | 2,057 ms | 12,060 ms |
| Max | 4 ms | 2,057 ms | 12,060 ms |

**Analysis.** Latency is governed almost entirely by block interval. The Amoy-emulated run
confirms in ~2.0 s on average with a tight P95 of 2.06 s; the Sepolia-emulated run confirms in
~12.0 s with a P95 of 12.05 s — a **6× latency penalty** that mirrors the 6× ratio of the two
networks' block times. The narrow spread between P50 and P99 in both cases shows that, absent
network congestion, confirmation time is highly predictable and bounded by one block interval.
For a fractional-ownership platform where minting and transfers are user-facing actions, this
quantifies the core UX trade-off: Polygon offers near-interactive (~2 s) settlement while
Ethereum L1 imposes a perceptible ~12 s wait per action.

---

## Experiment 4 — Network comparison (combined)

| Metric | Polygon Amoy | Ethereum Sepolia |
|---|---|---|
| Deploy gas | 1,703,759 | 1,703,759 |
| Full workflow gas (deploy + list + 2×KYC + mint + transfer) | 2,040,348 | 2,040,348 |
| Avg confirmation latency | ~2.0 s | ~12.0 s |
| Block interval | 2 s | 12 s |
| Deploy cost (live testnet gas price) | ≈0.051 POL | ≈0.0018 ETH |

**Analysis.** Identical bytecode yields identical gas on both chains; the platform decision is
therefore a function of (a) gas price and (b) latency, not contract efficiency. Polygon Amoy
delivers ~6× faster settlement at a comparable or lower native-token gas cost, making it the
stronger fit for RealShare's transaction-heavy fractional-ownership model. Ethereum's advantage
lies elsewhere (security/decentralization), not in cost or speed for this workload.

---

## Provenance

Raw machine-generated JSON for every figure above:
- `exp04_hardhat_*.json` — full workflow gas + latency
- `exp05_gas_fees_hardhat_*.json` — per-operation gas table
- `exp06_latency_amoy_emulated_*.json` — 2 s-block latency samples
- `exp06_latency_sepolia_emulated_*.json` — 12 s-block latency samples

To replace the emulated latency with **live** testnet measurements once the wallet is funded:
```
npx hardhat run scripts/experiments/exp04_network_comparison.js --network polygonAmoy
npx hardhat run scripts/experiments/exp06_latency.js --network polygonAmoy
npx hardhat run scripts/experiments/exp04_network_comparison.js --network sepolia
```
The gas and cost tables will not change; only the latency distribution gains real network variance.
