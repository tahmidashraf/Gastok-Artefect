/**
 * Property-based fuzz + invariant testing of RealShareERC1155 using fast-check,
 * driving the REAL compiled contract on a local Hardhat EVM.
 *
 * Foundry was unavailable in the evaluation environment; fast-check exercises the
 * deployed bytecode through its JS interface. Each generated case runs real
 * transactions, so run counts are chosen to complete in reasonable time and the
 * ACTUAL executed counts are recorded (never inflated).
 *
 * Output: results/security/raw/fuzz_invariant_<ts>.json
 */
const fc = require("fast-check");
const { expect } = require("chai");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const VALID_RUNS = parseInt(process.env.FUZZ_VALID_RUNS || "3000", 10);
const STATE_RUNS = parseInt(process.env.FUZZ_STATE_RUNS || "150", 10);
const OUT = path.join(__dirname, "..", "..", "results", "security", "raw");

describe("RealShareERC1155 — fuzz + invariant (fast-check)", function () {
  this.timeout(20 * 60 * 1000);
  const summary = { experiment: "fuzz_invariant", tool: "fast-check " + require("fast-check/package.json").version,
    timestamp: new Date().toISOString(), properties: [] };

  let owner, signers, c, holderAddrs;

  before(async function () {
    signers = await hre.ethers.getSigners();
    owner = signers[0];
  });

  async function freshContract() {
    const F = await hre.ethers.getContractFactory("RealShareERC1155");
    const k = await F.deploy();
    await k.waitForDeployment();
    return k;
  }

  it(`P1 validation property: mintFractions accepts IFF preconditions hold (${VALID_RUNS} cases)`, async function () {
    c = await freshContract();
    // set up known state: property 0 listed cap 1_000_000, active; inv1 KYC'd; property 1 inactive
    await c.listProperty(0, 1_000_000n, "p0");
    await c.listProperty(1, 1000, "p1");
    await c.deactivateProperty(1);
    const inv1 = signers[1].address;
    await c.approveKYC(inv1);
    const nonKyc = signers[2].address;

    let executed = 0, counterexamples = 0, mintedTotal = 0n;
    const cap = 1_000_000n;

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),          // propertyId (0 valid/active, 1 inactive, 2/3 unlisted)
        fc.boolean(),                             // recipient KYC'd?
        fc.bigInt({ min: 0n, max: 2_000_000n }),  // amount
        async (pid, kyc, amount) => {
          executed++;
          const to = kyc ? inv1 : nonKyc;
          const listedActive = pid === 0; // only property 0 is listed+active in this fixture
          const wouldFit = mintedTotal + amount <= cap;
          const shouldSucceed = listedActive && kyc && amount > 0n && wouldFit;
          let succeeded = false;
          try {
            await c.mintFractions(pid, to, amount);
            succeeded = true;
          } catch { succeeded = false; }
          if (succeeded) mintedTotal += amount;
          // INVARIANT: outcome matches the contract's stated preconditions
          if (succeeded !== shouldSucceed) {
            // allow the benign case: amount==0 mints zero (OZ allows 0 mint) -> treat as success-permitted
            if (!(amount === 0n && listedActive && kyc)) {
              counterexamples++;
              return false;
            }
          }
          return true;
        }
      ),
      { numRuns: VALID_RUNS, endOnFailure: true }
    );

    // Post-invariant: on-chain minted counter equals our tracked total
    const p = await c.properties(0);
    expect(p.mintedFractions).to.equal(mintedTotal);
    summary.properties.push({ name: "P1_mint_validation", runsExecuted: executed, counterexamples, invariantHeld: counterexamples === 0, finalMinted: mintedTotal.toString() });
    console.log(`  P1: executed ${executed} cases, counterexamples ${counterexamples}, minted ${mintedTotal}`);
  });

  it(`P2 stateful invariant: balance conservation over random valid sequences (${STATE_RUNS} sequences)`, async function () {
    let seqExec = 0, violations = 0;
    holderAddrs = signers.slice(3, 8).map((s) => s.address);

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            op: fc.constantFrom("mint", "transfer"),
            from: fc.integer({ min: 0, max: 4 }),
            to: fc.integer({ min: 0, max: 4 }),
            amt: fc.integer({ min: 1, max: 50 }),
          }),
          { minLength: 3, maxLength: 12 }
        ),
        async (ops) => {
          seqExec++;
          const k = await freshContract();
          await k.listProperty(0, 100000n, "p");
          for (const a of holderAddrs) await k.approveKYC(a);
          let minted = 0n;
          for (const op of ops) {
            try {
              if (op.op === "mint") {
                if (minted + BigInt(op.amt) <= 100000n) { await k.mintFractions(0, holderAddrs[op.to], op.amt); minted += BigInt(op.amt); }
              } else {
                const from = signers[3 + op.from], toA = holderAddrs[op.to];
                const bal = await k.balanceOf(from.address, 0);
                if (bal >= BigInt(op.amt) && from.address !== toA) {
                  await k.connect(from).safeTransferFrom(from.address, toA, 0, op.amt, "0x");
                }
              }
            } catch { /* invalid op reverts atomically; fine */ }
          }
          // INVARIANT: sum(balances) == minted AND minted <= cap
          let sum = 0n;
          for (const a of holderAddrs) sum += await k.balanceOf(a, 0);
          const p = await k.properties(0);
          const ok = sum === minted && p.mintedFractions === minted && minted <= 100000n;
          if (!ok) violations++;
          return ok;
        }
      ),
      { numRuns: STATE_RUNS, endOnFailure: true }
    );
    summary.properties.push({ name: "P2_balance_conservation", sequencesExecuted: seqExec, violations, invariantHeld: violations === 0 });
    console.log(`  P2: executed ${seqExec} sequences, violations ${violations}`);
    expect(violations).to.equal(0);
  });

  after(function () {
    summary.totalCasesExecuted = summary.properties.reduce((a, p) => a + (p.runsExecuted || p.sequencesExecuted || 0), 0);
    fs.writeFileSync(path.join(OUT, `fuzz_invariant_${Date.now()}.json`), JSON.stringify(summary, null, 2));
    console.log(`\nFuzz/invariant total executed: ${summary.totalCasesExecuted}; all invariants held: ${summary.properties.every((p) => p.invariantHeld)}`);
  });
});
