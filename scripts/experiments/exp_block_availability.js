/**
 * Phase 10 empirical block-gas availability scan (Polygon mainnet, read-only).
 * Closes forensic finding B2-empirical: derive REAL application-available throughput from
 * measured gasUsed/gasLimit across several thousand blocks spanning multiple time windows.
 * No wallet, no faucet: pure JSON-RPC reads from a public Polygon Bor node.
 *
 * Samples W windows spaced ~1 day apart (block-number offsets) x B consecutive blocks each,
 * so the distribution captures temporal variation, not one moment.
 *
 * Run: node scripts/experiments/exp_block_availability.js
 * Output: results/live-network/block_availability_polygon_<ts>.json
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.POLYGON_RPC || "https://polygon-bor-rpc.publicnode.com";
const BLOCKS_PER_WINDOW = parseInt(process.env.BPW || "150", 10);
const N_WINDOWS = parseInt(process.env.WINDOWS || "5", 10);
const BLOCKS_PER_DAY = 43200; // ~2s blocks
const G_TX = 66485;           // measured avg RealShare tx gas (gasbench.tps.avgGas)

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];

async function fetchBlock(provider, n, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const b = await provider.getBlock(n);
      if (b) return { n, gasUsed: Number(b.gasUsed), gasLimit: Number(b.gasLimit), ts: b.timestamp };
    } catch (e) { await new Promise((r) => setTimeout(r, 400 * (i + 1))); }
  }
  return null;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const head = await provider.getBlockNumber();
  console.log(`RPC ${RPC} head ${head}; ${N_WINDOWS} windows x ${BLOCKS_PER_WINDOW} blocks`);
  const all = [];
  for (let w = 0; w < N_WINDOWS; w++) {
    const start = head - w * BLOCKS_PER_DAY;
    const nums = Array.from({ length: BLOCKS_PER_WINDOW }, (_, i) => start - i);
    for (let i = 0; i < nums.length; i += 8) {   // small concurrency
      const batch = await Promise.all(nums.slice(i, i + 8).map((n) => fetchBlock(provider, n)));
      batch.forEach((b) => { if (b) { b.window = w; all.push(b); } });
    }
    const wb = all.filter((b) => b.window === w);
    const uw = wb.map((b) => b.gasUsed / b.gasLimit);
    console.log(`  window ${w} (~${w}d ago): ${wb.length} blocks, mean util ${(100 * uw.reduce((a, c) => a + c, 0) / uw.length).toFixed(1)}%`);
  }
  if (all.length === 0) { console.error("no blocks fetched"); process.exit(1); }

  const util = all.map((b) => b.gasUsed / b.gasLimit).sort((a, b) => a - b);
  const limits = all.map((b) => b.gasLimit).sort((a, b) => a - b);
  const used = all.map((b) => b.gasUsed).sort((a, b) => a - b);
  const meanUtil = util.reduce((a, c) => a + c, 0) / util.length;
  const medLimit = pct(limits, 50);
  const medBlockTimeS = 2.0; // Polygon nominal; also report measured spacing below

  // measured block interval from consecutive timestamps within window 0
  const w0 = all.filter((b) => b.window === 0).sort((a, b) => a.n - b.n);
  const gaps = [];
  for (let i = 1; i < w0.length; i++) if (w0[i].ts && w0[i - 1].ts) gaps.push(w0[i].ts - w0[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const measInterval = gaps.length ? gaps.reduce((a, c) => a + c, 0) / gaps.length : null;

  // Empirical AVAILABLE capacity: unused gas / block => tx/s the app could add.
  // available_gas = gasLimit - gasUsed (median). If app receives share s of that:
  const medLimitN = pct(limits, 50), medUsedN = pct(used, 50);
  const medAvail = medLimitN - medUsedN;
  const T = measInterval || medBlockTimeS;
  const appCap = (share) => +((medAvail * share) / G_TX / T).toFixed(1);
  const theoFull = +(medLimitN / G_TX / T).toFixed(1);

  const out = {
    experiment: "block_availability", chain: "polygon-mainnet", rpc: RPC,
    headBlock: head, nBlocks: all.length, windows: N_WINDOWS, blocksPerWindow: BLOCKS_PER_WINDOW,
    labels: "measured=gasUsed/gasLimit from chain; derived=capacity formulas; G_tx measured",
    G_tx_measured: G_TX, blockInterval_measured_s: measInterval, blockInterval_nominal_s: medBlockTimeS,
    gasLimit: { median: medLimitN, min: limits[0], max: limits[limits.length - 1] },
    utilization: { mean: +meanUtil.toFixed(4), p25: +pct(util, 25).toFixed(4), p50: +pct(util, 50).toFixed(4),
      p75: +pct(util, 75).toFixed(4), p95: +pct(util, 95).toFixed(4), max: +util[util.length - 1].toFixed(4) },
    available_gas_median: medAvail,
    theoretical_TPS_full_block: theoFull,
    app_TPS_at_available_share: { "0.10": appCap(0.10), "0.25": appCap(0.25),
      "0.50": appCap(0.50), "0.75": appCap(0.75) },
    note: "Corrects B2 with real data: gas limit is ~" + Math.round(medLimitN / 1e6)
        + "M (not 30M); empirical median utilization ~" + (100 * pct(util, 50)).toFixed(0)
        + "%. Application-available TPS derived from median UNUSED gas per block.",
  };
  const dir = path.join(__dirname, "..", "..", "results", "live-network");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `block_availability_polygon_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("\nsaved", path.relative(path.join(__dirname, "..", ".."), file));
  console.log(`median gasLimit ${(medLimitN / 1e6).toFixed(1)}M | median util ${(100 * pct(util, 50)).toFixed(1)}% | measured interval ${measInterval?.toFixed(2)}s`);
  console.log(`theoretical full-block TPS ${theoFull} | app TPS @25% avail ${appCap(0.25)} @50% ${appCap(0.50)}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
