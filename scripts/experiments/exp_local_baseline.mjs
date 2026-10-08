/*
 * Ethereum-schedule baseline: exact gasUsed for every probe, from local receipts.
 *
 * This is ground truth by construction. Remote bisected values are compared
 * against it, and any chain sharing the Ethereum schedule reproduces it exactly.
 *
 * Must be regenerated whenever the probe source file changes: appending a contract
 * alters the solc metadata hash embedded in EVERY contract in the file, which
 * shifts calldata gas by a few units and would otherwise show up as a spurious
 * cross-chain divergence.
 *
 * Run: npx hardhat run scripts/experiments/exp_local_baseline.mjs
 */

import hre from 'hardhat';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'results', 'gas-fingerprint');

const PROBES = [
  'ProbeBaseline', 'ProbeColdSstore1', 'ProbeColdSstore2', 'ProbeColdSstore4',
  'ProbeColdSstore8', 'ProbeColdSstore16', 'ProbeWarmSstore4', 'ProbeWarmSstore16',
  'ProbeColdSload8', 'ProbeColdSload32', 'ProbeLog4', 'ProbeLog16',
  'ProbeColdAccount8', 'ProbeColdAccount32', 'ProbeKeccak64', 'ProbeMemory',
  'ProbeSloadThenSstore1', 'ProbeSloadThenSstore4',
];

async function main() {
  const rows = {};
  for (const name of PROBES) {
    const F = await hre.ethers.getContractFactory(name);
    const c = await F.deploy();
    const r = await c.deploymentTransaction().wait();
    const art = await hre.artifacts.readArtifact(name);
    rows[name] = {
      gasUsed: Number(r.gasUsed),
      // Bytecode hash pins the exact artifact this baseline belongs to, so a
      // stale baseline can be detected rather than silently mis-differenced.
      bytecodeSha256: crypto.createHash('sha256').update(art.bytecode).digest('hex').slice(0, 16),
    };
    console.log(`${name.padEnd(24)} ${String(r.gasUsed).padStart(8)}  ${rows[name].bytecodeSha256}`);
  }

  fs.mkdirSync(DIR, { recursive: true });
  const out = {
    experiment: 'local_ethereum_schedule_baseline',
    timestamp: new Date().toISOString(),
    schedule: 'Ethereum (Hardhat, evm cancun, solc 0.8.27, optimizer 200)',
    note: 'exact receipt gasUsed; regenerate whenever GasProbes.sol changes',
    probes: rows,
  };
  const f = path.join(DIR, `local_baseline_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
