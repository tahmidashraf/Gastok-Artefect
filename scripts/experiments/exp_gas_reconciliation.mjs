/*
 * Gas reconciliation experiment.
 *
 * Reviewers have observed that the gas figures reported across Experiments 2, 3,
 * 9, 11 and the cross-network table differ for what look like "the same" mint.
 * They do differ, and the differences are fully determined by four factors that
 * the earlier tables did not state explicitly:
 *
 *   (F1) contract under test  - the production RealShareERC1155 carries KYC,
 *        property-active and supply-cap guards plus a minted-fraction counter;
 *        the neutral BenchERC1155 used for cross-standard comparison carries none
 *        of these, because loading them into only the ERC-1155 arm would make the
 *        standard comparison unfair.
 *   (F2) balance-slot state   - a first credit to a holder writes a zero slot
 *        (cold, SSTORE_SET); a subsequent credit to the same holder overwrites a
 *        non-zero slot (warm).
 *   (F3) recipient-account state - ERC-1155 acceptance checking reads the
 *        recipient's code size; a never-touched address is a cold account access.
 *   (F4) calldata             - the amount argument's non-zero byte count.
 *
 * This script measures each factor in isolation on one local EVM run so that every
 * published figure can be derived from a single baseline plus stated deltas.
 *
 * Run: npx hardhat run scripts/experiments/exp_gas_reconciliation.mjs
 * Out: results/gas-reconciliation/reconciliation_<ts>.json
 */

import hre from 'hardhat';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'results', 'gas-reconciliation');

const gasOf = async (txp) => Number((await (await txp).wait()).gasUsed);
const fresh = () => hre.ethers.Wallet.createRandom().address;

async function deployRealShare() {
  const F = await hre.ethers.getContractFactory('RealShareERC1155');
  const c = await F.deploy();
  await c.waitForDeployment();
  return c;
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const m = {};

  // ---- A. production contract, cold balance slot, WARM recipient account -------
  // Recipient is the signer: it has sent transactions, so its account is warm.
  {
    const c = await deployRealShare();
    await (await c.listProperty(0, 100_000_000, 'ipfs://p')).wait();
    await (await c.approveKYC(signer.address)).wait();
    m.A_cold_warmAccount_amount1 = await gasOf(c.mintFractions(0, signer.address, 1));
    // same holder again -> balance slot now non-zero (warm)
    m.B_warm_warmAccount_amount10 = await gasOf(c.mintFractions(0, signer.address, 10));
    m.B_warm_warmAccount_amount500 = await gasOf(c.mintFractions(0, signer.address, 500));
  }

  // ---- B. production contract, cold balance slot, COLD recipient account -------
  {
    const c = await deployRealShare();
    await (await c.listProperty(0, 100_000_000, 'ipfs://p')).wait();
    const r = fresh();
    await (await c.approveKYC(r)).wait();
    m.C_cold_coldAccount_amount1 = await gasOf(c.mintFractions(0, r, 1));
  }

  // ---- C. calldata sensitivity: amount = 1 vs amount = 10000 -------------------
  // Same state shape, different non-zero byte count in the amount word.
  {
    const c = await deployRealShare();
    await (await c.listProperty(0, 100_000_000, 'ipfs://p')).wait();
    await (await c.approveKYC(signer.address)).wait();
    m.D_cold_warmAccount_amount10000 = await gasOf(c.mintFractions(0, signer.address, 10_000));
  }

  // ---- D. neutral benchmark contract (used by the cross-standard benchmark) ----
  {
    const F = await hre.ethers.getContractFactory('BenchERC1155');
    const b = await F.deploy();
    await b.waitForDeployment();
    m.E_bench_cold_warmAccount_amount1 = await gasOf(b.mintSingle(0, signer.address, 1));
    // id 0 keeps the calldata identical to the published Benchmark A measurement
    const b2 = await (await hre.ethers.getContractFactory('BenchERC1155')).deploy();
    await b2.waitForDeployment();
    m.E_bench_cold_coldAccount_amount1 = await gasOf(b2.mintSingle(0, fresh(), 1));
  }

  // ---- derived deltas ----------------------------------------------------------
  const d = {
    coldToWarmBalanceSlot:
      m.A_cold_warmAccount_amount1 - m.B_warm_warmAccount_amount10,
    coldRecipientAccountSurcharge:
      m.C_cold_coldAccount_amount1 - m.A_cold_warmAccount_amount1,
    calldataAmount1To10000:
      m.D_cold_warmAccount_amount10000 - m.A_cold_warmAccount_amount1,
    productionGuardOverhead:
      m.A_cold_warmAccount_amount1 - m.E_bench_cold_warmAccount_amount1,
  };

  // ---- published figures this reconciles ---------------------------------------
  const published = {
    'Exp 2, mint 1 fraction (Table IV)': 81086,
    'Exp 2, mint 10/50/100 fractions (Table IV)': 46886,
    'Exp 3, ERC-1155 mint 1/10/50 (Table V)': 83586,
    'Exp 11 Benchmark A, ERC-1155 (flat)': 52591,
    'Exp 4, Sepolia mintFractions (Table X)': 81098,
    'Exp 4, Amoy mintFractions (Table X)': 101258,
  };

  console.log('--- measured ---');
  for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(36)} ${v}`);
  console.log('--- derived deltas ---');
  for (const [k, v] of Object.entries(d)) console.log(`  ${k.padEnd(36)} ${v > 0 ? '+' : ''}${v}`);

  console.log('--- reconciliation against published figures ---');
  const checks = [
    ['Exp 2 mint 1 == A', m.A_cold_warmAccount_amount1, 81086],
    ['Exp 2 mint 10 == B', m.B_warm_warmAccount_amount10, 46886],
    ['Exp 3 mint == C (cold account)', m.C_cold_coldAccount_amount1, 83586],
    ['Exp 11 Bench A == E (cold acct)', m.E_bench_cold_coldAccount_amount1, 52591],
  ];
  let pass = 0;
  for (const [label, got, want] of checks) {
    const ok = got === want;
    pass += ok ? 1 : 0;
    console.log(`  ${ok ? 'MATCH  ' : 'DIFFERS'} ${label.padEnd(34)} measured=${got} published=${want}`);
  }
  console.log(`  ${pass}/${checks.length} published figures reproduced exactly`);

  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `reconciliation_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({
    experiment: 'gas_reconciliation',
    timestamp: new Date().toISOString(),
    note: 'isolates contract-under-test, balance-slot state, recipient-account state and calldata',
    measured: m, deltas: d, publishedFigures: published,
    reproducedExactly: `${pass}/${checks.length}`,
  }, null, 2));
  console.log(`\nwrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
