/*
 * Cross-chain EVM gas-schedule fingerprinting, exact variant with endpoint guards.
 *
 * Method
 *   Exact gas is recovered by bisecting the gas cap of eth_call:
 *       G* = min { G : eth_call({data, gas: G}) succeeds }
 *   which requires no funded account and no deployment.
 *
 * Why the guards matter
 *   Not every public RPC honours the supplied gas cap. polygon-amoy.drpc.org, for
 *   example, returns success at 21,000 gas for a creation whose intrinsic cost
 *   alone exceeds that, so a naive bisection silently collapses to the search
 *   floor and reports a large negative divergence. Every endpoint is therefore
 *   screened before use:
 *     G1 a call at 21,000 gas MUST fail  (cap is enforced)
 *     G2 a call at a generous cap MUST succeed (endpoint is healthy)
 *   Calls also set gasPrice=0, because OP-stack nodes otherwise cap eth_call by a
 *   balance-derived gas allowance and a zero-balance sender cannot reach high caps.
 *   and every bisected value is range-checked against the estimateGas upper bound.
 *
 * Baseline
 *   The Ethereum-schedule reference is the local Hardhat receipt gasUsed, which is
 *   exact by construction. Public Ethereum testnet endpoints are rate-limited well
 *   below what bisection needs, and a chain measured here that shares the Ethereum
 *   schedule reproduces the local value exactly, which validates the substitution.
 *
 * Run: node scripts/experiments/exp_gas_fingerprint_exact2.mjs [chainNameSubstring ...]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'results', 'gas-fingerprint');
const FROM = '0x71C59a35b79A18b0A44540501cB900761DC32fD0';

const TIMEOUT_MS = 20000;
const PAUSE_MS = 200;
const ATTEMPTS = 5;
const FLOOR = 21000;              // intrinsic floor; no creation can cost less

const CHAINS = [
  { name: 'Polygon Amoy', id: 80002, family: 'PoS commit-chain', urls: [
    'https://polygon-amoy-bor-rpc.publicnode.com',
    'https://polygon-amoy.gateway.tenderly.co'] },
  { name: 'Ethereum Sepolia', id: 11155111, family: 'Ethereum L1 testnet', urls: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.gateway.tenderly.co',
    'https://1rpc.io/sepolia'] },
  { name: 'Arbitrum Sepolia', id: 421614, family: 'Nitro rollup', urls: [
    'https://sepolia-rollup.arbitrum.io/rpc'] },
  { name: 'Optimism Sepolia', id: 11155420, family: 'OP-Stack rollup', urls: [
    'https://sepolia.optimism.io'] },
  { name: 'Base Sepolia', id: 84532, family: 'OP-Stack rollup', urls: [
    'https://sepolia.base.org'] },
  { name: 'BSC Testnet', id: 97, family: 'PoSA sidechain', urls: [
    'https://data-seed-prebsc-1-s1.bnbchain.org:8545'] },
  { name: 'Avalanche Fuji', id: 43113, family: 'Subnet-EVM C-Chain', urls: [
    'https://api.avax-test.network/ext/bc/C/rpc'] },

  // Production networks. eth_call needs no balance on mainnet either, so the
  // same method applies unchanged and the findings are not testnet artefacts.
  { name: 'Ethereum Mainnet', id: 1, family: 'Ethereum L1', urls: [
    'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'] },
  { name: 'Polygon Mainnet', id: 137, family: 'PoS commit-chain', urls: [
    'https://polygon-bor-rpc.publicnode.com', 'https://polygon.llamarpc.com'] },
  { name: 'Arbitrum One', id: 42161, family: 'Nitro rollup', urls: [
    'https://arbitrum-one-rpc.publicnode.com'] },
  { name: 'Optimism Mainnet', id: 10, family: 'OP-Stack rollup', urls: [
    'https://optimism-rpc.publicnode.com'] },
  { name: 'Base Mainnet', id: 8453, family: 'OP-Stack rollup', urls: [
    'https://base-rpc.publicnode.com'] },
  { name: 'BNB Smart Chain', id: 56, family: 'PoSA sidechain', urls: [
    'https://bsc-rpc.publicnode.com'] },
  { name: 'Avalanche C-Chain', id: 43114, family: 'Subnet-EVM C-Chain', urls: [
    'https://avalanche-c-chain-rpc.publicnode.com'] },
];

const PROBES = [
  ['ProbeBaseline', 0, 0], ['ProbeColdSstore1', 0, 1], ['ProbeColdSstore2', 0, 2],
  ['ProbeColdSstore4', 0, 4], ['ProbeColdSstore8', 0, 8], ['ProbeColdSstore16', 0, 16],
  ['ProbeWarmSstore4', 0, 1], ['ProbeWarmSstore16', 0, 1],
  ['ProbeColdSload8', 8, 1], ['ProbeColdSload32', 32, 1],
  ['ProbeLog4', 0, 0], ['ProbeLog16', 0, 0],
  ['ProbeColdAccount8', 0, 1], ['ProbeColdAccount32', 0, 1],
  ['ProbeKeccak64', 0, 1], ['ProbeMemory', 0, 1],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OOG = /out of gas|intrinsic gas too low|gas required exceeds|exceeds.*gas|insufficient gas|gas limit/i;
// NOTE: the 429 alternative must be word-bounded. Without  it matches the
// digits inside gas values such as "exceeds: 84292", which turns a genuine
// out-of-gas reply into a spurious throttle and aborts the bisection.
const THROTTLE = /rate limit|too many|\b429\b|capacity|limit exceeded|usage limit|upgrade to|apply an/i;

const bytecodeOf = (n) => JSON.parse(fs.readFileSync(
  path.join(ROOT, 'artifacts/contracts/probes/GasProbes.sol', `${n}.json`), 'utf8')).bytecode;

async function rawRpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch { throw new Error(`non-JSON (${res.status})`); }
}

// Screen an endpoint: must enforce the gas cap and must serve a generous call.
async function screen(url, probeBytecode) {
  try {
    const low = await rawRpc(url, 'eth_call', [{ from: FROM, data: probeBytecode, gas: '0x5208', gasPrice: '0x0' }, 'latest']);
    if (!low.error) return { ok: false, why: 'ignores gas cap (succeeded at 21000)' };
    if (THROTTLE.test(low.error.message || '')) return { ok: false, why: 'throttled' };
    const hi = await rawRpc(url, 'eth_call', [{ from: FROM, data: probeBytecode, gas: '0x2DC6C0', gasPrice: '0x0' }, 'latest']);
    if (hi.error) return { ok: false, why: `high-gas call failed: ${String(hi.error.message).slice(0, 40)}` };
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message).slice(0, 40) }; }
}

async function pickEndpoint(chain, probeBytecode) {
  for (const url of chain.urls) {
    const s = await screen(url, probeBytecode);
    const host = new URL(url).host;
    if (s.ok) { console.log(`  endpoint: ${host} (gas cap enforced)`); return url; }
    console.log(`  endpoint rejected: ${host} - ${s.why}`);
    await sleep(400);
  }
  return null;
}

async function callRetry(url, method, params) {
  let last;
  for (let a = 0; a < ATTEMPTS; a++) {
    try {
      const j = await rawRpc(url, method, params);
      if (j.error) {
        const m = j.error.message || '';
        if (THROTTLE.test(m)) { last = new Error(m); await sleep(2500 * (a + 1)); continue; }
        return { error: m };
      }
      return { result: j.result };
    } catch (e) { last = e; await sleep(800); }
  }
  throw last ?? new Error('retries exhausted');
}

async function succeeds(url, data, gas) {
  const r = await callRetry(url, 'eth_call', [{ from: FROM, data, gas: '0x' + gas.toString(16), gasPrice: '0x0' }, 'latest']);
  if (r.error) return !OOG.test(r.error);   // non-gas error means execution was reached
  return true;
}

async function exactGas(url, data) {
  // estimateGas is only a seed for the upper bound. Some nodes refuse it for
  // larger payloads with their own cap, so fall back to a fixed generous bound,
  // which endpoint screening has already shown the node will serve.
  const FALLBACK_HI = 3000000;
  const est = await callRetry(url, 'eth_estimateGas', [{ from: FROM, data, gasPrice: '0x0' }]);
  let hi0 = est.error ? FALLBACK_HI : parseInt(est.result, 16);

  // On OP-stack chains eth_estimateGas can return slightly BELOW the cap that
  // eth_call actually needs, because the two account for the L1 data component
  // differently. Expand the upper bound until it really succeeds, rather than
  // bisecting inside a window that does not contain the answer.
  let expands = 0;
  while (!(await succeeds(url, data, hi0)) && expands < 6) {
    hi0 = Math.ceil(hi0 * 1.5) + 50000;
    expands++;
    await sleep(PAUSE_MS);
  }
  if (expands >= 6) throw new Error('upper bound never succeeded');

  let lo = FLOOR - 1, hi = hi0, calls = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await succeeds(url, data, mid)) hi = mid; else lo = mid;
    calls++;
    await sleep(PAUSE_MS);
  }
  if (hi <= FLOOR) throw new Error(`implausible bisection result ${hi} (est ${hi0})`);
  return { exact: hi, estimate: hi0, padding: hi0 - hi, bisectionCalls: calls };
}

async function main() {
  const filter = process.argv.slice(2);
  const targets = filter.length
    ? CHAINS.filter((c) => filter.some((f) => c.name.toLowerCase().includes(f.toLowerCase())))
    : CHAINS;

  const bc = Object.fromEntries(PROBES.map(([n]) => [n, bytecodeOf(n)]));

  // Ethereum-schedule baseline: exact local receipts.
  const vf = fs.readdirSync(DIR).filter((f) => f.startsWith('local_baseline_')).sort().pop();
  if (!vf) throw new Error('no local_baseline_*.json - run exp_local_baseline.mjs first');
  const baseline = JSON.parse(fs.readFileSync(path.join(DIR, vf), 'utf8'));
  const local = Object.fromEntries(Object.entries(baseline.probes).map(([k, v]) => [k, v.gasUsed]));
  console.log(`baseline: ${vf}`);

  const out = { experiment: 'gas_schedule_fingerprint_exact_guarded', timestamp: new Date().toISOString(),
    baseline: 'local Hardhat receipt gasUsed (Ethereum schedule, cancun)',
    baselineValues: local, chains: {}, exact: {}, deltaVsLocal: {} };

  for (const chain of targets) {
    console.log(`\n=== ${chain.name} (${chain.id}) ===`);
    const url = await pickEndpoint(chain, bc.ProbeColdSstore1);
    if (!url) { console.log('  no usable endpoint - skipped'); continue; }
    out.chains[chain.name] = { chainId: chain.id, family: chain.family, endpoint: new URL(url).host };
    out.exact[chain.name] = {}; out.deltaVsLocal[chain.name] = {};

    for (const [name, nSload, nSstore] of PROBES) {
      try {
        const r = await exactGas(url, bc[name]);
        const d = r.exact - local[name];
        out.exact[chain.name][name] = { ...r, coldSload: nSload, coldSstore: nSstore };
        out.deltaVsLocal[chain.name][name] = { delta: d, coldSload: nSload, coldSstore: nSstore };
        console.log(`  ${name.padEnd(20)} exact=${String(r.exact).padStart(8)} local=${String(local[name]).padStart(8)} delta=${(d > 0 ? '+' : '') + d}`);
      } catch (e) {
        console.log(`  ${name.padEnd(20)} FAILED ${String(e.message).slice(0, 55)}`);
        out.exact[chain.name][name] = { error: String(e.message).slice(0, 160) };
      }
    }
  }

  const f = path.join(DIR, `exact2_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
