/**
 * Stage 8 — Local EVM contract-execution throughput, corrected.
 *
 * This measures how many mint transactions the CONTRACT LOGIC can be pushed through a local
 * Hardhat EVM per second. It is explicitly NOT a Polygon/network TPS figure. Full environment
 * is captured; each load level is repeated 5x and mean/median/SD/min/max reported.
 *
 * Output: results/token-benchmarks/raw/local_evm_throughput_<ts>.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const os = require("os");

const REPS = parseInt(process.env.TPS_REPS || "5", 10);
const LEVELS = [5, 10, 25, 50, 100, 200, 500];
const OUT = path.join(__dirname, "..", "..", "results", "token-benchmarks", "raw");

function stats(a) {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  const mean = s.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / n);
  return { n, mean: +mean.toFixed(1), median: s[Math.floor(n / 2)], min: s[0], max: s[n - 1], sd: +sd.toFixed(2) };
}

async function main() {
  const signers = await hre.ethers.getSigners();
  const [owner] = signers;
  const block = await hre.ethers.provider.getBlock("latest");
  const F = await hre.ethers.getContractFactory("RealShareERC1155");

  const env = {
    experiment: "local_evm_contract_execution_throughput",
    timestamp: new Date().toISOString(),
    note: "Local EVM contract-execution throughput. NOT Polygon network TPS.",
    reps: REPS,
    automine: true,
    blockGasLimit: Number(block.gasLimit),
    signers: signers.length,
    nonceStrategy: "single owner signer, sequential nonces, Promise.all submission",
    warmup: "one throwaway mint before timing each level",
    cpu: os.cpus()[0].model, cpuCores: os.cpus().length, ramGB: +(os.totalmem() / 1e9).toFixed(1),
    os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version,
    hardhat: require(path.join(__dirname, "..", "..", "node_modules", "hardhat", "package.json")).version,
    ethers: require(path.join(__dirname, "..", "..", "node_modules", "ethers", "package.json")).version,
    solc: "0.8.27 (optimizer 200, cancun)",
  };

  const results = { env, levels: [] };

  for (const N of LEVELS) {
    const tpsRuns = [], failRuns = [], elapsedRuns = [];
    let avgGas = 0;
    for (let r = 0; r < REPS; r++) {
      const c = await F.deploy(); await c.waitForDeployment();
      await (await c.listProperty(0, 100_000_000n, "p")).wait();
      // KYC-approve N fresh recipients
      const recips = [];
      for (let i = 0; i < N; i++) recips.push(hre.ethers.Wallet.createRandom().address);
      // approve in chunks to avoid a giant loop of txs skewing timing (approvals not timed)
      for (const a of recips) await (await c.approveKYC(a)).wait();
      // warm-up
      await (await c.mintFractions(0, recips[0], 1)).wait();

      // timed: submit N mints as fast as possible, wait for all
      const t0 = Date.now();
      const txs = [];
      for (let i = 0; i < N; i++) txs.push(c.mintFractions(0, recips[i], 1));
      const sent = await Promise.allSettled(txs);
      const receipts = await Promise.allSettled(sent.map((s) => (s.status === "fulfilled" ? s.value.wait() : Promise.reject())));
      const elapsed = Date.now() - t0;
      const ok = receipts.filter((x) => x.status === "fulfilled").length;
      const failed = N - ok;
      const gasSample = receipts.find((x) => x.status === "fulfilled");
      if (gasSample) avgGas = Number(gasSample.value.gasUsed);
      tpsRuns.push(+(ok / (elapsed / 1000)).toFixed(1));
      failRuns.push(failed);
      elapsedRuns.push(elapsed);
    }
    const row = { level: N, tps: stats(tpsRuns), elapsedMs: stats(elapsedRuns), reverts: failRuns.reduce((a, b) => a + b, 0), avgGasPerMint: avgGas };
    results.levels.push(row);
    console.log(`  N=${String(N).padStart(3)}  TPS mean=${row.tps.mean} sd=${row.tps.sd}  elapsed mean=${row.elapsedMs.mean}ms  reverts=${row.reverts}`);
  }

  const peak = Math.max(...results.levels.map((l) => l.tps.mean));
  results.peakTpsMean = peak;
  const out = path.join(OUT, `local_evm_throughput_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nPeak local-EVM contract-execution throughput (mean): ${peak} TPS. Wrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
