/**
 * Stage 7 — Repeated live public-testnet sessions (Polygon Amoy / Ethereum Sepolia).
 *
 * *** REQUIRES A FUNDED TESTNET WALLET *** (faucet POL on Amoy / ETH on Sepolia). This step is
 * human-gated: the candidate must fund the wallet before running. Until then the repeated-session
 * experiment is reported as NOT EXECUTED — EVIDENCE REQUIRED.
 *
 * Usage (per network, once funded):
 *   SESSION_TAG=s1 npx hardhat run scripts/experiments/exp_live_sessions.js --network polygonAmoy
 *   SESSION_TAG=s1 npx hardhat run scripts/experiments/exp_live_sessions.js --network sepolia
 * Run >= 5 times per network on different dates/times, incrementing SESSION_TAG.
 *
 * Records, per operation: submission ts, tx-hash ts, inclusion ts, receipt ts, block number,
 * gas used, effective gas price, fee, confirmation latency, and any nonce/RPC errors.
 * Output: results/live-network/<network>/session_<tag>_<ts>.json
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function timedOp(label, sendFn) {
  const submitted = Date.now();
  let tx, hashedAt, receipt, includedAt, error = null;
  try {
    tx = await sendFn();            // returns a TransactionResponse
    hashedAt = Date.now();          // time to get a tx hash back
    receipt = await tx.wait();      // confirmed
    includedAt = Date.now();
  } catch (e) {
    error = String(e.message || e);
  }
  return {
    label,
    txHash: tx ? tx.hash : null,
    blockNumber: receipt ? receipt.blockNumber : null,
    status: receipt ? receipt.status : null,
    gasUsed: receipt ? Number(receipt.gasUsed) : null,
    effectiveGasPriceWei: receipt && receipt.gasPrice ? receipt.gasPrice.toString() : null,
    feeWei: receipt && receipt.fee ? receipt.fee.toString() : null,
    submitMs: submitted,
    timeToHashMs: hashedAt ? hashedAt - submitted : null,
    confirmationLatencyMs: includedAt ? includedAt - submitted : null,
    error,
  };
}

async function main() {
  const tag = process.env.SESSION_TAG || "s1";
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("No signer — set PRIVATE_KEY in .env and fund the wallet.");
  const net = await hre.ethers.provider.getNetwork();
  const bal = await hre.ethers.provider.getBalance(signer.address);
  if (bal === 0n) {
    console.error(`WALLET ${signer.address} has ZERO balance on chain ${net.chainId}. Fund via faucet first.`);
    console.error("NOT EXECUTED — EVIDENCE REQUIRED.");
    process.exit(3);
  }

  const F = await hre.ethers.getContractFactory("RealShareERC1155");
  const session = { experiment: "live_session", tag, network: hre.network.name, chainId: Number(net.chainId),
    wallet: signer.address, startBalance: bal.toString(), timestamp: new Date().toISOString(), operations: [] };

  // 1. deploy
  let contract;
  const dep = await timedOp("deploy", async () => {
    contract = await F.deploy();
    const t = contract.deploymentTransaction();
    await contract.waitForDeployment();
    return t;
  });
  session.contractAddress = contract ? await contract.getAddress() : null;
  session.operations.push(dep);

  if (contract) {
    const inv = signer.address;
    session.operations.push(await timedOp("listProperty", () => contract.listProperty(0, 1_000_000n, "ipfs://p0")));
    session.operations.push(await timedOp("approveKYC", () => contract.approveKYC(inv)));
    session.operations.push(await timedOp("mintSingle", () => contract.mintFractions(0, inv, 1)));
    session.operations.push(await timedOp("mintMulti", () => contract.mintFractions(0, inv, 100)));
    // self-transfer requires a second KYC'd address; use the same signer address is not allowed
    // (KYC of recipient needed). Keep to owner-authored ops to bound testnet spend.
  }

  const endBal = await hre.ethers.provider.getBalance(signer.address);
  session.endBalance = endBal.toString();
  session.spentWei = (bal - endBal).toString();

  const dir = path.join(__dirname, "..", "..", "results", "live-network", hre.network.name);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `session_${tag}_${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(session, null, 2));
  console.log(`Session ${tag} on ${hre.network.name}: ${session.operations.filter(o=>o.status===1).length}/${session.operations.length} ops confirmed. Wrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
