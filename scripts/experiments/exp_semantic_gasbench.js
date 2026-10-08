/**
 * Phase 8-10 semantic-workload gas benchmark (RealShare revision).
 *
 * Fixes forensic findings B1 (amount-amortization mislabeled as warm-slot reuse) and
 * B2 (throughput) with REAL measured gas on the local Hardhat EVM. All three standards use
 * the identical compiler/optimizer/EVM target from hardhat.config.js (solc 0.8.27,
 * optimizer runs 200, evm cancun) and the same harness, machine, and measurement code.
 *
 * Workloads:
 *   W1 amount-amortization : 1 ERC-1155 id, 1 recipient, amount q in {1,10,50,100,500,1000},
 *                            separating the one-time COLD balance slot from WARM re-credit,
 *                            proving total gas is flat in q (one balance write).
 *   W2 multi-id            : n distinct property ids to one recipient via native _mintBatch.
 *   W3 multi-investor      : one property to N investors; ERC-1155 vs ERC-721 vs ERC-20.
 *   W4 portfolio           : P properties x N investors grid across standards.
 *   Lifecycle              : deploy + issuance + transfer; gas per investor/property/claim,
 *                            break-even, bytecode size, calldata bytes.
 *   Throughput             : corrected TPS derivation (measured/theoretical/estimated).
 *
 * Run: npx hardhat run scripts/experiments/exp_semantic_gasbench.js
 * Output: results/semantic_gasbench_<network>_<ts>.json  (raw, machine-readable)
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ethers = hre.ethers;

const addr = () => ethers.Wallet.createRandom().address;
const addrs = (n) => Array.from({ length: n }, addr);
const gasOf = async (txp) => Number((await (await txp).wait()).gasUsed);

// Populate a tx (no send) to read exact calldata size in bytes.
async function calldataBytes(contract, fn, args) {
  const data = contract.interface.encodeFunctionData(fn, args);
  return (data.length - 2) / 2; // strip 0x, 2 hex chars/byte
}

async function deployGas(name, args = []) {
  const F = await ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  await c.waitForDeployment();
  const r = await c.deploymentTransaction().wait();
  const bytecode = (await hre.artifacts.readArtifact(name)).deployedBytecode;
  return { c, deployGas: Number(r.gasUsed), bytecodeBytes: (bytecode.length - 2) / 2 };
}

// Sum real gasUsed over recipient chunks sized to stay under a per-tx gas budget.
async function chunkedMint(sendChunk, items, perItemGasEstimate, budget = 8_000_000) {
  const perTx = Math.max(1, Math.floor(budget / perItemGasEstimate));
  let total = 0, txs = 0;
  for (let i = 0; i < items.length; i += perTx) {
    total += await gasOf(sendChunk(items.slice(i, i + perTx)));
    txs++;
  }
  return { totalGas: total, txCount: txs };
}

async function main() {
  const [signer] = await ethers.getSigners();
  const net = hre.network.name;
  const out = {
    experiment: "semantic_gasbench",
    network: net,
    env: {
      solc: "0.8.27", optimizer: true, optimizerRuns: 200, evm: "cancun",
      openzeppelin: "5.0.2", note: "versions from hardhat.config.js + package.json",
    },
    timestamp: Date.now(),
  };

  // ---------- deployments (cost + bytecode size) ----------
  const d1155 = await deployGas("BenchERC1155");
  const d721 = await deployGas("BenchERC721");
  const dFactory = await deployGas("BenchERC20Factory");
  const d20one = await deployGas("BenchERC20", ["P", "P"]); // single ERC-20 deploy cost
  out.deploy = {
    erc1155: { gas: d1155.deployGas, bytecodeBytes: d1155.bytecodeBytes },
    erc721: { gas: d721.deployGas, bytecodeBytes: d721.bytecodeBytes },
    erc20_perProperty: { gas: d20one.deployGas, bytecodeBytes: d20one.bytecodeBytes },
    erc20_factory: { gas: dFactory.deployGas, bytecodeBytes: dFactory.bytecodeBytes },
  };
  const e1155 = d1155.c, e721 = d721.c, factory = dFactory.c;

  // ================= W1: amount-amortization =================
  // One id, one recipient. First credit = COLD slot; subsequent credits to SAME (id,holder)
  // = WARM. Amount q does NOT add storage writes -> total gas ~flat; per-unit = total/q.
  const w1 = { note: "one id, one recipient; total gas is flat in amount (single balance write)", rows: [] };
  const holder = addr();
  // cold: first ever credit to this (id,holder)
  const coldGas = await gasOf(e1155.mintSingle(1, holder, 1));
  w1.coldFirstCredit = { amount: 1, gas: coldGas, state: "cold slot" };
  for (const q of [1, 10, 50, 100, 500, 1000]) {
    // warm: same (id,holder) already non-zero, so this isolates amount effect at warm cost
    const g = await gasOf(e1155.mintSingle(1, holder, q));
    const cd = await calldataBytes(e1155, "mintSingle", [1, holder, q]);
    w1.rows.push({ amount: q, gas: g, gasPerUnit: +(g / q).toFixed(2), calldataBytes: cd, state: "warm" });
  }
  out.W1_amount_amortization = w1;

  // ================= W2: multi-id batching =================
  const w2 = { note: "n distinct property ids to one recipient, native _mintBatch", rows: [] };
  for (const n of [1, 2, 5, 10, 20, 50]) {
    const ids = Array.from({ length: n }, (_, i) => 1000 + i);
    const amts = ids.map(() => 100);
    const rcpt = addr();
    const g = await gasOf(e1155.mintBatchOneRecipient(rcpt, ids, amts));
    const cd = await calldataBytes(e1155, "mintBatchOneRecipient", [rcpt, ids, amts]);
    w2.rows.push({ ids: n, gas: g, gasPerId: +(g / n).toFixed(0), calldataBytes: cd });
  }
  out.W2_multi_id = w2;

  // ================= W3: multi-investor distribution (one property) =================
  // Fair semantic comparison: give 1 property to N investors under each standard.
  const w3 = { note: "one property to N investors; ERC-1155 balances vs ERC-721 NFTs vs ERC-20", rows: [] };
  for (const N of [1, 10, 50, 100]) {
    const investors = addrs(N);
    const amts = investors.map(() => 100);
    // ERC-1155: N balance credits under one id
    const g1155 = await chunkedMint((c) => e1155.mintToMany(2000, c, c.map(() => 100)), investors, 50000);
    // ERC-721: each investor gets 1 NFT fraction (1 claim each) -> N distinct token ids
    const counts = investors.map(() => 1);
    const g721 = await chunkedMint(
      (c) => e721.distributeToMany(c, c.map(() => 1)), investors, 90000);
    // ERC-20 (single property contract): N balance credits
    const { c: e20 } = await deployGas("BenchERC20", ["Prop", "PRP"]);
    const g20 = await chunkedMint((c) => e20.distributeToMany(c, c.map(() => 100)), investors, 50000);
    w3.rows.push({
      investors: N,
      erc1155: { totalGas: g1155.totalGas, txCount: g1155.txCount, gasPerInvestor: +(g1155.totalGas / N).toFixed(0) },
      erc721: { totalGas: g721.totalGas, txCount: g721.txCount, gasPerInvestor: +(g721.totalGas / N).toFixed(0) },
      erc20: { totalGas: g20.totalGas, txCount: g20.txCount, gasPerInvestor: +(g20.totalGas / N).toFixed(0) },
    });
  }
  out.W3_multi_investor = w3;

  // ================= W4: portfolio (P properties x N investors) =================
  const w4 = { note: "P properties x N investors; includes ERC-20 per-property deploy cost", scenarios: [] };
  for (const [P, N] of [[1, 10], [1, 100], [10, 10], [10, 100], [50, 100]]) {
    // build (id, investor) claim list
    const ids = [], tos = [], amts = [];
    const investors = addrs(N);
    for (let p = 0; p < P; p++) for (let i = 0; i < N; i++) { ids.push(5000 + p); tos.push(investors[i]); amts.push(100); }
    const claims = ids.length;
    // ERC-1155: one contract, grid mints
    const idx = Array.from({ length: claims }, (_, k) => k);
    const g1155 = await chunkedMint(
      (c) => e1155.mintGrid(c.map((k) => ids[k]), c.map((k) => tos[k]), c.map(() => 100)), idx, 50000);
    // ERC-721: one contract, one NFT per claim
    const g721 = await chunkedMint(
      (c) => e721.distributeToMany(c.map((k) => tos[k]), c.map(() => 1)), idx, 90000);
    // ERC-20: P deployed contracts (factory) + distribute N each
    let deploy20 = 0; const props = [];
    for (let p = 0; p < P; p++) {
      const rc = await (await factory.deployProperty(`P${p}`, `P${p}`)).wait();
      deploy20 += Number(rc.gasUsed);
      props.push(await factory.properties(p));
    }
    let dist20 = 0, tx20 = 0;
    for (let p = 0; p < P; p++) {
      const e20 = await ethers.getContractAt("BenchERC20", props[p]);
      const r = await chunkedMint((c) => e20.distributeToMany(c, c.map(() => 100)), investors, 50000);
      dist20 += r.totalGas; tx20 += r.txCount;
    }
    w4.scenarios.push({
      P, N, claims,
      erc1155: { totalGas: g1155.totalGas, gasPerClaim: +(g1155.totalGas / claims).toFixed(0), deploys: 1 },
      erc721: { totalGas: g721.totalGas, gasPerClaim: +(g721.totalGas / claims).toFixed(0), deploys: 1 },
      erc20: { deployGas: deploy20, distributeGas: dist20, totalGas: deploy20 + dist20,
               gasPerClaim: +((deploy20 + dist20) / claims).toFixed(0), deploys: P, txCount: tx20 },
    });
  }
  out.W4_portfolio = w4;

  // ================= Throughput (corrected, Phase 10) =================
  // Local execution TPS is measured elsewhere (gasbench.tps). Here we give the corrected
  // THEORETICAL derivation only, clearly labeled; empirical availability needs a live block
  // scan (exp_block_availability.js, PENDING). No fabricated availability fraction.
  const G_block = 30_000_000, T_block = 2.0; // Polygon nominal
  const G_tx = 66485; // avg gas/tx from gasbench.tps.avgGas (measured)
  const theo = G_block / G_tx / T_block;
  out.throughput_corrected = {
    labels: "measured=local EVM; theoretical=block-gas/ (G_tx*T_block); estimated=needs live block scan",
    G_block, T_block, G_tx_measured: G_tx,
    theoretical_TPS_at_100pct: +theo.toFixed(1),
    theoretical_TPS_at_utilization: { "0.50": +(theo * 0.5).toFixed(1), "0.60": +(theo * 0.6).toFixed(1),
      "0.70": +(theo * 0.7).toFixed(1), "0.75": +(theo * 0.75).toFixed(1) },
    note: "Corrects B2: 60-70% of 225.6 = 135.4-157.9 TPS (NOT 30-45). "
        + "Empirical application capacity is [RESULT PENDING: run exp_block_availability.js].",
  };

  // ---------- save ----------
  const dir = path.join(__dirname, "..", "..", "results", "token-benchmarks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `semantic_gasbench_${net}_${out.timestamp}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("saved", path.relative(path.join(__dirname, "..", ".."), file));
  // brief console summary
  console.log("\nW1 amount-amortization (total gas should be flat in amount):");
  for (const r of w1.rows) console.log(`  q=${r.amount}: total ${r.gas} gas, ${r.gasPerUnit}/unit`);
  console.log(`  cold first credit: ${w1.coldFirstCredit.gas} gas`);
  console.log("\nThroughput theoretical:", out.throughput_corrected.theoretical_TPS_at_100pct,
    "TPS @100%,", out.throughput_corrected.theoretical_TPS_at_utilization["0.60"], "@60%");
}

main().catch((e) => { console.error(e); process.exit(1); });
