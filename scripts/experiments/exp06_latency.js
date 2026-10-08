// Experiment 6 — Latency measurement. Sends 20 real transactions and records
// per-tx confirmation latency, then computes min/avg/P50/P95/P99/max.
const hre = require("hardhat");
const { saveResults, percentile, nativeSymbol } = require("./_lib");

const N = parseInt(process.env.EXP06_TXNS || "20", 10);

async function main() {
  const ethers = hre.ethers;
  const networkName = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const symbol = await nativeSymbol();

  // Optional block-time emulation: when BLOCK_INTERVAL_MS is set, switch the local
  // node to interval mining so each tx waits a realistic block interval before
  // inclusion. This isolates protocol-level confirmation latency (the dominant
  // factor on a live testnet) without needing faucet-funded tokens.
  const intervalMs = parseInt(process.env.BLOCK_INTERVAL_MS || "0", 10);
  const emuLabel = process.env.EMU_LABEL || networkName;
  if (intervalMs > 0) {
    await hre.network.provider.send("evm_setAutomine", [false]);
    await hre.network.provider.send("evm_setIntervalMining", [intervalMs]);
    console.log(`(block-time emulation: ${intervalMs}ms interval mining → '${emuLabel}')`);
  }

  console.log(`\n=== Experiment 6: Latency Measurement on '${emuLabel}' (${N} txns) ===`);
  console.log(`Deployer: ${deployer.address}\n`);

  const Factory = await ethers.getContractFactory("RealShareERC1155");
  let contract;
  const reuse = process.env.REUSE_CONTRACT;
  if (reuse) {
    // Reuse an already-deployed contract (property 1 listed, deployer KYC-approved)
    // to conserve testnet gas — avoids a fresh deploy + setup.
    contract = Factory.attach(reuse);
    console.log(`(reusing deployed contract at ${reuse}; skipping deploy/setup)`);
  } else {
    contract = await Factory.deploy();
    await contract.waitForDeployment();
    // setup
    await (await contract.listProperty(1, 10_000_000, "ipfs://property-1")).wait();
    await (await contract.approveKYC(deployer.address)).wait();
  }

  const samples = [];
  for (let i = 1; i <= N; i++) {
    const t0 = Date.now();
    const tx = await contract.mintFractions(1, deployer.address, 1);
    const receipt = await tx.wait();
    const latencyMs = Date.now() - t0;
    samples.push({
      idx: i,
      blockNumber: receipt.blockNumber,
      latencyMs,
      gasUsed: receipt.gasUsed.toString(),
    });
    console.log(
      `  [${String(i).padStart(2)}/${N}] Block: ${receipt.blockNumber} | Latency: ${latencyMs}ms | Gas: ${receipt.gasUsed.toString()}`
    );
  }

  const lat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const sum = lat.reduce((a, b) => a + b, 0);
  const stats = {
    count: lat.length,
    minMs: lat[0],
    avgMs: Math.round(sum / lat.length),
    p50Ms: percentile(lat, 50),
    p95Ms: percentile(lat, 95),
    p99Ms: percentile(lat, 99),
    maxMs: lat[lat.length - 1],
  };

  console.log("\nLATENCY STATISTICS");
  console.log(`  Min latency:  ${stats.minMs}ms`);
  console.log(`  Avg latency:  ${stats.avgMs}ms`);
  console.log(`  Median (P50): ${stats.p50Ms}ms`);
  console.log(`  P95 latency:  ${stats.p95Ms}ms`);
  console.log(`  P99 latency:  ${stats.p99Ms}ms`);
  console.log(`  Max latency:  ${stats.maxMs}ms`);

  const net = await ethers.provider.getNetwork();
  const payload = {
    experiment: "exp06_latency",
    network: emuLabel,
    runMode: intervalMs > 0 ? `block-time-emulated (${intervalMs}ms interval)` : "local-instant",
    blockIntervalMs: intervalMs || null,
    baseChainId: net.chainId.toString(),
    nativeSymbol: symbol,
    timestamp: new Date().toISOString(),
    txnCount: N,
    statistics: stats,
    samples,
  };

  saveResults("exp06_latency", emuLabel, payload);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
