/*
 * Cross-chain EVM gas-schedule fingerprinting.
 *
 * For every probe contract, eth_estimateGas is issued against each chain's public
 * RPC. No funded account and no deployment are required, so the whole experiment
 * is reproducible by any reader at zero cost.
 *
 * For a fixed probe the init bytecode is byte-identical on every chain, so
 * intrinsic gas, calldata cost and code-deposit cost cancel in
 *     delta(chain, probe) = gas(chain, probe) - gas(ethereum, probe).
 *
 * Run:  node scripts/experiments/exp_gas_fingerprint.mjs
 * Out:  results/gas-fingerprint/fingerprint_<timestamp>.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTDIR = path.join(ROOT, 'results', 'gas-fingerprint');

// Sender is irrelevant to the result but must be well-formed. Balance is not
// required: estimation is performed without a value transfer.
const FROM = '0x71C59a35b79A18b0A44540501cB900761DC32fD0';

const REPS = 3;            // repeated per (chain, probe) to confirm stability
const TIMEOUT_MS = 25000;
const PAUSE_MS = 700;      // courtesy delay for public endpoints
const MAX_ATTEMPTS = 5;    // per endpoint, with exponential backoff on rate limits

// Baseline chain must be first.
const CHAINS = [
  { name: 'Ethereum Sepolia', id: 11155111, family: 'Ethereum L1 testnet',
    urls: ['https://1rpc.io/sepolia', 'https://rpc.sepolia.org', 'https://sepolia.drpc.org'] },
  { name: 'Optimism Sepolia', id: 11155420, family: 'OP-Stack rollup',
    urls: ['https://sepolia.optimism.io', 'https://optimism-sepolia.drpc.org'] },
  { name: 'Base Sepolia', id: 84532, family: 'OP-Stack rollup',
    urls: ['https://sepolia.base.org', 'https://base-sepolia.drpc.org'] },
  { name: 'Arbitrum Sepolia', id: 421614, family: 'Nitro rollup',
    urls: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia.drpc.org'] },
  { name: 'Polygon Amoy', id: 80002, family: 'PoS commit-chain',
    urls: ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy.drpc.org'] },
  { name: 'BSC Testnet', id: 97, family: 'PoSA sidechain',
    urls: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://bsc-testnet.drpc.org'] },
  { name: 'Avalanche Fuji', id: 43113, family: 'Subnet-EVM C-Chain',
    urls: ['https://api.avax-test.network/ext/bc/C/rpc', 'https://avalanche-fuji.drpc.org'] },
];

// probe -> { class, n } so a per-operation surcharge can be read off the slope
const PROBES = [
  ['ProbeBaseline',       'baseline',      0],
  ['ProbeColdSstore1',    'cold SSTORE',   1],
  ['ProbeColdSstore2',    'cold SSTORE',   2],
  ['ProbeColdSstore4',    'cold SSTORE',   4],
  ['ProbeColdSstore8',    'cold SSTORE',   8],
  ['ProbeColdSstore16',   'cold SSTORE',  16],
  ['ProbeWarmSstore4',    'warm SSTORE',   4],
  ['ProbeWarmSstore16',   'warm SSTORE',  16],
  ['ProbeColdSload8',     'cold SLOAD',    8],
  ['ProbeColdSload32',    'cold SLOAD',   32],
  ['ProbeLog4',           'LOG1',          4],
  ['ProbeLog16',          'LOG1',         16],
  ['ProbeColdAccount8',   'cold account',  8],
  ['ProbeColdAccount32',  'cold account', 32],
  ['ProbeKeccak64',       'compute (control)', 64],
  ['ProbeMemory',         'memory (control)',  1],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBytecode(name) {
  const p = path.join(ROOT, 'artifacts', 'contracts', 'probes', 'GasProbes.sol', `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8')).bytecode;
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

async function estimate(chain, data) {
  let lastErr;
  for (const url of chain.urls) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const hex = await rpc(url, 'eth_estimateGas', [{ from: FROM, data }]);
        return { gas: parseInt(hex, 16), endpoint: new URL(url).host };
      } catch (e) {
        lastErr = e;
        const msg = String(e.message).toLowerCase();
        const throttled = msg.includes('rate limit') || msg.includes('too many')
          || msg.includes('429') || msg.includes('capacity') || msg.includes('limit exceeded');
        // Back off hard on throttling; move on quickly for genuine execution errors.
        if (msg.includes('revert') || msg.includes('invalid')) break;
        await sleep(throttled ? 2500 * (attempt + 1) : 600);
      }
    }
  }
  throw lastErr ?? new Error('all endpoints failed');
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const bytecode = Object.fromEntries(PROBES.map(([n]) => [n, loadBytecode(n)]));
  for (const [n, bc] of Object.entries(bytecode)) {
    if (!bc || bc === '0x') throw new Error(`no bytecode for ${n} - run: npx hardhat compile`);
  }

  const results = {};   // chain -> probe -> { gas, stable, samples, endpoint }
  const chainMeta = {};

  for (const chain of CHAINS) {
    console.log(`\n=== ${chain.name} (chainId ${chain.id}) ===`);
    results[chain.name] = {};
    chainMeta[chain.name] = { chainId: chain.id, family: chain.family };

    for (const [name, klass, n] of PROBES) {
      const samples = [];
      let endpoint = null;
      try {
        for (let r = 0; r < REPS; r++) {
          const { gas, endpoint: ep } = await estimate(chain, bytecode[name]);
          samples.push(gas);
          endpoint = ep;
          await sleep(PAUSE_MS);
        }
      } catch (e) {
        console.log(`  ${name.padEnd(20)} FAILED: ${String(e.message).slice(0, 60)}`);
        results[chain.name][name] = { error: String(e.message).slice(0, 200), class: klass, n };
        continue;
      }
      const stable = samples.every((s) => s === samples[0]);
      results[chain.name][name] = { gas: samples[0], samples, stable, class: klass, n, endpoint };
      console.log(`  ${name.padEnd(20)} ${String(samples[0]).padStart(9)}${stable ? '' : '  UNSTABLE ' + samples.join('/')}`);
    }
  }

  // ---- per-chain delta against the Ethereum baseline ----------------------
  const base = CHAINS[0].name;
  const deltas = {};
  for (const chain of CHAINS.slice(1)) {
    deltas[chain.name] = {};
    for (const [name, klass, n] of PROBES) {
      const a = results[chain.name][name];
      const b = results[base][name];
      if (a?.gas == null || b?.gas == null) continue;
      deltas[chain.name][name] = { delta: a.gas - b.gas, class: klass, n };
    }
  }

  const out = {
    experiment: 'cross_chain_gas_schedule_fingerprint',
    timestamp: new Date().toISOString(),
    method: 'eth_estimateGas on identical init bytecode; no deployment, no funded account',
    baselineChain: base,
    reps: REPS,
    solc: '0.8.27, optimizer 200 runs, evm cancun',
    chains: chainMeta,
    probes: PROBES.map(([name, klass, n]) => ({ name, class: klass, n })),
    absolute: results,
    deltaVsBaseline: deltas,
  };

  const file = path.join(OUTDIR, `fingerprint_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);

  // ---- console summary ---------------------------------------------------
  console.log('\n=== DELTA vs Ethereum Sepolia (gas) ===');
  const hdr = 'probe'.padEnd(20) + CHAINS.slice(1).map((c) => c.name.split(' ')[0].padStart(11)).join('');
  console.log(hdr);
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
