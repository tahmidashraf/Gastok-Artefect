/*
 * Validation: is eth_estimateGas exact?
 *
 * The fingerprint experiment reads gas via eth_estimateGas rather than by paying
 * for a deployment. That is only sound if estimation returns the true execution
 * gas rather than a padded upper bound. This script deploys every probe on a
 * local EVM (exact gasUsed from the receipt) and compares against the
 * eth_estimateGas value returned by a live Ethereum-schedule network.
 *
 * Agreement on every probe validates the method; any gap is reported.
 *
 * Run: npx hardhat run scripts/experiments/exp_estimate_validation.mjs
 */

import hre from 'hardhat';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FROM = '0x71C59a35b79A18b0A44540501cB900761DC32fD0';
const SEPOLIA = ['https://1rpc.io/sepolia', 'https://rpc.sepolia.org', 'https://sepolia.drpc.org'];

const PROBES = [
  'ProbeBaseline', 'ProbeColdSstore1', 'ProbeColdSstore2', 'ProbeColdSstore4',
  'ProbeColdSstore8', 'ProbeColdSstore16', 'ProbeWarmSstore4', 'ProbeWarmSstore16',
  'ProbeColdSload8', 'ProbeColdSload32', 'ProbeLog4', 'ProbeLog16',
  'ProbeColdAccount8', 'ProbeColdAccount32', 'ProbeKeccak64', 'ProbeMemory',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function estimateSepolia(data) {
  let lastErr;
  for (const url of SEPOLIA) {
    for (let a = 0; a < 4; a++) {
      try { return parseInt(await rpc(url, 'eth_estimateGas', [{ from: FROM, data }]), 16); }
      catch (e) { lastErr = e; await sleep(2000 * (a + 1)); }
    }
  }
  throw lastErr;
}

async function main() {
  const rows = [];
  for (const name of PROBES) {
    const artifact = await hre.artifacts.readArtifact(name);

    // exact local gasUsed
    const F = await hre.ethers.getContractFactory(name);
    const c = await F.deploy();
    const receipt = await c.deploymentTransaction().wait();
    const local = Number(receipt.gasUsed);

    let remote = null, err = null;
    try { remote = await estimateSepolia(artifact.bytecode); }
    catch (e) { err = String(e.message).slice(0, 60); }
    await sleep(800);

    rows.push({ probe: name, localHardhatGasUsed: local, sepoliaEstimateGas: remote, delta: remote == null ? null : remote - local, error: err });
    console.log(`${name.padEnd(20)} local=${String(local).padStart(8)}  sepolia_est=${String(remote ?? 'ERR').padStart(8)}  delta=${remote == null ? '-' : remote - local}`);
  }

  const ok = rows.filter((r) => r.delta === 0).length;
  const cmp = rows.filter((r) => r.delta !== null).length;
  console.log(`\nexact agreement on ${ok}/${cmp} comparable probes`);

  const out = {
    experiment: 'estimate_gas_validation',
    timestamp: new Date().toISOString(),
    claim: 'eth_estimateGas returns exact execution gas, equal to local receipt gasUsed under the same (Ethereum) schedule',
    exactAgreement: `${ok}/${cmp}`,
    rows,
  };
  const dir = path.join(ROOT, 'results', 'gas-fingerprint');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `estimate_validation_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`wrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
