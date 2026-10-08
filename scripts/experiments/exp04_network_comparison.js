// Experiment 4 — Network comparison: deploy + representative operations,
// measuring gas, latency and confirmation block on whatever network is selected.
const hre = require("hardhat");
const { measure, saveResults, nativeSymbol } = require("./_lib");

async function main() {
  const ethers = hre.ethers;
  const networkName = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const symbol = await nativeSymbol();

  const recipient = ethers.Wallet.createRandom().address; // KYC target (no gas needed)

  console.log(`\n=== Experiment 4: Network Comparison on '${networkName}' ===`);
  console.log(`Deployer: ${deployer.address}`);
  const startBal = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(startBal)} ${symbol}\n`);

  const ops = [];

  console.log("Step 1: Deploying RealShareERC1155...");
  const Factory = await ethers.getContractFactory("RealShareERC1155");
  const t0 = Date.now();
  const contract = await Factory.deploy();
  const deployTx = contract.deploymentTransaction();
  console.log(`  [Deploy ERC-1155] Tx submitted: ${deployTx.hash}`);
  console.log(`  [Deploy ERC-1155] Waiting for receipt...`);
  await contract.waitForDeployment();
  const deployReceipt = await deployTx.wait();
  const deployLatency = Date.now() - t0;
  const dGasPrice = deployReceipt.gasPrice ?? deployReceipt.effectiveGasPrice ?? 0n;
  console.log(
    `  [Deploy ERC-1155] Confirmed in block ${deployReceipt.blockNumber} | Latency: ${deployLatency}ms | Gas used: ${deployReceipt.gasUsed.toString()}`
  );
  ops.push({
    label: "deploy",
    txHash: deployTx.hash,
    blockNumber: deployReceipt.blockNumber,
    latencyMs: deployLatency,
    gasUsed: deployReceipt.gasUsed.toString(),
    gasPriceWei: dGasPrice.toString(),
    feeWei: (deployReceipt.gasUsed * dGasPrice).toString(),
    feeEther: ethers.formatEther(deployReceipt.gasUsed * dGasPrice),
  });
  const address = await contract.getAddress();
  console.log(`  Contract address: ${address}\n`);

  console.log("Step 2: listProperty...");
  ops.push(await measure("listProperty", () =>
    contract.listProperty(1, 1_000_000, "ipfs://property-1-metadata")
  ));

  console.log("Step 3: approveKYC (recipient)...");
  ops.push(await measure("approveKYC", () => contract.approveKYC(recipient)));

  console.log("Step 4: approveKYC (deployer, so it can hold/transfer)...");
  ops.push(await measure("approveKYC(self)", () => contract.approveKYC(deployer.address)));

  console.log("Step 5: mintFractions to deployer...");
  ops.push(await measure("mintFractions", () =>
    contract.mintFractions(1, deployer.address, 10_000)
  ));

  console.log("Step 6: safeTransferFrom deployer -> recipient...");
  ops.push(await measure("safeTransferFrom", () =>
    contract.safeTransferFrom(deployer.address, recipient, 1, 100, "0x")
  ));

  const net = await ethers.provider.getNetwork();
  const endBal = await ethers.provider.getBalance(deployer.address);
  const totalGas = ops.reduce((a, o) => a + BigInt(o.gasUsed), 0n);

  const payload = {
    experiment: "exp04_network_comparison",
    network: networkName,
    chainId: net.chainId.toString(),
    nativeSymbol: symbol,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contractAddress: address,
    startBalance: ethers.formatEther(startBal),
    endBalance: ethers.formatEther(endBal),
    totalNativeSpent: ethers.formatEther(startBal - endBal),
    totalGasUsed: totalGas.toString(),
    operations: ops,
  };

  console.log("\n--- Summary ---");
  for (const o of ops) {
    console.log(`  ${o.label.padEnd(20)} gas=${o.gasUsed.padStart(8)}  latency=${o.latencyMs}ms`);
  }
  console.log(`  Total gas used: ${totalGas.toString()}`);
  console.log(`  Native spent:   ${ethers.formatEther(startBal - endBal)} ${symbol}`);

  saveResults("exp04", networkName, payload);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
