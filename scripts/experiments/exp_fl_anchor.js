// Measures the on-chain cost of anchoring federated-learning model rounds:
// ModelRegistry deployment + per-round anchorModel gas (cold first write, warm after).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const ethers = hre.ethers;
  const F = await ethers.getContractFactory("ModelRegistry");
  const c = await F.deploy();
  await c.waitForDeployment();
  const deployGas = Number((await c.deploymentTransaction().wait()).gasUsed);

  const g = async (tx) => Number((await (await tx).wait()).gasUsed);
  const h = (i) => "0x" + i.toString(16).padStart(64, "0");

  const anchorFirst = await g(c.anchorModel(1, h(0xabc1)));   // cold storage slots
  const anchorNext = await g(c.anchorModel(2, h(0xabc2)));    // warm path
  const anchor3 = await g(c.anchorModel(3, h(0xabc3)));

  const out = {
    contract: "ModelRegistry",
    deployGas,
    anchorFirstGas: anchorFirst,
    anchorSubsequentGas: Math.round((anchorNext + anchor3) / 2),
    gwei: 30,
    note: "Per-round anchoring is a single bounded write; cost is independent of model size (only a 32-byte hash is stored).",
  };
  out.anchorCostPOL = +(out.anchorSubsequentGas * 30e-9).toFixed(6);
  out.deployCostPOL = +(deployGas * 30e-9).toFixed(6);

  const dir = path.join(__dirname, "..", "..", "results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `fl_anchor_gas_${Date.now()}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
