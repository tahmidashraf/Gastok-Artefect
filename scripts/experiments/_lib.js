// Shared helpers for RealShare testnet experiments.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const RESULTS_DIR = path.join(__dirname, "..", "..", "results");

function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Send a transaction (a function returning a tx-response promise), wait for the
 * receipt, and measure wall-clock latency + on-chain gas.
 */
async function measure(label, sendFn) {
  const ethers = hre.ethers;
  const t0 = Date.now();
  const tx = await sendFn();
  console.log(`  [${label}] Tx submitted: ${tx.hash}`);
  console.log(`  [${label}] Waiting for receipt...`);
  const receipt = await tx.wait();
  const latencyMs = Date.now() - t0;

  // ethers v6: receipt.gasUsed, receipt.gasPrice (effective)
  const gasUsed = receipt.gasUsed;
  const gasPrice = receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n;
  const feeWei = gasUsed * gasPrice;

  console.log(
    `  [${label}] Confirmed in block ${receipt.blockNumber} | Latency: ${latencyMs}ms | Gas used: ${gasUsed.toString()}`
  );

  return {
    label,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    latencyMs,
    gasUsed: gasUsed.toString(),
    gasPriceWei: gasPrice.toString(),
    feeWei: feeWei.toString(),
    feeEther: ethers.formatEther(feeWei),
  };
}

function saveResults(prefix, networkName, payload) {
  ensureResultsDir();
  const ts = Date.now();
  const file = path.join(RESULTS_DIR, `${prefix}_${networkName}_${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`\n✅ Results saved to: ${path.relative(path.join(__dirname, "..", ".."), file)}`);
  return file;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
}

async function nativeSymbol() {
  const net = await hre.ethers.provider.getNetwork();
  const id = Number(net.chainId);
  if (id === 80002 || id === 137) return "MATIC";
  return "ETH";
}

module.exports = { measure, saveResults, percentile, nativeSymbol, RESULTS_DIR };
