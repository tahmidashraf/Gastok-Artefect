/*
 * Opcode census for the real RealShare operations.
 *
 * The fingerprint experiment fits a per-opcode repricing model from synthetic
 * micro-probes. To test that model out of sample it has to predict the gas
 * differences actually observed on-chain between Polygon Amoy and Ethereum
 * Sepolia for real application transactions (Experiment 4 receipts).
 *
 * That needs the opcode counts of each real operation, split by cold/warm, which
 * this script obtains by executing the operations on a local EVM and reading the
 * struct logs from debug_traceTransaction.
 *
 * Cold vs warm is reconstructed per transaction by replaying EIP-2929 access-list
 * semantics over the trace: a storage slot is cold on its first touch within the
 * transaction and warm thereafter; likewise for account addresses.
 *
 * Run: npx hardhat run scripts/experiments/exp_opcode_census.mjs
 * Out: results/gas-fingerprint/opcode_census_<timestamp>.json
 */

import hre from 'hardhat';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTDIR = path.join(ROOT, 'results', 'gas-fingerprint');

// Opcodes whose cost EIP-2929 makes access-dependent.
const ACCOUNT_OPS = new Set(['BALANCE', 'EXTCODESIZE', 'EXTCODECOPY', 'EXTCODEHASH',
  'CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL']);

async function traceCounts(txHash) {
  const trace = await hre.network.provider.send('debug_traceTransaction',
    [txHash, { disableMemory: true, disableStack: false, disableStorage: false }]);

  const touchedSlots = new Set();
  const touchedAccounts = new Set();
  const c = {
    coldSload: 0, warmSload: 0,
    coldSstore: 0, warmSstore: 0,
    coldAccount: 0, warmAccount: 0,
    log: 0, keccak: 0, total: 0,
  };

  for (const s of trace.structLogs || []) {
    c.total++;
    const op = s.op;
    const stack = s.stack || [];
    const top = stack.length ? stack[stack.length - 1] : null;

    if (op === 'SLOAD' || op === 'SSTORE') {
      const slot = top == null ? 'unknown' : BigInt('0x' + top.replace(/^0x/, '')).toString(16);
      const cold = !touchedSlots.has(slot);
      touchedSlots.add(slot);
      if (op === 'SLOAD') cold ? c.coldSload++ : c.warmSload++;
      else cold ? c.coldSstore++ : c.warmSstore++;
    } else if (ACCOUNT_OPS.has(op)) {
      // address is at a known stack depth: top for BALANCE/EXTCODE*, second for CALL family
      const idx = op.startsWith('EXT') || op === 'BALANCE' ? 1 : 2;
      const raw = stack.length >= idx ? stack[stack.length - idx] : null;
      const addr = raw == null ? 'unknown' : BigInt('0x' + raw.replace(/^0x/, '')).toString(16).padStart(40, '0').slice(-40);
      const cold = !touchedAccounts.has(addr);
      touchedAccounts.add(addr);
      cold ? c.coldAccount++ : c.warmAccount++;
    } else if (op.startsWith('LOG')) {
      c.log++;
    } else if (op === 'KECCAK256' || op === 'SHA3') {
      c.keccak++;
    }
  }
  return c;
}

async function main() {
  const [owner, investor] = await hre.ethers.getSigners();

  const F = await hre.ethers.getContractFactory('RealShareERC1155');
  const contract = await F.deploy();
  await contract.waitForDeployment();
  const deployTx = contract.deploymentTransaction();
  const deployRcpt = await deployTx.wait();

  const ops = [];
  const record = async (label, txPromise) => {
    const tx = await txPromise;
    const r = await tx.wait();
    const counts = await traceCounts(r.hash);
    ops.push({ label, gasUsed: Number(r.gasUsed), counts });
    console.log(`${label.padEnd(20)} gas=${String(r.gasUsed).padStart(8)}  ` +
      `coldSstore=${counts.coldSstore} warmSstore=${counts.warmSstore} ` +
      `coldSload=${counts.coldSload} warmSload=${counts.warmSload} ` +
      `coldAcct=${counts.coldAccount} log=${counts.log}`);
  };

  // Mirror scripts/experiments/exp04_network_comparison.js exactly: same
  // arguments, a freshly generated recipient, mint to the deployer, then
  // transfer deployer -> fresh recipient. State shape drives cold/warm counts,
  // so the sequence has to match for the comparison to be meaningful.
  const recipient = hre.ethers.Wallet.createRandom().address;

  await record('listProperty', contract.listProperty(1, 1_000_000, 'ipfs://property-1-metadata'));
  await record('approveKYC', contract.approveKYC(recipient));
  await record('approveKYC(self)', contract.approveKYC(owner.address));
  await record('mintFractions', contract.mintFractions(1, owner.address, 10_000));
  await record('safeTransferFrom',
    contract.safeTransferFrom(owner.address, recipient, 1, 100, '0x'));

  // deployment counts come from the creation trace
  const deployCounts = await traceCounts(deployRcpt.hash);
  console.log(`${'deploy'.padEnd(20)} gas=${String(deployRcpt.gasUsed).padStart(8)}  ` +
    `coldSstore=${deployCounts.coldSstore} coldSload=${deployCounts.coldSload}`);

  const out = {
    experiment: 'opcode_census_real_operations',
    timestamp: new Date().toISOString(),
    note: 'cold/warm reconstructed by replaying EIP-2929 access semantics over debug_traceTransaction struct logs',
    localGasSchedule: 'Ethereum (Hardhat, cancun)',
    deploy: { label: 'deploy', gasUsed: Number(deployRcpt.gasUsed), counts: deployCounts },
    operations: ops,
    // Observed on-chain deltas (Amoy - Sepolia) from Experiment 4 receipts, for
    // out-of-sample comparison against the fitted model.
    observedOnChainDelta: {
      deploy: 8400, listProperty: 11760, approveKYC: 6720,
      'approveKYC(self)': 6720, mintFractions: 20160, safeTransferFrom: 15960,
    },
  };
  fs.mkdirSync(OUTDIR, { recursive: true });
  const f = path.join(OUTDIR, `opcode_census_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
