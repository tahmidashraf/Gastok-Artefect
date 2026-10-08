/*
 * Decomposition test.
 *
 * A bare cold SSTORE pays COLD_SLOAD_COST + SSTORE_SET. A SLOAD followed by an
 * SSTORE to the same slot pays COLD_SLOAD_COST (on the SLOAD) + SSTORE_SET (on a
 * now-warm slot). The two cost the same under the Ethereum schedule but route the
 * cold-access charge through different opcodes, so comparing their Polygon
 * surcharges says which constant was actually repriced.
 *
 * Expected, given the measured coefficients (cold SLOAD +3,360, bare cold SSTORE +840):
 *   +4,200  -> the SLOAD opcode carries a repriced cold-access charge that the
 *              SSTORE path does not, and SSTORE_SET carries a separate +840
 *   +840    -> only SSTORE_SET moved, and the cold SLOAD result needs another account
 *
 * Run: npx hardhat run scripts/experiments/exp_decompose.mjs
 */

import hre from 'hardhat';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'results', 'gas-fingerprint');
const FROM = '0x71C59a35b79A18b0A44540501cB900761DC32fD0';
const URL_POLY = 'https://polygon-amoy-bor-rpc.publicnode.com';

const PROBES = ['ProbeColdSstore1', 'ProbeColdSload8', 'ProbeSloadThenSstore1', 'ProbeSloadThenSstore4'];
const OOG = /out of gas|intrinsic gas too low|gas required exceeds|exceeds.*gas|insufficient gas|gas limit/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(URL_POLY, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (j.error) { if (/rate limit|too many|usage limit/i.test(j.error.message)) { await sleep(2500 * (a + 1)); continue; } return { error: j.error.message }; }
      return { result: j.result };
    } catch (e) { await sleep(800); }
  }
  throw new Error('rpc retries exhausted');
}

async function exactGas(data) {
  const est = await rpc('eth_estimateGas', [{ from: FROM, data }]);
  if (est.error) throw new Error(est.error);
  let lo = 20999, hi = parseInt(est.result, 16);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await rpc('eth_call', [{ from: FROM, data, gas: '0x' + mid.toString(16) }, 'latest']);
    const ok = r.error ? !OOG.test(r.error) : true;
    if (ok) hi = mid; else lo = mid;
    await sleep(180);
  }
  return hi;
}

async function main() {
  const rows = [];
  for (const name of PROBES) {
    const F = await hre.ethers.getContractFactory(name);
    const c = await F.deploy();
    const local = Number((await c.deploymentTransaction().wait()).gasUsed);
    const art = await hre.artifacts.readArtifact(name);
    const poly = await exactGas(art.bytecode);
    rows.push({ probe: name, local, polygon: poly, delta: poly - local });
    console.log(`${name.padEnd(24)} local=${String(local).padStart(8)} polygon=${String(poly).padStart(8)} delta=+${poly - local}`);
  }

  const d1 = rows.find((r) => r.probe === 'ProbeSloadThenSstore1')?.delta;
  const d4 = rows.find((r) => r.probe === 'ProbeSloadThenSstore4')?.delta;
  console.log('\ninterpretation:');
  console.log(`  bare cold SSTORE            +840  (COLD_SLOAD_COST + SSTORE_SET, charged via SSTORE)`);
  console.log(`  bare cold SLOAD             +3360 (COLD_SLOAD_COST, charged via SLOAD)`);
  console.log(`  SLOAD then SSTORE (n=1)     +${d1}`);
  console.log(`  SLOAD then SSTORE (n=4)     +${d4}   (per slot: ${d4 / 4})`);
  if (d1 === 4200) console.log('  => cold-access repricing applies to the SLOAD opcode only; SSTORE_SET carries a separate +840');
  else if (d1 === 840) console.log('  => only SSTORE_SET moved');
  else console.log('  => neither simple account; report measured values');

  fs.mkdirSync(DIR, { recursive: true });
  const f = path.join(DIR, `decomposition_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ experiment: 'polygon_repricing_decomposition', timestamp: new Date().toISOString(), rows }, null, 2));
  console.log(`\nwrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
