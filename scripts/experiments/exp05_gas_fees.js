// Experiment 5 — Detailed per-operation gas fee analysis.
// Runs 9 operations and records gas + fee for each.
const hre = require("hardhat");
const { measure, saveResults, nativeSymbol } = require("./_lib");

async function main() {
  const ethers = hre.ethers;
  const networkName = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const symbol = await nativeSymbol();

  const investorA = ethers.Wallet.createRandom().address;
  const investorB = ethers.Wallet.createRandom().address;

  console.log(`\n=== Experiment 5: Gas Fee Analysis on '${networkName}' ===`);
  console.log(`Deployer: ${deployer.address}`);
  const startBal = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(startBal)} ${symbol}\n`);

  const Factory = await ethers.getContractFactory("RealShareERC1155");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  console.log(`Contract deployed at: ${await contract.getAddress()}\n`);

  const ops = [];

  // 1. listProperty
  ops.push(await measure("listProperty", () =>
    contract.listProperty(1, 1_000_000, "ipfs://property-1")
  ));

  // 2. approveKYC (deployer holds the fractions first)
  ops.push(await measure("approveKYC(self)", () => contract.approveKYC(deployer.address)));
  // approve the two investors (needed before transfers; measure one of them)
  ops.push(await measure("approveKYC", () => contract.approveKYC(investorA)));
  await (await contract.approveKYC(investorB)).wait();

  // 3-6. mintFractions x4 (increasing amounts)
  ops.push(await measure("mintFractions#1", () => contract.mintFractions(1, deployer.address, 1_000)));
  ops.push(await measure("mintFractions#2", () => contract.mintFractions(1, deployer.address, 5_000)));
  ops.push(await measure("mintFractions#3", () => contract.mintFractions(1, deployer.address, 10_000)));
  ops.push(await measure("mintFractions#4", () => contract.mintFractions(1, deployer.address, 50_000)));

  // 7-8. safeTransferFrom x2
  ops.push(await measure("safeTransferFrom#1", () =>
    contract.safeTransferFrom(deployer.address, investorA, 1, 250, "0x")
  ));
  ops.push(await measure("safeTransferFrom#2", () =>
    contract.safeTransferFrom(deployer.address, investorB, 1, 500, "0x")
  ));

  // 9. deactivateProperty
  ops.push(await measure("deactivateProperty", () => contract.deactivateProperty(1)));

  const net = await ethers.provider.getNetwork();
  const endBal = await ethers.provider.getBalance(deployer.address);
  const totalGas = ops.reduce((a, o) => a + BigInt(o.gasUsed), 0n);

  const payload = {
    experiment: "exp05_gas_fees",
    network: networkName,
    chainId: net.chainId.toString(),
    nativeSymbol: symbol,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    totalGasUsed: totalGas.toString(),
    totalNativeSpent: ethers.formatEther(startBal - endBal),
    operations: ops,
  };

  console.log("\n--- Gas Fee Table ---");
  console.log("  Operation            Gas        Fee (" + symbol + ")");
  for (const o of ops) {
    console.log(`  ${o.label.padEnd(20)} ${o.gasUsed.padStart(8)}   ${o.feeEther}`);
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${totalGas.toString().padStart(8)}`);

  saveResults("exp05_gas_fees", networkName, payload);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
