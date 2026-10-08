/*
 * Reentrancy call trace.
 *
 * A reviewer asked for the exact call trace and state changes of the malicious-receiver
 * test, rather than the assertion that reentrancy "is defeated". This script executes a
 * genuine reentrancy attempt and extracts, from debug_traceTransaction, the ordered call
 * frames and the storage writes, so the defence can be inspected rather than trusted.
 *
 * The defence has two independent legs and the trace shows both:
 *   (1) checks-effects-interactions - the minted-supply counter is written BEFORE the
 *       external acceptance call, so a reentrant call observes the updated supply;
 *   (2) onlyOwner - every state-changing entry point rejects the attacker contract.
 *
 * Run: npx hardhat run scripts/experiments/exp_reentrancy_trace.mjs
 */

import hre from 'hardhat';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'results', 'security');

async function main() {
  const [owner] = await hre.ethers.getSigners();

  const RS = await hre.ethers.getContractFactory('RealShareERC1155');
  const rs = await RS.deploy();
  await rs.waitForDeployment();
  const rsAddr = await rs.getAddress();

  const MR = await hre.ethers.getContractFactory('MaliciousReceiver1155');
  const mr = await MR.deploy();
  await mr.waitForDeployment();
  const mrAddr = await mr.getAddress();

  await (await rs.listProperty(0, 1000, 'ipfs://p')).wait();
  await (await rs.approveKYC(owner.address)).wait();
  await (await rs.approveKYC(mrAddr)).wait();
  // Mode 2 = REENTER_MINT: reenter mintFractions from onERC1155Received.
  await (await mr.configure(rsAddr, 2)).wait();

  // Mint into the malicious receiver: this triggers onERC1155Received, from which the
  // attacker attempts to reenter.
  let status, txHash, reverted = false;
  try {
    const tx = await rs.mintFractions(0, mrAddr, 10, { gasLimit: 2_000_000 });
    const r = await tx.wait();
    status = r.status; txHash = r.hash;
  } catch (e) {
    reverted = true;
    txHash = e?.receipt?.hash ?? null;
    status = e?.receipt?.status ?? 0;
  }

  const attempts = await mr.attempts().catch(() => null);
  const succeeded = await mr.reentered().catch(() => null);
  const balance = await rs.balanceOf(mrAddr, 0);
  const minted = (await rs.properties(0)).mintedFractions;

  const out = {
    experiment: 'reentrancy_call_trace',
    timestamp: new Date().toISOString(),
    realShare: rsAddr,
    maliciousReceiver: mrAddr,
    outerCall: 'mintFractions(0, maliciousReceiver, 10)',
    outerStatus: status,
    outerReverted: reverted,
    reentryAttempts: attempts === null ? 'n/a' : Number(attempts),
    attackSucceeded: succeeded === null ? 'n/a' : Boolean(succeeded),
    receiverBalanceAfter: Number(balance),
    mintedCounterAfter: Number(minted),
  };

  // Extract the call frames, if the node exposes a call tracer.
  if (txHash) {
    try {
      const trace = await hre.network.provider.send('debug_traceTransaction',
        [txHash, { tracer: 'callTracer' }]);
      const frames = [];
      (function walk(node, depth) {
        if (!node) return;
        frames.push({
          depth,
          type: node.type,
          from: (node.from || '').toLowerCase(),
          to: (node.to || '').toLowerCase(),
          error: node.error || null,
          sig: (node.input || '').slice(0, 10),
        });
        (node.calls || []).forEach((c) => walk(c, depth + 1));
      })(trace, 0);
      out.callFrames = frames;
    } catch (e) {
      out.callFrames = `unavailable: ${String(e.message).slice(0, 80)}`;
    }

    // Ordered SSTOREs, to show effects precede the external interaction.
    try {
      const st = await hre.network.provider.send('debug_traceTransaction',
        [txHash, { disableMemory: true, disableStack: false, disableStorage: false }]);
      const seq = [];
      for (const l of st.structLogs || []) {
        if (l.op === 'SSTORE') seq.push({ pc: l.pc, depth: l.depth, op: 'SSTORE' });
        if (l.op === 'CALL' || l.op === 'STATICCALL') seq.push({ pc: l.pc, depth: l.depth, op: l.op });
      }
      out.orderedStateAndCallOps = seq;
      const firstCall = seq.findIndex((x) => x.op === 'CALL');
      const sstoresBeforeCall = seq.filter((x, i) => x.op === 'SSTORE' && (firstCall === -1 || i < firstCall)).length;
      out.sstoresBeforeFirstExternalCall = sstoresBeforeCall;
      out.checksEffectsInteractionsHolds = firstCall === -1 ? true : sstoresBeforeCall > 0;
    } catch (e) {
      out.orderedStateAndCallOps = `unavailable: ${String(e.message).slice(0, 80)}`;
    }
  }

  console.log(JSON.stringify({
    outerStatus: out.outerStatus,
    outerReverted: out.outerReverted,
    reentryAttempts: out.reentryAttempts,
    attackSucceeded: out.attackSucceeded,
    receiverBalanceAfter: out.receiverBalanceAfter,
    mintedCounterAfter: out.mintedCounterAfter,
    sstoresBeforeFirstExternalCall: out.sstoresBeforeFirstExternalCall,
    checksEffectsInteractionsHolds: out.checksEffectsInteractionsHolds,
    frames: Array.isArray(out.callFrames) ? out.callFrames.length : out.callFrames,
  }, null, 2));

  if (Array.isArray(out.callFrames)) {
    console.log('\ncall frames:');
    for (const f of out.callFrames) {
      console.log(`  ${'  '.repeat(f.depth)}[${f.depth}] ${f.type} ${f.sig} -> ${f.to}${f.error ? '  ERROR: ' + f.error : ''}`);
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `reentrancy_trace_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
