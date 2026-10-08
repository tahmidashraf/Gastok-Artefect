/*
 * Live out-of-sample check of the repricing model.
 *
 * The model is fitted only on synthetic micro-probes. Here it is tested against
 * the REAL RealShare contract already deployed at the same address on both
 * Polygon Amoy and Ethereum Sepolia, by bisecting eth_call for real application
 * calls on each chain. No funding, no state mutation: eth_call simulates.
 *
 * Calls are chosen to be owner-only and state-independent (a fresh KYC subject, an
 * unused property id) so that both chains execute the same code path over
 * equivalent state.
 *
 * Run: node scripts/experiments/exp_live_model_check.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'results', 'gas-fingerprint');

const CONTRACT = '0x40aBAe00C9308159e66Bf86fCF6E33df175732AE';
const OWNER = '0x71C59a35b79A18b0A44540501cB900761DC32fD0';   // contract owner / deployer

const ENDPOINTS = {
  'Ethereum Sepolia': 'https://ethereum-sepolia-rpc.publicnode.com',
  'Polygon Amoy': 'https://polygon-amoy-bor-rpc.publicnode.com',
};

const OOG = /out of gas|intrinsic gas too low|gas required exceeds|exceeds.*gas|insufficient gas|gas limit/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Model fitted on synthetic probes only.
const COEF = { coldSloadAccess: 3360, coldSstoreAccess: 840 };

async function rpc(url, method, params) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (j.error) {
        if (/rate limit|too many|usage limit|upgrade/i.test(j.error.message)) { await sleep(2500 * (a + 1)); continue; }
        return { error: j.error.message };
      }
      return { result: j.result };
    } catch { await sleep(800); }
  }
  throw new Error('rpc retries exhausted');
}

async function exactGas(url, tx) {
  const est = await rpc(url, 'eth_estimateGas', [tx]);
  if (est.error) return { error: est.error };
  let lo = 20999, hi = parseInt(est.result, 16), calls = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await rpc(url, 'eth_call', [{ ...tx, gas: '0x' + mid.toString(16) }, 'latest']);
    const ok = r.error ? !OOG.test(r.error) : true;
    if (ok) hi = mid; else lo = mid;
    calls++;
    await sleep(160);
  }
  return { exact: hi, estimate: parseInt(est.result, 16), calls };
}

async function main() {
  const abi = [
    'function approveKYC(address account)',
    'function listProperty(uint256 propertyId, uint256 totalFractions, string metadataURI)',
    'function revokeKYC(address account)',
  ];
  const iface = new ethers.Interface(abi);

  // Fresh, never-touched subjects so both chains see identical (empty) slots.
  const subject = ethers.Wallet.createRandom().address;
  const propId = 900000 + Math.floor(Math.random() * 90000);

  const CALLS = [
    { label: 'approveKYC(fresh)', data: iface.encodeFunctionData('approveKYC', [subject]),
      // 1 cold SLOAD for owner, 1 cold slot written via SSTORE after no prior read
      expect: { coldSload: 2, coldSstore: 0 } },
    { label: 'listProperty(new)', data: iface.encodeFunctionData('listProperty', [propId, 1000000, 'ipfs://model-check']),
      expect: { coldSload: 3, coldSstore: 2 } },
  ];

  const rows = [];
  for (const c of CALLS) {
    const per = {};
    for (const [chain, url] of Object.entries(ENDPOINTS)) {
      const tx = { from: OWNER, to: CONTRACT, data: c.data };
      const r = await exactGas(url, tx);
      per[chain] = r;
      console.log(`${c.label.padEnd(20)} ${chain.padEnd(18)} ${r.error ? 'ERR ' + r.error.slice(0, 50) : 'exact=' + r.exact}`);
      await sleep(400);
    }
    const a = per['Polygon Amoy']?.exact, b = per['Ethereum Sepolia']?.exact;
    if (a != null && b != null) {
      const observed = a - b;
      const predicted = COEF.coldSloadAccess * c.expect.coldSload + COEF.coldSstoreAccess * c.expect.coldSstore;
      console.log(`  -> observed delta = ${observed}   model prediction = ${predicted}   ${observed === predicted ? 'EXACT' : 'residual ' + (observed - predicted)}\n`);
      rows.push({ call: c.label, sepolia: b, amoy: a, observedDelta: observed, predicted, exact: observed === predicted, counts: c.expect });
    } else { rows.push({ call: c.label, error: true, per }); console.log(); }
  }

  fs.mkdirSync(DIR, { recursive: true });
  const f = path.join(DIR, `live_model_check_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({
    experiment: 'live_out_of_sample_model_check', timestamp: new Date().toISOString(),
    contract: CONTRACT, model: COEF,
    note: 'coefficients fitted on synthetic probes only; these are real application calls on the deployed contract',
    rows,
  }, null, 2));
  console.log(`wrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
