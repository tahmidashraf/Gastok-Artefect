// Comprehensive gas benchmark for the RealShare performance paper.
// Measures, on the local Hardhat EVM, every gas figure the paper reports:
// workflow profile, per-token minting scaling, ERC-1155/721/20 comparison,
// throughput (TPS), and batch-minting efficiency. Writes one JSON.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const ethers = hre.ethers;
const G = async (txp) => Number((await (await txp).wait()).gasUsed);
const addr = () => ethers.Wallet.createRandom().address;

async function deployGas(name) {
  const F = await ethers.getContractFactory(name);
  const c = await F.deploy();
  await c.waitForDeployment();
  const r = await c.deploymentTransaction().wait();
  return { c, gas: Number(r.gasUsed) };
}

async function main() {
  const [signer] = await ethers.getSigners();
  const out = {};

  // ---- ERC-1155 deploy ----
  const { c: erc1155, gas: deploy1155 } = await deployGas("RealShareERC1155");
  out.deploy = { erc1155: deploy1155 };

  // ---- Exp 1: prototype workflow ----
  // Signer holds the tokens so transfer gas can be measured (random addrs have no key).
  const invB = addr();
  const wf = {};
  wf.listCold = await G(erc1155.listProperty(0, 1_000_000, "ipfs://p0"));
  wf.listWarm = await G(erc1155.listProperty(1, 1_000_000, "ipfs://p1"));
  wf.kyc      = await G(erc1155.approveKYC(signer.address));
  await (await erc1155.approveKYC(invB)).wait();
  wf.mint100  = await G(erc1155.mintFractions(0, signer.address, 100));
  wf.mint50   = await G(erc1155.mintFractions(1, signer.address, 50));
  wf.transfer20 = await G(erc1155.safeTransferFrom(signer.address, invB, 0, 20, "0x"));
  wf.deactivate = await G(erc1155.deactivateProperty(1));
  out.workflow = wf;

  // ---- Exp 2: minting scaling + transfers (same recipient: first cold, rest warm) ----
  const { c: m } = await deployGas("RealShareERC1155");
  await (await m.listProperty(0, 100_000_000, "ipfs://p")).wait();
  const rcpt = signer.address; await (await m.approveKYC(rcpt)).wait();
  const minting = {};
  minting.mint1   = await G(m.mintFractions(0, rcpt, 1));     // cold balance slot
  minting.mint10  = await G(m.mintFractions(0, rcpt, 10));    // warm
  minting.mint50  = await G(m.mintFractions(0, rcpt, 50));
  minting.mint100 = await G(m.mintFractions(0, rcpt, 100));
  minting.mint500 = await G(m.mintFractions(0, rcpt, 500));
  const inv2 = addr(); await (await m.approveKYC(inv2)).wait();
  minting.transfer1  = await G(m.safeTransferFrom(rcpt, inv2, 0, 1, "0x"));   // cold recipient slot
  minting.transfer10 = await G(m.safeTransferFrom(rcpt, inv2, 0, 10, "0x"));  // warm
  minting.transfer50 = await G(m.safeTransferFrom(rcpt, inv2, 0, 50, "0x"));
  out.minting = minting;

  // ---- Exp 3: token-standard comparison ----
  const std = { erc1155: { deploy: deploy1155 }, erc721: {}, erc20: {} };
  // ERC-1155: mint q fractions = single mintFractions(amount=q), fresh recipient each (cold)
  for (const q of [1, 10, 50]) {
    const { c } = await deployGas("RealShareERC1155");
    await (await c.listProperty(0, 100_000_000, "ipfs://p")).wait();
    const r = addr(); await (await c.approveKYC(r)).wait();
    std.erc1155["mint" + q] = await G(c.mintFractions(0, r, q));
  }
  // ERC-721: mint q NFTs = batchMint loop
  const { c: e721, gas: deploy721 } = await deployGas("RealShareERC721");
  std.erc721.deploy = deploy721;
  for (const q of [1, 10, 50]) {
    const r = addr(); await (await e721.approveKYC(r)).wait();
    std.erc721["mint" + q] = await G(e721.batchMint(r, q));
  }
  // ERC-20: mint q units = mintUnits
  const { c: e20, gas: deploy20 } = await deployGas("RealShareERC20");
  std.erc20.deploy = deploy20;
  for (const q of [1, 10, 50]) {
    const r = addr(); await (await e20.approveKYC(r)).wait();
    std.erc20["mint" + q] = await G(e20.mintUnits(r, q));
  }
  out.stdcmp = std;

  // ---- Exp 7: throughput (sequential mints, distinct recipients) ----
  const { c: t } = await deployGas("RealShareERC1155");
  await (await t.listProperty(0, 1_000_000_000, "ipfs://p")).wait();
  const tps = [];
  for (const B of [10, 25, 50, 100, 200]) {
    const rs = Array.from({ length: B }, addr);
    for (const r of rs) await (await t.approveKYC(r)).wait();
    const t0 = Date.now(); let gasSum = 0n;
    for (const r of rs) gasSum += (await (await t.mintFractions(0, r, 1)).wait()).gasUsed;
    const ms = Date.now() - t0;
    tps.push({ batch: B, elapsedMs: ms, tps: +(B / (ms / 1000)).toFixed(0), avgGas: Number(gasSum / BigInt(B)) });
  }
  out.tps = tps;

  // ---- Exp 9: batch minting efficiency (k properties individual vs one batch) ----
  const batch = [];
  for (const k of [2, 3, 5]) {
    // individual
    const { c: ci } = await deployGas("RealShareERC1155");
    const ri = addr(); await (await ci.approveKYC(ri)).wait();
    let indGas = 0n;
    for (let i = 0; i < k; i++) {
      await (await ci.listProperty(i, 1_000_000, "ipfs://p" + i)).wait();
      indGas += (await (await ci.mintFractions(i, ri, 100)).wait()).gasUsed;
    }
    // batch
    const { c: cb } = await deployGas("RealShareERC1155");
    const rb = addr(); await (await cb.approveKYC(rb)).wait();
    const ids = [], amts = [];
    for (let i = 0; i < k; i++) { await (await cb.listProperty(i, 1_000_000, "ipfs://p" + i)).wait(); ids.push(i); amts.push(100); }
    const batchGas = (await (await cb.batchMintFractions(ids, rb, amts)).wait()).gasUsed;
    batch.push({ properties: k, individualGas: Number(indGas), batchGas: Number(batchGas), savingPct: +(Number(indGas - batchGas) / Number(indGas) * 100).toFixed(1) });
  }
  // batch transfer saving: N individual safeTransferFrom vs 1 safeBatchTransferFrom
  {
    const { c: cb } = await deployGas("RealShareERC1155");
    const owner = signer.address; await (await cb.approveKYC(owner)).wait();
    const dst = addr(); await (await cb.approveKYC(dst)).wait();
    const K = 5, ids = [], amts = [];
    for (let i = 0; i < K; i++) { await (await cb.listProperty(i, 1_000_000, "ipfs://p" + i)).wait(); await (await cb.mintFractions(i, owner, 100)).wait(); ids.push(i); amts.push(10); }
    let indT = 0n;
    for (let i = 0; i < K; i++) indT += (await (await cb.safeTransferFrom(owner, dst, i, 10, "0x")).wait()).gasUsed;
    // re-mint for batch path
    const { c: cb2 } = await deployGas("RealShareERC1155");
    await (await cb2.approveKYC(owner)).wait(); const dst2 = addr(); await (await cb2.approveKYC(dst2)).wait();
    const ids2 = [], amts2 = [];
    for (let i = 0; i < K; i++) { await (await cb2.listProperty(i, 1_000_000, "ipfs://p" + i)).wait(); await (await cb2.mintFractions(i, owner, 100)).wait(); ids2.push(i); amts2.push(10); }
    const batchT = (await (await cb2.safeBatchTransferFrom(owner, dst2, ids2, amts2, "0x")).wait()).gasUsed;
    out.batchTransfer = { k: K, individualGas: Number(indT), batchGas: Number(batchT), savingPct: +(Number(indT - batchT) / Number(indT) * 100).toFixed(1) };
  }
  out.batch = batch;

  const dir = path.join(__dirname, "..", "..", "results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, `gasbench_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log("\nSaved:", path.relative(path.join(__dirname, "..", ".."), file));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
