/*
 * Extended invariant tests requested in review.
 *
 * The retained suite established that mintFractions succeeds iff its preconditions
 * hold and that supply is conserved. A reviewer asked for invariants that are harder
 * to satisfy accidentally, specifically:
 *
 *   I1  KYC revocation cannot be bypassed by transaction ordering. If a revocation
 *       and a transfer land in the SAME block with the revocation ordered first, the
 *       transfer must fail. This is the front-running case: a holder who observes a
 *       pending revocation must not be able to escape it by racing.
 *   I2  Batch transfers are atomic. safeBatchTransferFrom must move every identifier
 *       or none; a batch containing one disallowed identifier must leave all balances
 *       unchanged.
 *   I3  Revocation is effective for the sender as well as the recipient.
 *   I4  Randomised sequences of list / KYC / mint / revoke / transfer preserve
 *       supply conservation and never permit a transfer touching a non-KYC party.
 *
 * Automine is disabled for I1 so that transaction ordering within a block is under
 * test rather than under Hardhat's control.
 *
 * Run: npx hardhat run scripts/experiments/exp_invariants_extended.mjs
 */

import hre from 'hardhat';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'results', 'security');

const results = [];
const record = (id, name, passed, detail) => {
  results.push({ id, name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  -- ' + detail : ''}`);
};

async function deploy() {
  const F = await hre.ethers.getContractFactory('RealShareERC1155');
  const c = await F.deploy();
  await c.waitForDeployment();
  return c;
}

async function main() {
  const signers = await hre.ethers.getSigners();
  const [owner, alice, bob] = signers;

  // ---------------- I1: revocation cannot be out-raced within a block -----------
  {
    const c = await deploy();
    await (await c.listProperty(0, 1000, 'ipfs://p')).wait();
    await (await c.approveKYC(owner.address)).wait();
    await (await c.approveKYC(alice.address)).wait();
    await (await c.mintFractions(0, alice.address, 100)).wait();

    const before = await c.balanceOf(alice.address, 0);

    // Same block: revocation first, transfer second.
    await hre.network.provider.send('evm_setAutomine', [false]);
    const revokeTx = await c.revokeKYC(alice.address);
    const transferTx = await c.connect(alice)
      .safeTransferFrom(alice.address, owner.address, 0, 10, '0x', { gasLimit: 300000 });
    await hre.network.provider.send('evm_mine');
    await hre.network.provider.send('evm_setAutomine', [true]);

    const rRev = await hre.ethers.provider.getTransactionReceipt(revokeTx.hash);
    const rXfer = await hre.ethers.provider.getTransactionReceipt(transferTx.hash);
    const after = await c.balanceOf(alice.address, 0);

    const sameBlock = rRev.blockNumber === rXfer.blockNumber;
    const revokeFirst = rRev.index < rXfer.index;
    const transferFailed = rXfer.status === 0;
    const balanceUnchanged = before === after;

    record('I1', 'KYC revocation not bypassable by same-block ordering',
      sameBlock && revokeFirst && transferFailed && balanceUnchanged,
      `sameBlock=${sameBlock} revokeFirst=${revokeFirst} transferStatus=${rXfer.status} balance ${before}->${after}`);
  }

  // ---------------- I2: batch transfer atomicity -------------------------------
  {
    const c = await deploy();
    await (await c.listProperty(0, 1000, 'ipfs://a')).wait();
    await (await c.listProperty(1, 1000, 'ipfs://b')).wait();
    await (await c.approveKYC(owner.address)).wait();
    await (await c.approveKYC(alice.address)).wait();
    await (await c.mintFractions(0, owner.address, 100)).wait();
    await (await c.mintFractions(1, owner.address, 100)).wait();
    // make identifier 1 disallowed
    await (await c.deactivateProperty(1)).wait();

    const b0 = await c.balanceOf(owner.address, 0);
    const b1 = await c.balanceOf(owner.address, 1);
    const a0 = await c.balanceOf(alice.address, 0);

    let reverted = false;
    try {
      await (await c.safeBatchTransferFrom(
        owner.address, alice.address, [0, 1], [10, 10], '0x', { gasLimit: 400000 })).wait();
    } catch { reverted = true; }

    const b0b = await c.balanceOf(owner.address, 0);
    const b1b = await c.balanceOf(owner.address, 1);
    const a0b = await c.balanceOf(alice.address, 0);
    const noPartial = b0 === b0b && b1 === b1b && a0 === a0b;

    record('I2', 'Batch transfer is atomic (no partial success)',
      reverted && noPartial,
      `reverted=${reverted} balances unchanged=${noPartial}`);
  }

  // ---------------- I3: revocation binds the sender too ------------------------
  {
    const c = await deploy();
    await (await c.listProperty(0, 1000, 'ipfs://p')).wait();
    await (await c.approveKYC(owner.address)).wait();
    await (await c.approveKYC(alice.address)).wait();
    await (await c.mintFractions(0, owner.address, 50)).wait();
    await (await c.revokeKYC(owner.address)).wait();   // sender loses KYC

    let reverted = false;
    try {
      await (await c.safeTransferFrom(owner.address, alice.address, 0, 5, '0x',
        { gasLimit: 300000 })).wait();
    } catch { reverted = true; }
    record('I3', 'Revoked sender cannot transfer', reverted, `reverted=${reverted}`);
  }

  // ---------------- I4: randomised sequences preserve invariants ---------------
  {
    const c = await deploy();
    const CAP = 1_000_000;
    await (await c.listProperty(0, CAP, 'ipfs://p')).wait();
    const parties = [owner, alice, bob];
    for (const p of parties) await (await c.approveKYC(p.address)).wait();

    let minted = 0n;
    let violations = 0;
    const kyc = new Map(parties.map((p) => [p.address, true]));
    const rnd = (n) => Math.floor(Math.random() * n);

    for (let step = 0; step < 120; step++) {
      const op = rnd(4);
      const p = parties[rnd(parties.length)];
      try {
        if (op === 0) {
          const amt = 1 + rnd(100);
          await (await c.mintFractions(0, p.address, amt)).wait();
          minted += BigInt(amt);
        } else if (op === 1) {
          await (await c.revokeKYC(p.address)).wait();
          kyc.set(p.address, false);
        } else if (op === 2) {
          await (await c.approveKYC(p.address)).wait();
          kyc.set(p.address, true);
        } else {
          const q = parties[rnd(parties.length)];
          const bal = await c.balanceOf(p.address, 0);
          if (bal > 0n) {
            const amt = 1n;
            const allowed = kyc.get(p.address) && kyc.get(q.address);
            try {
              await (await c.connect(p).safeTransferFrom(
                p.address, q.address, 0, amt, '0x', { gasLimit: 300000 })).wait();
              // a transfer that succeeded must have had both parties KYC-approved
              if (!allowed) violations++;
            } catch {
              // a transfer that failed while both parties were approved and the
              // balance sufficed would also be a violation
              if (allowed && bal >= amt) violations++;
            }
          }
        }
      } catch {
        /* guarded operations may legitimately revert */
      }
    }

    let sum = 0n;
    for (const p of parties) sum += await c.balanceOf(p.address, 0);
    const conserved = sum === minted;
    record('I4', 'Randomised sequences: supply conserved, KYC gate never bypassed',
      conserved && violations === 0,
      `steps=120 sum=${sum} minted=${minted} kycViolations=${violations}`);
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} extended invariants hold`);

  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, `extended_invariants_${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({
    experiment: 'extended_invariants',
    timestamp: new Date().toISOString(),
    passed: `${passed}/${results.length}`,
    results,
  }, null, 2));
  console.log(`wrote ${f}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
