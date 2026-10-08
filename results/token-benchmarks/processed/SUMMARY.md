# Token-Standard Benchmark — Processed Summary

Source raw file: `multi_investor_1784051463356.json`

Environment: solc 0.8.27 (optimizer 200 runs, evmVersion cancun); OZ 5.6.1; Hardhat 2.28.6; ethers 6.17.0; Node v18.14.0; Windows_NT 10.0.26200 x64; 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz (8 cores, 16.9 GB); block gas limit 60000000; reps 10.

## Determinism check

- erc1155_mintSingle_50: gas = 52591, SD = 0, identical across 10 runs = true
- erc1155_mintToMany_10: gas = 316112, SD = 0, identical across 10 runs = true
- erc721_mintN_10: gas = 318283, SD = 0, identical across 10 runs = true

## Benchmark A — single-holder issuance (gas per unit is amortised, not a per-write cost)

| Units | ERC-1155 gas | ERC-20 gas | ERC-721 gas | ERC-721 token IDs |
|--:|--:|--:|--:|--:|
| 10 | 52591 | 70608 | 318283 | 10 |
| 50 | 52591 | 70608 | 1318763 | 50 |
| 100 | 52591 | 70608 | 2569363 | 100 |
| 500 | 52603 | 70620 | 12574175 | 500 |

## Benchmark B — multi-investor distribution (1 unit to each of X investors)

| Investors | ERC-1155 gas (tx) | per investor | ERC-20 gas | per inv. | ERC-721 gas | per inv. |
|--:|--:|--:|--:|--:|--:|--:|
| 10 | 316100 (1) | 31610 | 300120 | 30012 | 524722 | 52472 |
| 50 | 1481494 (1) | 29630 | 1314752 | 26295 | 2436874 | 48737 |
| 100 | 2938456 (1) | 29385 | 2583054 | 25831 | 4827076 | 48271 |
| 500 | 14692316 (5) | 29385 | 12846906 | 25694 | 24067016 | 48134 |

## Benchmark C — multiple properties (ERC-1155 one contract vs ERC-20 one-contract-per-property)

| Properties | ERC-1155 gas (1 contract) | ERC-20 gas (N contracts) | ERC-721 gas (1 contract) |
|--:|--:|--:|--:|
| 1 | 1667644 | 1969209 (1) | 1708507 |
| 10 | 4512544 | 10737324 (10) | 4737997 |
| 25 | 9254344 | 25351554 (25) | 9787447 |
| 50 | 17157144 | 49708404 (50) | 18202997 |

## Benchmark D — secondary transfers

- ERC-1155 one-to-one transfer: 57079 gas; two-id batch: 71868 gas.
- One-to-many (10 recipients): ERC-1155 570910 (57091/recipient); ERC-20 515310 (51531/recipient).
- Many-to-one (5 senders): ERC-1155 217055 (43411/sender).
