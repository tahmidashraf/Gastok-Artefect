/*
 * Fit and validate the per-opcode repricing model.
 *
 *   Stage 1 (fit)      : least-squares fit of the per-chain gas difference against
 *                        the opcode counts of the synthetic probes. Probe counts
 *                        are known by construction, not inferred.
 *   Stage 2 (validate) : apply the fitted coefficients to the opcode census of the
 *                        REAL RealShare operations and compare the prediction with
 *                        the cross-chain differences actually observed on-chain in
 *                        Experiment 4. This is out-of-sample: no real transaction
 *                        contributes to the fit.
 *
 * Run: node scripts/experiments/analyse_fingerprint.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'results', 'gas-fingerprint');

// Opcode counts of each probe, known by construction from GasProbes.sol.
// [coldSload, coldSstore, coldAccount, log, warmSstore]
const PROBE_COUNTS = {
  ProbeBaseline:      [0, 0, 0, 0, 0],
  ProbeColdSstore1:   [0, 1, 0, 0, 0],
  ProbeColdSstore2:   [0, 2, 0, 0, 0],
  ProbeColdSstore4:   [0, 4, 0, 0, 0],
  ProbeColdSstore8:   [0, 8, 0, 0, 0],
  ProbeColdSstore16:  [0, 16, 0, 0, 0],
  ProbeWarmSstore4:   [0, 1, 0, 0, 4],
  ProbeWarmSstore16:  [0, 1, 0, 0, 16],
  ProbeColdSload8:    [8, 1, 0, 0, 0],
  ProbeColdSload32:   [32, 1, 0, 0, 0],
  ProbeLog4:          [0, 0, 0, 4, 0],
  ProbeLog16:         [0, 0, 0, 16, 0],
  ProbeColdAccount8:  [0, 1, 8, 0, 0],
  ProbeColdAccount32: [0, 1, 32, 0, 0],
  ProbeKeccak64:      [0, 1, 0, 0, 0],
  ProbeMemory:        [0, 1, 0, 0, 0],
};
const TERMS = ['cold SLOAD', 'cold SSTORE', 'cold account', 'LOG1', 'warm SSTORE'];

function latestFile(prefix) {
  const fs_ = fs.readdirSync(DIR).filter((f) => f.startsWith(prefix)).sort();
  if (!fs_.length) throw new Error(`no ${prefix}* in ${DIR}`);
  return path.join(DIR, fs_[fs_.length - 1]);
}

// Ordinary least squares via normal equations with Gaussian elimination.
function lstsq(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k + 1 }, (_, j) =>
      j < k ? X.reduce((s, r, m) => s + r[i] * r[j], 0)
            : X.reduce((s, r, m) => s + r[i] * y[m], 0)));
  for (let i = 0; i < k; i++) {
    let p = i;
    for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-9) continue;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < k; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= k; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-9 ? 0 : row[k] / row[i]));
}

const main = () => {
  const fp = JSON.parse(fs.readFileSync(latestFile('exact_'), 'utf8'));
  const census = JSON.parse(fs.readFileSync(latestFile('opcode_census_'), 'utf8'));

  console.log(`fingerprint: ${path.basename(latestFile('exact_'))}`);
  console.log(`validation vs local receipts: ${fp.validationAgainstLocalReceipts?.agree}\n`);

  const report = { generated: new Date().toISOString(), chains: {} };

  for (const [chainName, probeDeltas] of Object.entries(fp.deltaVsBaseline)) {
    const names = Object.keys(probeDeltas).filter((n) => PROBE_COUNTS[n]);
    const X = names.map((n) => PROBE_COUNTS[n]);
    const y = names.map((n) => probeDeltas[n].delta);

    const maxAbs = Math.max(...y.map(Math.abs));
    if (maxAbs === 0) {
      console.log(`=== ${chainName} ===\n  identical to baseline on all ${names.length} probes (zero divergence)\n`);
      report.chains[chainName] = { verdict: 'schedule-identical', probes: names.length, maxAbsDelta: 0 };
      continue;
    }

    const beta = lstsq(X, y);
    const pred = X.map((r) => r.reduce((s, v, i) => s + v * beta[i], 0));
    const ssRes = y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
    const ybar = y.reduce((a, b) => a + b, 0) / y.length;
    const ssTot = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    const maxRes = Math.max(...y.map((v, i) => Math.abs(v - pred[i])));

    console.log(`=== ${chainName} ===`);
    beta.forEach((b, i) => {
      if (Math.abs(b) > 1) console.log(`  ${TERMS[i].padEnd(14)} ${b >= 0 ? '+' : ''}${b.toFixed(1)} gas`);
    });
    console.log(`  R^2 = ${r2.toFixed(6)}   max residual = ${maxRes.toFixed(1)} gas`);

    report.chains[chainName] = {
      verdict: 'schedule-divergent',
      coefficients: Object.fromEntries(TERMS.map((t, i) => [t, Math.round(beta[i] * 10) / 10])),
      r2, maxResidual: maxRes,
    };

    // ---- out-of-sample validation on real on-chain operations --------------
    const obs = census.observedOnChainDelta || {};
    const rows = [census.deploy, ...census.operations].filter((o) => obs[o.label] != null);
    if (rows.length && chainName === 'Polygon Amoy') {
      console.log('\n  out-of-sample validation against Experiment 4 on-chain receipts:');
      let exact = 0;
      const vrows = rows.map((o) => {
        const c = o.counts;
        const v = [c.coldSload, c.coldSstore, c.coldAccount, c.log, c.warmSstore];
        const p = v.reduce((s, x, i) => s + x * beta[i], 0);
        const observed = obs[o.label];
        const hit = Math.round(p) === observed;
        if (hit) exact++;
        console.log(`    ${o.label.padEnd(18)} pred=${Math.round(p).toString().padStart(7)}  obs=${String(observed).padStart(7)}  ${hit ? 'EXACT' : 'resid ' + (observed - Math.round(p))}`);
        return { op: o.label, counts: v, predicted: Math.round(p), observed, exact: hit };
      });
      console.log(`    exact on ${exact}/${vrows.length} real operations`);
      report.chains[chainName].outOfSample = { exact: `${exact}/${vrows.length}`, rows: vrows };
    }
    console.log();
  }

  const f = path.join(DIR, `model_report_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(report, null, 2));
  console.log(`wrote ${f}`);
};

main();
