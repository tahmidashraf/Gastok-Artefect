# GasTok — Reproducibility Artefact

Artefact for the paper *"GasTok: EVM Compatibility Does Not Imply Gas Equivalence in
Tokenization Cost Models"* (C. M. T. Ashraf, Universiti Teknologi PETRONAS).

GasTok (gas-instrumented tokenization) is an ERC-1155 fractional real-estate
tokenization service, each property a token ID fractionalised into fungible units,
used as the measurement instrument for the paper. It is evaluated on a local Hardhat
EVM and on the **live Polygon Amoy** and **Ethereum Sepolia** public testnets. The
contract keeps its original identifier, `RealShareERC1155`, which is the name deployed
on chain.

**Archived snapshot.** The paper cites `artefact.zip`: 182 files, 878,194 bytes,
SHA-256 `83c6e1c82db8a63ebacbd20b23d1aa3d23aedc8db7cf2ec89def37f8b3dbe514`. This
repository holds the same files, and the identical zip is attached to the GitHub release
and deposited on Zenodo. One file was added afterwards and is not in the zip:
`results/probes/m4_creation_gas_2026-10-08.json` (see *Gas-schedule probe suite* below).

## On-chain deployment (independently verifiable)

| Network | Contract address | Deploy tx |
|---|---|---|
| Polygon Amoy | `0x40aBAe00C9308159e66Bf86fCF6E33df175732AE` | [`0x81f7bbf5…3b614d228`](https://amoy.polygonscan.com/tx/0x81f7bbf5789f9fe3afb3fa15246c5403e6a527db67d69bec104875c3b614d228) |
| Ethereum Sepolia | `0x40aBAe00C9308159e66Bf86fCF6E33df175732AE` | [`0x4123ee6b…db32008e`](https://sepolia.etherscan.io/tx/0x4123ee6bf7cc7ac56421cb5c97fb201c53589aa828a0fd3c4ed51a56db32008e) |

The full per-transaction hash list is in
[`results/live-network/LIVE_TRANSACTION_INDEX.csv`](results/live-network/LIVE_TRANSACTION_INDEX.csv).

## Layout

```
contracts/
  RealShareERC1155.sol         # contract under test
  baselines/RealShareERC721.sol, RealShareERC20.sol   # token-standard comparison baselines
scripts/experiments/
  exp04_network_comparison.js  # live deploy + workflow (gas + latency) per network
  exp05_gas_fees.js            # per-operation gas
  exp06_latency.js             # confirmation-latency sampling (EXP06_TXNS sets N)
  exp08_scalability.js         # concurrent-mint stress test (SCAL_LEVELS)
  exp_gasbench.js              # full local gas benchmark (workflow, scaling, ERC comparison, TPS, batch)
api/                           # REST API + Experiment 14 security suite (node exp14_security_test.js)
results/                       # machine-generated JSON results
```

## Quick start

```bash
npm install
npx hardhat compile                       # solc 0.8.27, EVM cancun
npx hardhat run scripts/experiments/exp_gasbench.js        # local gas benchmark

# Live runs require a funded test wallet: create .env with PRIVATE_KEY=<testnet key>
# (optional: POLYGON_AMOY_RPC_URL, SEPOLIA_RPC_URL)
EXP06_TXNS=100 npx hardhat run scripts/experiments/exp06_latency.js --network polygonAmoy
npx hardhat run scripts/experiments/exp04_network_comparison.js --network sepolia
```

Network names (`hardhat.config.js`): `polygonAmoy` (chainId 80002), `sepolia` (chainId 11155111).

## Security note

Never commit `.env` or any private key. The throwaway test wallet used for the testnet
runs holds only valueless testnet tokens; `.gitignore` excludes secrets.

## License

MIT — see [LICENSE](LICENSE).


## Gas-schedule probe suite

The probes behind Section V of the paper. Each recovers exact gas by bisecting the
`eth_call` gas cap, so none needs a funded account or a deployment, and any of them
can be re-run against any EVM endpoint.

```
scripts/probes/
  m1.mjs               reset probe: constructor (dirty-slot) and state-override
                       (true warm reset) variants, swept over n = 1..16
  m2.mjs               the reset probe across the fourteen surveyed networks
  m3.mjs               activation-block bisection for the Polygon repricing
  m4_creation_gas.js   creation gas of the neutral benchmark contracts
  nets.json            the fourteen endpoints used for the survey
results/probes/        raw logs and JSON for each of the above
```

Run them with Node 18 or newer, for example:

```
node scripts/probes/m1.mjs '[{"name":"Polygon Amoy","url":"https://polygon-amoy-bor-rpc.publicnode.com"}]' 1,2,4,8,16
node scripts/probes/m2.mjs scripts/probes/nets.json
node scripts/probes/m3.mjs https://polygon.drpc.org
```

Public endpoints rate-limit, so `m2.mjs` runs the networks concurrently and retries.
`m3.mjs` needs an archive endpoint; a node that prunes state reports the failure and
the depth it reached rather than estimating.

`m4_creation_gas.js` reads compiled artifacts, so run `npx hardhat compile` first and set
`ROOT` at the top of the script to your checkout. Its output was not in the sealed zip,
so it was recorded on 2026-10-08 in `results/probes/m4_creation_gas_2026-10-08.json`:
Polygon Amoy (block 49,606,569) gives 1,358,276 / 977,874 / 704,574 gas for the neutral
ERC-1155, the ERC-20 factory and the standalone neutral ERC-20, against 1,351,556 /
977,874 / 694,494 under the Ethereum schedule. The differences, 6,720 / 0 / 10,080, are
8, 0 and 12 cold `SSTORE`s at 840 gas each. The Ethereum-schedule side was bisected on
the in-process Hardhat EVM, because the public Sepolia endpoint in the script does not
enforce the `eth_call` gas cap (see `scripts/experiments/exp_gas_fingerprint_exact2.mjs`).

## Citation

If you use this artefact, please cite the paper and the archived snapshot:
Zenodo DOI to be added on publication.
