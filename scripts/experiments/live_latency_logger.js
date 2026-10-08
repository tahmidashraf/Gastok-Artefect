/**
 * Phase 11 live-latency logger. Sends real, cheap self-transactions on a testnet and records
 * the full per-transaction latency decomposition the revision requires. Designed to be run
 * as N sessions across >=3 days (>=3 windows/day, 20 tx/session => >=180 tx/network).
 *
 * REQUIRES a faucet-funded wallet (PRIVATE_KEY in .env) on the target network. It sends real
 * transactions and consumes testnet gas. It does NOT fabricate anything: if unfunded or the
 * RPC rejects, it records the failure and the error type.
 *
 * Records per tx: network, op, txHash, submit ts, RPC-accept ts, inclusion ts (block ts),
 * receipt ts, block number, gasUsed, effectiveGasPrice, status, retries, RPC endpoint,
 * session, day, errorType. Derives: rpcDelay, confirmDelay, endToEnd.
 *
 * Run one session:
 *   SESSION=1 TXNS=20 npx hardhat run scripts/experiments/live_latency_logger.js --network polygonAmoy
 *   SESSION=1 TXNS=20 npx hardhat run scripts/experiments/live_latency_logger.js --network sepolia
 * Schedule 3 sessions/day x 3 days per network (cron / Task Scheduler). Aggregate with
 * scripts/analysis/agg_live_latency.py (PENDING) after collection.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ethers = hre.ethers;

const TXNS = parseInt(process.env.TXNS || "20", 10);
const SESSION = process.env.SESSION || "0";

async function main() {
  const net = hre.network.name;
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer: set PRIVATE_KEY in .env (faucet-funded).");
  const provider = signer.provider;
  const rpc = provider._getConnection ? provider._getConnection().url : (process.env.RPC || "unknown");
  const bal = await provider.getBalance(signer.address);
  if (bal === 0n) throw new Error(`Wallet ${signer.address} has 0 balance on ${net}; fund via faucet.`);

  const day = new Date().toISOString().slice(0, 10);
  const samples = [];
  console.log(`Live latency: ${net} session ${SESSION} day ${day}, ${TXNS} tx, wallet ${signer.address}`);

  for (let i = 0; i < TXNS; i++) {
    const rec = { network: net, op: "self-transfer-0", session: SESSION, day, idx: i,
      rpcEndpoint: rpc, retries: 0, errorType: null };
    let attempt = 0, done = false;
    while (!done && attempt < 3) {
      try {
        const tSubmit = Date.now();
        const tx = await signer.sendTransaction({ to: signer.address, value: 0n });
        const tAccept = Date.now();          // RPC accepted + returned hash
        rec.txHash = tx.hash;
        rec.submitTs = tSubmit; rec.rpcAcceptTs = tAccept;
        const receipt = await tx.wait();
        const tReceipt = Date.now();
        const block = await provider.getBlock(receipt.blockNumber);
        rec.receiptTs = tReceipt;
        rec.blockNumber = receipt.blockNumber;
        rec.blockTimestampMs = block.timestamp * 1000;
        rec.gasUsed = receipt.gasUsed.toString();
        rec.effectiveGasPrice = (receipt.gasPrice ?? 0n).toString();
        rec.status = receipt.status;
        rec.rpcDelayMs = tAccept - tSubmit;
        rec.confirmDelayMs = tReceipt - tAccept;
        rec.endToEndMs = tReceipt - tSubmit;
        rec.retries = attempt;
        done = true;
        console.log(`  [${i}] ${tx.hash.slice(0, 12)} e2e=${rec.endToEndMs}ms rpc=${rec.rpcDelayMs}ms confirm=${rec.confirmDelayMs}ms blk=${receipt.blockNumber}`);
      } catch (e) {
        attempt++;
        rec.errorType = (e && e.code) || (e && e.message ? e.message.slice(0, 80) : "unknown");
        console.log(`  [${i}] attempt ${attempt} failed: ${rec.errorType}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!done) rec.failed = true;
    samples.push(rec);
  }

  const ok = samples.filter((s) => !s.failed && s.status === 1);
  const e2e = ok.map((s) => s.endToEndMs).sort((a, b) => a - b);
  const stats = e2e.length ? {
    n: e2e.length, failureRate: +(1 - ok.length / samples.length).toFixed(4),
    mean: +(e2e.reduce((a, b) => a + b, 0) / e2e.length).toFixed(1),
    min: e2e[0], max: e2e[e2e.length - 1],
    p50: e2e[Math.floor(0.5 * e2e.length)], p75: e2e[Math.floor(0.75 * e2e.length)],
    p90: e2e[Math.floor(0.9 * e2e.length)], p95: e2e[Math.floor(0.95 * e2e.length)],
    p99: e2e[Math.min(e2e.length - 1, Math.floor(0.99 * e2e.length))],
  } : { n: 0, note: "no successful tx" };

  const dir = path.join(__dirname, "..", "..", "results", "live-network");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `live_latency_${net}_s${SESSION}_${day}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ network: net, session: SESSION, day, rpcEndpoint: rpc,
    runMode: "LIVE", statistics: stats, samples }, null, 2));
  console.log("saved", path.relative(path.join(__dirname, "..", ".."), file), "| stats:", JSON.stringify(stats));
}

main().catch((e) => { console.error(e); process.exit(1); });
