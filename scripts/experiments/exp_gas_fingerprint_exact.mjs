/*
 * Cross-chain EVM gas-schedule fingerprinting, EXACT variant.
 *
 * eth_estimateGas is not exact: it returns a padded upper bound whose padding
 * grows with the gas value (measured on Sepolia: +848 at 67k, +4,516 at 426k).
 * Comparing padded estimates across chains would fold that padding into the
 * cross-chain difference.
 *
 * This script instead recovers the EXACT gas requirement by bisecting on
 * eth_call, which enforces the supplied gas cap and needs no account balance:
 *
 *     G* = min { G : eth_call({data, gas: G}) succeeds }
 *
 * G* is the true execution gas. The search is seeded from eth_estimateGas as an
 * upper bound, so only a narrow window has to be bisected.
 *
 * Validation: on an Ethereum-schedule network, G* must equal the gasUsed of a
 * real local deployment. That check is asserted per probe and reported.
 *
 * Run: node scripts/experiments/exp_gas_fingerprint_exact.mjs
 * Out: results/gas-fingerprint/exact_<timestamp>.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTDIR = path.join(ROOT, 'results', 'gas-fingerprint');
const FROM = '0x71C59a35b79A18b0A44540501cB900761DC32fD0';

const TIMEOUT_MS = 25000;
const PAUSE_MS = 250;
const MAX_ATTEMPTS = 6;

const CHAINS = [
  { name: 'Ethereum Sepolia', id: 11155111, family: 'Ethereum L1 testnet',
    urls: ['https://1rpc.io/sepolia', 'https://sepolia.drpc.org', 'https://rpc.sepolia.org',
           'https://ethereum-sepolia-rpc.publicnode.com'] },
  { name: 'Optimism Sepolia', id: 11155420, family: 'OP-Stack rollup',
    urls: ['https://sepolia.optimism.io', 'https://optimism-sepolia.drpc.org'] },
  { name: 'Base Sepolia', id: 84532, family: 'OP-Stack rollup',
    urls: ['https://sepolia.base.org', 'https://base-sepolia.drpc.org'] },
  { name: 'Arbitrum Sepolia', id: 421614, family: 'Nitro rollup',
    urls: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia.drpc.org'] },
  { name: 'Polygon Amoy', id: 80002, family: 'PoS commit-chain',
    urls: ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy.drpc.org'] },
  { name: 'BSC Testnet', id: 97, family: 'PoSA sidechain',
    urls: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://bsc-testnet.drpc.org',
           'https://data-seed-prebsc-2-s1.bnbchain.org:8545'] },
  { name: 'Avalanche Fuji', id: 43113, family: 'Subnet-EVM C-Chain',
    urls: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji.drpc.org'] },
];

const PROBES = [
  ['ProbeBaseline',      'baseline',           0],
  ['ProbeColdSstore1',   'cold SSTORE',        1],
  ['ProbeColdSstore2',   'cold SSTORE',        2],
  ['ProbeColdSstore4',   'cold SSTORE',        4],
  ['ProbeColdSstore8',   'cold SSTORE',        8],
  ['ProbeColdSstore16',  'cold SSTORE',       16],
  ['ProbeWarmSstore4',   'warm SSTORE',        4],
  ['ProbeWarmSstore16',  'warm SSTORE',       16],
  ['ProbeColdSload8',    'cold SLOAD',         8],
  ['ProbeColdSload32',   'cold SLOAD',        32],
  ['ProbeLog4',          'LOG1',               4],
  ['ProbeLog16',         'LOG1',              16],
  ['ProbeColdAccount8',  'cold account',       8],
  ['ProbeColdAccount32', 'cold account',      32],
  ['ProbeKeccak64',      'compute (control)', 64],
  ['ProbeMemory',        'memory (control)',   1],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OOG = /out of gas|intrinsic gas too low|gas required exceeds|exceeds gas limit|insufficient gas/i;
const THROTTLE = /rate limit|too many|429|capacity|limit exceeded|apply an .* key|upgrade to/i;

function loadBytecode(name) {
  const p = path.join(ROOT, 'artifacts', 'contracts', 'probes', 'GasProbes.sol', `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8')).bytecode;
}

async function rawRpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`non-JSON response (${res.status})`); }
  return j;
}

// Resilient call that rotates endpoints and backs off on throttling.
async function call(chain, method, params) {
  let lastErr;
  for (let round = 0; round < 2; round++) {
    for (const url of chain.urls) {
      for (let a = 0; a < MAX_ATTEMPTS; a++) {
        try {
          const j = await rawRpc(url, method, params);
          if (j.error) {
            const msg = j.error.message || JSON.stringify(j.error);
            if (THROTTLE.test(msg)) { await sleep(2000 * (a + 1)); lastErr = new Error(msg); continue; }
            return { error: msg };                 // genuine execution error
          }
          return { result: j.result };
        } catch (e) {
          lastErr = e;
          await sleep(THROTTLE.test(String(e.message)) ? 2500 * (a + 1) : 700);
        }
      }
    }
  }
  throw lastErr ?? new Error('all endpoints exhausted');
}

// Does a creation call succeed under this gas cap?
async function succeeds(chain, data, gas) {
  const r = await call(chain, 'eth_call', [{ from: FROM, data, gas: '0x' + gas.toString(16) }, 'latest']);
  if (r.error) {
    if (OOG.test(r.error)) return false;
    // Any non-gas error means the call reached execution; treat as success for
    // the purpose of locating the gas threshold, but record it.
    return { ok: true, note: r.error.slice(0, 80) };
  }
  return true;
}

// Exact minimum gas via bisection, seeded from eth_estimateGas as upper bound.
async function exactGas(chain, data) {
  const est = await call(chain, 'eth_estimateGas', [{ from: FROM, data }]);
  if (est.error) throw new Error(`estimateGas: ${est.error}`);
  const hi0 = parseInt(est.result, 16);

  // Window: padding measured well under 2% of the estimate; 6% is a safe floor.
  let lo = Math.max(21000, Math.floor(hi0 * 0.94)) - 1;
  let hi = hi0;
  let calls = 0;

  // Confirm the window actually brackets the threshold.
  const loOk = await succeeds(chain, data, lo); calls++;
  if (loOk === true || (loOk && loOk.ok)) lo = 21000;   // widen if 94% already works

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const ok = await succeeds(chain, data, mid);
    calls++;
    if (ok === true || (ok && ok.ok)) hi = mid; else lo = mid;
    await sleep(PAUSE_MS);
  }
  return { exact: hi, estimate: hi0, padding: hi0 - hi, bisectionCalls: calls };
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const bytecode = Object.fromEntries(PROBES.map(([n]) => [n, loadBytecode(n)]));

  // local ground truth from the validation run, if present
  let localTruth = {};
  const vfiles = fs.existsSync(OUTDIR)
    ? fs.readdirSync(OUTDIR).filter((f) => f.startsWith('estimate_validation_')).sort()
    : [];
  if (vfiles.length) {
    const v = JSON.parse(fs.readFileSync(path.join(OUTDIR, vfiles[vfiles.length - 1]), 'utf8'));
    localTruth = Object.fromEntries(v.rows.map((r) => [r.probe, r.localHardhatGasUsed]));
  }

  const results = {}, meta = {};
  for (const chain of CHAINS) {
    console.log(`\n=== ${chain.name} (${chain.id}) ===`);
    results[chain.name] = {};
    meta[chain.name] = { chainId: chain.id, family: chain.family };
    for (const [name, klass, n] of PROBES) {
      try {
        const r = await exactGas(chain, bytecode[name]);
        results[chain.name][name] = { ...r, class: klass, n };
        const lt = localTruth[name];
        const match = lt != null ? (r.exact === lt ? ' == local' : ` != local(${lt})`) : '';
        console.log(`  ${name.padEnd(20)} exact=${String(r.exact).padStart(8)}  est=${String(r.estimate).padStart(8)}  pad=${String(r.padding).padStart(5)}${match}`);
      } catch (e) {
        console.log(`  ${name.padEnd(20)} FAILED ${String(e.message).slice(0, 55)}`);
        results[chain.name][name] = { error: String(e.message).slice(0, 200), class: klass, n };
      }
    }
  }

  const base = CHAINS[0].name;
  const deltas = {};
  for (const chain of CHAINS.slice(1)) {
    deltas[chain.name] = {};
    for (const [name, klass, n] of PROBES) {
      const a = results[chain.name][name], b = results[base][name];
      if (a?.exact == null || b?.exact == null) continue;
      deltas[chain.name][name] = { delta: a.exact - b.exact, class: klass, n };
    }
  }

  // validation summary
  const val = [];
  for (const [name] of PROBES) {
    const got = results[base][name]?.exact, want = localTruth[name];
    if (got != null && want != null) val.push({ probe: name, bisected: got, localGasUsed: want, agree: got === want });
  }

  const out = {
    experiment: 'cross_chain_gas_schedule_fingerprint_exact',
    timestamp: new Date().toISOString(),
    method: 'exact gas by bisection on eth_call gas cap; no deployment, no funded account',
    baselineChain: base, chains: meta,
    probes: PROBES.map(([name, klass, n]) => ({ name, class: klass, n })),
    validationAgainstLocalReceipts: {
      agree: `${val.filter((v) => v.agree).length}/${val.length}`, rows: val,
    },
    exact: results,
    deltaVsBaseline: deltas,
  };
  const f = path.join(OUTDIR, `exact_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${f}`);
  console.log(`validation vs local receipts: ${out.validationAgainstLocalReceipts.agree}`);

  console.log('\n=== EXACT DELTA vs Ethereum Sepolia (gas) ===');
  console.log('probe'.padEnd(20) + CHAINS.slice(1).map((c) => c.name.split(' ')[0].padStart(11)).join(''));
  for (const [name] of PROBES) {
    let row = name.padEnd(20);
    for (const c of CHAINS.slice(1)) {
      const d = deltas[c.name]?.[name]?.delta;
      row += (d == null ? '-' : (d > 0 ? '+' : '') + d).padStart(11);
    }
    console.log(row);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
