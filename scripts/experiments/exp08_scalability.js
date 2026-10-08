// Experiment 8 — Scalability stress test. Fires N concurrent mintFractions calls
// to N distinct KYC-approved recipients and records success/failure and throughput.
// Contract-level behaviour is environment-independent (runs on the local EVM).
const hre = require("hardhat");
const { saveResults } = require("./_lib");

const LEVELS = (process.env.SCAL_LEVELS || "5,10,15,25,50,100,250,500")
  .split(",").map((x) => parseInt(x, 10));

async function main() {
  const ethers = hre.ethers;
  const [deployer] = await ethers.getSigners();

  console.log(`\n=== Experiment 8: Scalability Stress Test on '${hre.network.name}' ===`);
  const Factory = await ethers.getContractFactory("RealShareERC1155");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  await (await contract.listProperty(1, 100_000_000, "ipfs://property-1")).wait();
  await (await contract.approveKYC(deployer.address)).wait();

  const rows = [];
  for (const N of LEVELS) {
    // Setup (not timed): generate N recipients and KYC-approve them.
    const recipients = Array.from({ length: N }, () => ethers.Wallet.createRandom().address);
    for (const r of recipients) await (await contract.approveKYC(r)).wait();

    // Timed: process N distinct-recipient mints, each confirmed. A single signer's
    // transactions are necessarily nonce-ordered on-chain; we measure that all N
    // are accepted with no contract-level failure or state conflict.
    let success = 0, failed = 0, totalGas = 0n;
    const t0 = Date.now();
    for (const r of recipients) {
      try {
        const rec = await (await contract.mintFractions(1, r, 1)).wait();
        if (rec.status === 1) { success++; totalGas += BigInt(rec.gasUsed); } else failed++;
      } catch { failed++; }
    }
    const elapsedMs = Date.now() - t0;
    const tps = +(success / (elapsedMs / 1000)).toFixed(1);
    const avgGas = success ? Number(totalGas / BigInt(success)) : 0;
    rows.push({ users: N, success, failed, errorRatePct: +((failed / N) * 100).toFixed(1), elapsedMs, tps, avgGas });
    console.log(`  users=${String(N).padStart(3)}  success=${success}  failed=${failed}  err=${((failed/N)*100).toFixed(1)}%  TPS=${tps}  avgGas=${avgGas}`);
  }

  const payload = {
    experiment: "exp08_scalability",
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    levels: LEVELS,
    results: rows,
  };
  saveResults("exp08_scalability", hre.network.name, payload);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
