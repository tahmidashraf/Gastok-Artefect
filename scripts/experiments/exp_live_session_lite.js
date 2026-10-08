/**
 * Constrained live session against the ALREADY-DEPLOYED contract (no redeploy),
 * to add a second-date data point within residual faucet funds. Records real
 * hashes + submission/hash/inclusion/receipt latencies. Refuses ops it cannot afford.
 * Usage: SESSION_TAG=s2 npx hardhat run scripts/experiments/exp_live_session_lite.js --network sepolia
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEPLOYED = "0x40aBAe00C9308159e66Bf86fCF6E33df175732AE";

async function timed(label, sendFn) {
  const t0 = Date.now();
  let tx, hashMs, rc, incMs, err = null;
  try { tx = await sendFn(); hashMs = Date.now(); rc = await tx.wait(); incMs = Date.now(); }
  catch (e) { err = String(e.message || e).slice(0, 160); }
  return { label, txHash: tx?.hash || null, block: rc?.blockNumber ?? null, status: rc?.status ?? null,
    gasUsed: rc ? Number(rc.gasUsed) : null, effectiveGasPriceWei: rc?.gasPrice?.toString() || null,
    feeWei: rc?.fee?.toString() || null, timeToHashMs: hashMs ? hashMs - t0 : null,
    confirmationLatencyMs: incMs ? incMs - t0 : null, error: err };
}

async function main() {
  const tag = process.env.SESSION_TAG || "s2";
  const [signer] = await hre.ethers.getSigners();
  const net = await hre.ethers.provider.getNetwork();
  const bal0 = await hre.ethers.provider.getBalance(signer.address);
  const feeData = await hre.ethers.provider.getFeeData();
  const gp = feeData.gasPrice || 0n;
  console.log(`network=${hre.network.name} wallet=${signer.address} bal=${hre.ethers.formatEther(bal0)} gasPrice=${gp} wei`);

  const c = await hre.ethers.getContractAt("RealShareERC1155", DEPLOYED, signer);
  const session = { experiment: "live_session_lite", tag, network: hre.network.name, chainId: Number(net.chainId),
    contract: DEPLOYED, wallet: signer.address, gasPriceWei: gp.toString(), startBalance: bal0.toString(),
    timestamp: new Date().toISOString(), operations: [] };

  // pick a fresh property id + fresh investor to avoid state clashes
  const pid = 900 + Math.floor(Math.random() * 90);
  const investor = hre.ethers.Wallet.createRandom().address;

  // budget guard: stop if balance would drop below a safety floor
  const floor = gp * 60000n; // keep ~1 cheap-op reserve
  async function afford(estGas) {
    const bal = await hre.ethers.provider.getBalance(signer.address);
    return bal > gp * BigInt(estGas) + floor;
  }

  const plan = [
    ["listProperty", 110000, () => c.listProperty(pid, 1000, "ipfs://live")],
    ["approveKYC",    55000, () => c.approveKYC(investor)],
    ["mintFractions", 105000, () => c.mintFractions(pid, investor, 10)],
    ["approveKYC(self)",55000,() => c.approveKYC(signer.address)],
    ["mintFractions#2",105000,() => c.mintFractions(pid, signer.address, 5)],
    ["safeTransfer",   85000, () => c.safeTransferFrom(signer.address, investor, pid, 1, "0x")],
  ];
  for (const [label, est, fn] of plan) {
    if (!(await afford(est))) { session.operations.push({ label, skipped: true, reason: "insufficient residual balance" }); console.log(`  SKIP ${label} (low balance)`); continue; }
    const r = await timed(label, fn);
    session.operations.push(r);
    console.log(`  ${label}: ${r.status===1?"OK":"FAIL"} hash=${r.txHash} lat=${r.confirmationLatencyMs}ms gas=${r.gasUsed}`);
  }

  const bal1 = await hre.ethers.provider.getBalance(signer.address);
  session.endBalance = bal1.toString();
  session.spentWei = (bal0 - bal1).toString();
  const confirmed = session.operations.filter(o => o.status === 1);
  session.confirmedCount = confirmed.length;

  const dir = path.join(__dirname, "..", "..", "results", "live-network", hre.network.name);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `session_${tag}_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(session, null, 2));
  console.log(`Session ${tag}: ${confirmed.length} confirmed ops. Spent ${hre.ethers.formatEther(bal0-bal1)}. Wrote ${out}`);
}
main().catch(e => { console.error(String(e.message||e).slice(0,200)); process.exit(1); });
