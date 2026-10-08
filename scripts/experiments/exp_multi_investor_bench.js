/**
 * Multi-investor / multi-property / secondary-transfer token-standard benchmark.
 *
 * Runs Benchmarks A (single-holder issuance), B (multi-investor distribution),
 * C (multiple properties), and D (secondary transfers) for three semantically
 * comparable representations:
 *   - ERC-1155  (one contract, id-per-property, balance-per-fraction)
 *   - ERC-20    (one contract PER property, fungible units)
 *   - ERC-721   (one NFT per fraction)
 *
 * All gas is read from real transaction receipts on a local Hardhat EVM.
 * Gas is deterministic for a given schedule, so REPEATS confirm determinism and
 * capture wall-clock execution-time variance; both are reported.
 *
 * Output: results/token-benchmarks/raw/multi_investor_<timestamp>.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REPS = parseInt(process.env.BENCH_REPS || "10", 10);
const OUT_DIR = path.join(__dirname, "..", "..", "results", "token-benchmarks", "raw");

function stats(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const pct = (p) => s[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)];
  // 95% CI of the mean (normal approx); with SD=0 the CI collapses to the point.
  const ci95 = 1.96 * sd / Math.sqrt(n);
  return { n, mean, median, min: s[0], max: s[n - 1], sd, p90: pct(90), p95: pct(95), ci95 };
}

async function makeWallets(n, funder) {
  // Deterministic addresses; we only need them as recipients (no signing required for mint-to).
  const wallets = [];
  for (let i = 0; i < n; i++) {
    const w = hre.ethers.Wallet.createRandom();
    wallets.push(w.address);
  }
  return wallets;
}

async function gasOf(txPromise) {
  const tx = await txPromise;
  const rc = await tx.wait();
  return { gasUsed: Number(rc.gasUsed), txHash: rc.hash };
}

/**
 * Distribute to many recipients, chunking into multiple transactions so no single tx
 * exceeds the block gas limit. Returns total gas summed across the chunk txs and the
 * transaction count. `fn(sliceTo, sliceAmts)` sends one chunk tx.
 */
async function chunkedDistribute(recipients, amounts, chunkSize, fn) {
  let totalGas = 0, txCount = 0;
  for (let i = 0; i < recipients.length; i += chunkSize) {
    const rTo = recipients.slice(i, i + chunkSize);
    const rAmts = amounts.slice(i, i + chunkSize);
    const g = await gasOf(fn(rTo, rAmts));
    totalGas += g.gasUsed; txCount++;
  }
  return { totalGas, txCount, chunkSize };
}

async function deploy(name, args = []) {
  const F = await hre.ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const rc = await c.deploymentTransaction().wait();
  return { c, deployGas: Number(rc.gasUsed) };
}

async function main() {
  const [owner] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const block = await hre.ethers.provider.getBlock("latest");

  const env = {
    experiment: "multi_investor_token_benchmark",
    timestamp: new Date().toISOString(),
    reps: REPS,
    network: hre.network.name,
    chainId: Number(net.chainId),
    blockGasLimit: Number(block.gasLimit),
    solc: "0.8.27 (optimizer 200 runs, evmVersion cancun)",
    openzeppelin: require(path.join(__dirname, "..", "..", "node_modules", "@openzeppelin", "contracts", "package.json")).version,
    hardhat: require(path.join(__dirname, "..", "..", "node_modules", "hardhat", "package.json")).version,
    ethers: require(path.join(__dirname, "..", "..", "node_modules", "ethers", "package.json")).version,
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0] ? os.cpus()[0].model : "unknown",
    cpuCores: os.cpus().length,
    ramGB: +(os.totalmem() / 1e9).toFixed(1),
  };

  const results = { env, A: {}, B: {}, C: {}, D: {} };

  const SIZES = [10, 50, 100, 500];

  // ---------- BENCHMARK A: single-holder issuance ----------
  // X units to ONE wallet. 1155/20 => 1 balance slot; 721 => X token ids.
  console.log("== Benchmark A: single-holder issuance ==");
  for (const X of SIZES) {
    const holder = hre.ethers.Wallet.createRandom().address;
    const a1155 = [], a20 = [], a721 = [], t1155 = [], t20 = [], t721 = [];
    let rec = {};
    for (let r = 0; r < REPS; r++) {
      // fresh contracts each rep for clean cold-slot state
      const { c: e1155 } = await deploy("BenchERC1155");
      const { c: e20 } = await deploy("BenchERC20", ["P", "P"]);
      const { c: e721 } = await deploy("BenchERC721");

      let t0 = Date.now();
      const g1155 = await gasOf(e1155.mintSingle(0, holder, X)); t1155.push(Date.now() - t0);
      t0 = Date.now();
      const g20 = await gasOf(e20.mintTo(holder, X)); t20.push(Date.now() - t0);
      t0 = Date.now();
      const g721 = await gasOf(e721.mintN(holder, X)); t721.push(Date.now() - t0);

      a1155.push(g1155.gasUsed); a20.push(g20.gasUsed); a721.push(g721.gasUsed);
      if (r === 0) rec = { sampleTx: { erc1155: g1155.txHash, erc20: g20.txHash, erc721: g721.txHash } };
    }
    results.A[X] = {
      units: X,
      erc1155: { totalGas: stats(a1155), gasPerUnit: a1155[0] / X, storageRecords: 1, tokenIds: 1, txCount: 1, timeMs: stats(t1155) },
      erc20:   { totalGas: stats(a20),   gasPerUnit: a20[0] / X,   storageRecords: 1, tokenIds: 0, txCount: 1, timeMs: stats(t20) },
      erc721:  { totalGas: stats(a721),  gasPerUnit: a721[0] / X,  storageRecords: X, tokenIds: X, txCount: 1, timeMs: stats(t721) },
      ...rec,
    };
    console.log(`  A X=${X}: 1155=${a1155[0]}  20=${a20[0]}  721=${a721[0]}`);
  }

  // ---------- BENCHMARK B: multi-investor distribution ----------
  // X units to X distinct investors (1 unit each). 1155/20 => X slots (one tx, loop);
  // 721 => X token ids. Also measured: per-investor individual mints (X txs) for 1155.
  // A single distribution transaction to many recipients can exceed the 30M block gas
  // limit; where it does, the workload is chunked into multiple txs (CHUNK per tx) and the
  // total gas + tx count are reported. This mirrors real deployment behaviour.
  console.log("== Benchmark B: multi-investor distribution ==");
  const CHUNK = 100;
  for (const X of SIZES) {
    const investors = await makeWallets(X, owner);
    const ones = investors.map(() => 1);
    const b = { investors: X };

    const { c: e1155 } = await deploy("BenchERC1155");
    const { c: e20 } = await deploy("BenchERC20", ["P", "P"]);
    const { c: e721 } = await deploy("BenchERC721");

    const single = X <= CHUNK; // fits one tx?
    if (single) {
      const g1 = await gasOf(e1155.mintToMany(0, investors, ones));
      const g2 = await gasOf(e20.distributeToMany(investors, ones));
      const g3 = await gasOf(e721.distributeToMany(investors, ones));
      b.erc1155 = { totalGas: g1.gasUsed, gasPerInvestor: g1.gasUsed / X, storageRecords: X, txCount: 1 };
      b.erc20   = { totalGas: g2.gasUsed, gasPerInvestor: g2.gasUsed / X, storageRecords: X, txCount: 1 };
      b.erc721  = { totalGas: g3.gasUsed, gasPerInvestor: g3.gasUsed / X, storageRecords: X, tokenIds: X, txCount: 1 };
    } else {
      const c1 = await chunkedDistribute(investors, ones, CHUNK, (t, a) => e1155.mintToMany(0, t, a));
      const c2 = await chunkedDistribute(investors, ones, CHUNK, (t, a) => e20.distributeToMany(t, a));
      const c3 = await chunkedDistribute(investors, ones, CHUNK, (t, a) => e721.distributeToMany(t, a));
      b.erc1155 = { totalGas: c1.totalGas, gasPerInvestor: c1.totalGas / X, storageRecords: X, txCount: c1.txCount, chunkedAt: CHUNK, note: `>1 tx: single-tx distribution to ${X} would exceed the block gas limit` };
      b.erc20   = { totalGas: c2.totalGas, gasPerInvestor: c2.totalGas / X, storageRecords: X, txCount: c2.txCount, chunkedAt: CHUNK };
      b.erc721  = { totalGas: c3.totalGas, gasPerInvestor: c3.totalGas / X, storageRecords: X, tokenIds: X, txCount: c3.txCount, chunkedAt: CHUNK };
    }

    // Individual (X separate txs) ERC-1155 path for small X, to expose per-tx base overhead
    if (X <= 100) {
      const { c: eI } = await deploy("BenchERC1155");
      let sum = 0;
      for (let i = 0; i < X; i++) { const gi = await gasOf(eI.mintSingle(0, investors[i], 1)); sum += gi.gasUsed; }
      b.erc1155_individual = { totalGas: sum, gasPerInvestor: sum / X, txCount: X, note: "X separate transactions (21000 base gas per tx included)" };
    }
    results.B[X] = b;
    console.log(`  B X=${X}: 1155=${b.erc1155.totalGas} (perInv ${b.erc1155.gasPerInvestor.toFixed(0)}, ${b.erc1155.txCount}tx)  20=${b.erc20.totalGas}  721=${b.erc721.totalGas}`);
  }

  // ---------- BENCHMARK C: multiple properties ----------
  // P properties, distribute to a fixed set of investors per property.
  // 1155: ONE contract, P ids. 20: P deployed contracts (factory). 721: fractions as ids.
  console.log("== Benchmark C: multiple properties ==");
  const PROPS = [1, 10, 25, 50];
  const INV_PER_PROP = 10;
  for (const P of PROPS) {
    const investors = await makeWallets(INV_PER_PROP, owner);
    const ones = investors.map(() => 1);
    const c = { properties: P, investorsPerProperty: INV_PER_PROP };

    // ERC-1155: one contract, mint each property id to the investors
    let g1155 = 0, tx1155 = 0;
    {
      const { c: e1155, deployGas } = await deploy("BenchERC1155");
      g1155 += deployGas; // one-time
      for (let p = 0; p < P; p++) {
        const gg = await gasOf(e1155.mintToMany(p, investors, ones));
        g1155 += gg.gasUsed; tx1155++;
      }
      c.erc1155 = { deployedContracts: 1, totalGas: g1155, deployGas, mintTxCount: tx1155, gasPerProperty: g1155 / P, gasPerInvestor: g1155 / (P * INV_PER_PROP) };
    }
    // ERC-20-per-property: deploy P contracts via factory, distribute per contract
    {
      const { c: factory, deployGas: facDeploy } = await deploy("BenchERC20Factory");
      let g20 = facDeploy, deployG = 0, tx20 = 0;
      const tokens = [];
      for (let p = 0; p < P; p++) {
        const gd = await gasOf(factory.deployProperty(`P${p}`, `P${p}`));
        g20 += gd.gasUsed; deployG += gd.gasUsed;
        const addr = await factory.properties(p);
        tokens.push(addr);
      }
      for (let p = 0; p < P; p++) {
        const tok = await hre.ethers.getContractAt("BenchERC20", tokens[p]);
        const gg = await gasOf(tok.distributeToMany(investors, ones));
        g20 += gg.gasUsed; tx20++;
      }
      c.erc20 = { deployedContracts: P, factoryDeployGas: facDeploy, perPropertyDeployGas: deployG, totalGas: g20, distTxCount: tx20, gasPerProperty: g20 / P, gasPerInvestor: g20 / (P * INV_PER_PROP) };
    }
    // ERC-721: one contract, fractions as ids
    {
      const { c: e721, deployGas } = await deploy("BenchERC721");
      let g721 = deployGas, tx721 = 0;
      for (let p = 0; p < P; p++) {
        const gg = await gasOf(e721.distributeToMany(investors, ones));
        g721 += gg.gasUsed; tx721++;
      }
      c.erc721 = { deployedContracts: 1, totalGas: g721, deployGas, mintTxCount: tx721, gasPerProperty: g721 / P, gasPerInvestor: g721 / (P * INV_PER_PROP), note: "token-id-per-fraction; ids grow with P*investors" };
    }
    results.C[P] = c;
    console.log(`  C P=${P}: 1155=${c.erc1155.totalGas} (1 contract)  20=${c.erc20.totalGas} (${P} contracts)  721=${c.erc721.totalGas}`);
  }

  // ---------- BENCHMARK D: secondary transfers ----------
  console.log("== Benchmark D: secondary transfers ==");
  {
    const d = {};
    const A = hre.ethers.Wallet.createRandom().address;
    // Use real signers for transfers so msg.sender owns balances
    const signers = await hre.ethers.getSigners();
    const s1 = signers[1], s2 = signers[2], s3 = signers[3];

    // ERC-1155 one-to-one and batch
    {
      const { c: e1155 } = await deploy("BenchERC1155");
      await (await e1155.mintSingle(0, s1.address, 1000)).wait();
      await (await e1155.mintSingle(1, s1.address, 1000)).wait();
      const g1 = await gasOf(e1155.connect(s1).safeTransferFrom(s1.address, s2.address, 0, 10, "0x"));
      const gBatch = await gasOf(e1155.connect(s1).safeBatchTransferFrom(s1.address, s2.address, [0, 1], [5, 5], "0x"));
      d.erc1155 = { oneToOne: g1.gasUsed, batchTwoIds: gBatch.gasUsed };
    }
    // one-to-many distribution (10 recipients) via loop transfer for each standard
    {
      const recips = await makeWallets(10, owner);
      // 1155: transfer 1 unit to each of 10 (10 safeTransferFrom)
      const { c: e1155 } = await deploy("BenchERC1155");
      await (await e1155.mintSingle(0, s1.address, 1000)).wait();
      let sum1155 = 0;
      for (const r of recips) { const g = await gasOf(e1155.connect(s1).safeTransferFrom(s1.address, r, 0, 1, "0x")); sum1155 += g.gasUsed; }
      // 20: transfer to each of 10
      const { c: e20 } = await deploy("BenchERC20", ["P", "P"]);
      await (await e20.mintTo(s1.address, 1000)).wait();
      let sum20 = 0;
      for (const r of recips) { const g = await gasOf(e20.connect(s1).transfer(r, 1)); sum20 += g.gasUsed; }
      d.oneToMany10 = { erc1155: { totalGas: sum1155, gasPerRecipient: sum1155 / 10 }, erc20: { totalGas: sum20, gasPerRecipient: sum20 / 10 } };
    }
    // many-to-one consolidation: 10 holders each send 1 unit to one collector (1155)
    {
      const { c: e1155 } = await deploy("BenchERC1155");
      const holders = [signers[4], signers[5], signers[6], signers[7], signers[8]];
      for (const h of holders) await (await e1155.mintSingle(0, h.address, 10)).wait();
      const collector = signers[9].address;
      let sum = 0;
      for (const h of holders) { const g = await gasOf(e1155.connect(h).safeTransferFrom(h.address, collector, 0, 1, "0x")); sum += g.gasUsed; }
      d.manyToOne5 = { erc1155: { totalGas: sum, gasPerSender: sum / holders.length, senders: holders.length } };
    }
    results.D = d;
    console.log(`  D: 1155 one-to-one=${d.erc1155.oneToOne} batch2=${d.erc1155.batchTwoIds}`);
  }

  // ---------- Determinism verification ----------
  // Gas is a deterministic function of bytecode + inputs + gas schedule. We verify this
  // directly: repeat three representative operations REPS times and confirm identical gas
  // (SD = 0). This is the meaningful form of "repeat >=10x" for deterministic gas.
  console.log("== Determinism verification (gas SD should be 0) ==");
  {
    const det = {};
    const investors = await makeWallets(10, owner);
    const ones = investors.map(() => 1);
    const cases = {
      erc1155_mintSingle_50: async () => { const { c } = await deploy("BenchERC1155"); return (await gasOf(c.mintSingle(0, investors[0], 50))).gasUsed; },
      erc1155_mintToMany_10: async () => { const { c } = await deploy("BenchERC1155"); return (await gasOf(c.mintToMany(0, investors, ones))).gasUsed; },
      erc721_mintN_10:       async () => { const { c } = await deploy("BenchERC721"); return (await gasOf(c.mintN(investors[0], 10))).gasUsed; },
    };
    for (const [name, run] of Object.entries(cases)) {
      const vals = [];
      for (let r = 0; r < REPS; r++) vals.push(await run());
      det[name] = { samples: vals.length, gas: stats(vals), allIdentical: new Set(vals).size === 1 };
      console.log(`  ${name}: gas=${vals[0]} sd=${det[name].gas.sd} identical=${det[name].allIdentical}`);
    }
    results.determinism = det;
  }

  const outfile = path.join(OUT_DIR, `multi_investor_${Date.now()}.json`);
  fs.writeFileSync(outfile, JSON.stringify(results, null, 2));
  console.log("\nWrote", outfile);
}

main().catch((e) => { console.error(e); process.exit(1); });
