/**
 * Adversarial + negative-path + invariant tests for RealShareERC1155.
 * Runs on the local Hardhat EVM against the real deployed contract bytecode.
 * Emits a machine-readable summary to results/security/raw/adversarial_<ts>.json.
 */
const { expect } = require("chai");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const record = { experiment: "adversarial_contract_tests", timestamp: new Date().toISOString(), cases: [] };
function log(name, category, expected, passed, detail) {
  record.cases.push({ name, category, expected, passed, detail });
}
const AddressZero = "0x0000000000000000000000000000000000000000";

async function deploy() {
  const F = await hre.ethers.getContractFactory("RealShareERC1155");
  const c = await F.deploy();
  await c.waitForDeployment();
  return c;
}

describe("RealShareERC1155 — adversarial suite", function () {
  let owner, minter, kyc, stranger, inv1, inv2, c;

  beforeEach(async function () {
    [owner, minter, kyc, stranger, inv1, inv2] = await hre.ethers.getSigners();
    c = await deploy();
    await c.listProperty(0, 1000, "ipfs://p0");
    await c.listProperty(1, 500, "ipfs://p1");
    await c.approveKYC(inv1.address);
    await c.approveKYC(inv2.address);
  });

  // ---------------- A. Negative access control ----------------
  describe("A. Negative access control", function () {
    it("stranger cannot list a property", async function () {
      let blocked = false;
      try { await c.connect(stranger).listProperty(9, 100, "x"); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("stranger listProperty", "access-control", "revert", blocked, "onlyOwner");
    });
    it("stranger cannot approve KYC", async function () {
      let blocked = false;
      try { await c.connect(stranger).approveKYC(stranger.address); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("stranger approveKYC", "access-control", "revert", blocked, "onlyOwner");
    });
    it("stranger cannot mint", async function () {
      let blocked = false;
      try { await c.connect(stranger).mintFractions(0, inv1.address, 10); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("stranger mintFractions", "access-control", "revert", blocked, "onlyOwner");
    });
    it("former owner loses authority after ownership transfer", async function () {
      await c.transferOwnership(minter.address);
      let blocked = false;
      try { await c.connect(owner).mintFractions(0, inv1.address, 10); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("former owner mint after transfer", "access-control", "revert", blocked, "Ownable transfer revokes old owner");
      // new owner CAN mint
      await c.connect(minter).approveKYC(inv1.address);
      await c.connect(minter).mintFractions(0, inv1.address, 10);
      expect(await c.balanceOf(inv1.address, 0)).to.equal(10n);
    });
    it("stranger cannot revoke KYC", async function () {
      let blocked = false;
      try { await c.connect(stranger).revokeKYC(inv1.address); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("stranger revokeKYC", "access-control", "revert", blocked, "onlyOwner");
    });
  });

  // ---------------- B. Compliance / state guards ----------------
  describe("B. Compliance and state guards", function () {
    it("cannot mint to a non-KYC address", async function () {
      let blocked = false;
      try { await c.mintFractions(0, stranger.address, 10); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("mint to non-KYC", "kyc-gate", "revert", blocked, "require(kycApproved[to])");
    });
    it("cannot mint beyond the property fraction cap", async function () {
      let blocked = false;
      try { await c.mintFractions(0, inv1.address, 1001); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("mint beyond cap", "supply-cap", "revert", blocked, "minted+amount<=totalFractions");
    });
    it("cannot mint on a deactivated property", async function () {
      await c.deactivateProperty(0);
      let blocked = false;
      try { await c.mintFractions(0, inv1.address, 10); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("mint on deactivated property", "state-guard", "revert", blocked, "require(active)");
    });
    it("cannot transfer to a non-KYC recipient", async function () {
      await c.mintFractions(0, inv1.address, 100);
      let blocked = false;
      try { await c.connect(inv1).safeTransferFrom(inv1.address, stranger.address, 0, 10, "0x"); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("transfer to non-KYC", "kyc-gate", "revert", blocked, "_update KYC check on recipient");
    });
    it("revoked sender cannot transfer", async function () {
      await c.mintFractions(0, inv1.address, 100);
      await c.revokeKYC(inv1.address);
      let blocked = false;
      try { await c.connect(inv1).safeTransferFrom(inv1.address, inv2.address, 0, 10, "0x"); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("revoked sender transfer", "kyc-gate", "revert", blocked, "_update KYC check on sender");
    });
    it("cannot list a duplicate property id", async function () {
      let blocked = false;
      try { await c.listProperty(0, 100, "dup"); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("duplicate property id", "state-guard", "revert", blocked, "require(!listed)");
    });
    it("cannot list a property with zero supply", async function () {
      let blocked = false;
      try { await c.listProperty(7, 0, "zero"); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("zero-supply property", "input-validation", "revert", blocked, "require(totalFractions>0)");
    });
  });

  // ---------------- C. Malicious receiver / re-entrancy ----------------
  describe("C. Malicious ERC-1155 receiver (genuine re-entry attempts)", function () {
    async function deployAttacker() {
      const F = await hre.ethers.getContractFactory("MaliciousReceiver1155");
      const a = await F.deploy();
      await a.waitForDeployment();
      return a;
    }
    const Mode = { NONE:0, REENTER_TRANSFER:1, REENTER_MINT:2, RECURSE:3, FORCE_REVERT:4, BAD_SELECTOR:5, GAS_BOMB:6 };

    it("re-entry via safeTransferFrom during onERC1155Received is blocked and never succeeds", async function () {
      const atk = await deployAttacker();
      await c.approveKYC(await atk.getAddress());
      await c.mintFractions(0, await atk.getAddress(), 50); // seed balance (owner mint)
      await atk.configure(await c.getAddress(), Mode.REENTER_TRANSFER);
      // Now transfer INTO the attacker so its callback fires and attempts re-entry.
      await c.mintFractions(0, inv1.address, 100);
      // inv1 transfers to attacker -> triggers callback -> attacker tries to re-enter transfer out
      await c.connect(inv1).safeTransferFrom(inv1.address, await atk.getAddress(), 0, 10, "0x");
      const attempts = await atk.attempts();
      const reentered = await atk.reentered();
      expect(reentered).to.equal(false);
      expect(attempts).to.be.greaterThan(0n);
      log("re-entry on receive (transfer)", "reentrancy", "attempted but never succeeds", reentered === false && attempts > 0n,
          `attempts=${attempts}, reentered=${reentered}`);
    });

    it("re-entry via mintFractions during callback is blocked by onlyOwner", async function () {
      const atk = await deployAttacker();
      await c.approveKYC(await atk.getAddress());
      await atk.configure(await c.getAddress(), Mode.REENTER_MINT);
      await c.mintFractions(0, inv1.address, 100);
      await c.connect(inv1).safeTransferFrom(inv1.address, await atk.getAddress(), 0, 10, "0x");
      const reentered = await atk.reentered();
      const attempts = await atk.attempts();
      expect(reentered).to.equal(false);
      log("re-entry mint on receive", "reentrancy", "attempted, blocked by onlyOwner", reentered === false && attempts > 0n,
          `attempts=${attempts}, reentered=${reentered}`);
    });

    it("bad-selector receiver causes the mint to revert (no silent loss)", async function () {
      const atk = await deployAttacker();
      await c.approveKYC(await atk.getAddress());
      await atk.configure(await c.getAddress(), Mode.BAD_SELECTOR);
      let blocked = false;
      try { await c.mintFractions(0, await atk.getAddress(), 10); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      log("bad selector receiver", "receiver-check", "revert (tokens not credited)", blocked, "ERC1155 acceptance check");
    });

    it("forced-revert receiver causes the transfer to revert atomically", async function () {
      const atk = await deployAttacker();
      await c.approveKYC(await atk.getAddress());
      await atk.configure(await c.getAddress(), Mode.FORCE_REVERT);
      let blocked = false;
      try { await c.mintFractions(0, await atk.getAddress(), 10); } catch { blocked = true; }
      expect(blocked).to.equal(true);
      const bal = await c.balanceOf(await atk.getAddress(), 0);
      expect(bal).to.equal(0n);
      log("forced revert receiver", "atomicity", "revert, balance unchanged", blocked && bal === 0n, "atomic revert");
    });
  });

  // ---------------- D. Invariants (explicit assertions over random sequences) ----------------
  describe("D. Invariants over randomized valid operations", function () {
    it("supply conservation and cap hold across a random mint/transfer sequence", async function () {
      const signers = await hre.ethers.getSigners();
      const holders = signers.slice(4, 9);
      for (const h of holders) await c.approveKYC(h.address);
      let minted0 = 0n;
      const cap0 = 1000n;
      // random mints within cap
      for (let i = 0; i < 20; i++) {
        const h = holders[Math.floor(Math.random() * holders.length)];
        const amt = BigInt(1 + Math.floor(Math.random() * 40));
        if (minted0 + amt <= cap0) {
          await c.mintFractions(0, h.address, amt);
          minted0 += amt;
        }
      }
      // random transfers among holders
      for (let i = 0; i < 20; i++) {
        const a = holders[Math.floor(Math.random() * holders.length)];
        const b = holders[Math.floor(Math.random() * holders.length)];
        const bal = await c.balanceOf(a.address, 0);
        if (a.address !== b.address && bal > 0n) {
          const amt = bal > 3n ? 3n : 1n;
          await c.connect(a).safeTransferFrom(a.address, b.address, 0, amt, "0x");
        }
      }
      // INVARIANT 1: sum of balances == minted
      let sum = 0n;
      for (const h of holders) sum += await c.balanceOf(h.address, 0);
      expect(sum).to.equal(minted0);
      // INVARIANT 2: minted <= cap
      const p = await c.properties(0);
      expect(p.mintedFractions).to.be.lessThanOrEqual(cap0);
      expect(p.mintedFractions).to.equal(minted0);
      log("supply conservation invariant", "invariant", "sum(balances)==minted<=cap", sum === minted0 && p.mintedFractions <= cap0,
          `sum=${sum}, minted=${minted0}, cap=${cap0}`);
    });
  });

  after(function () {
    const dir = path.join(__dirname, "..", "..", "results", "security", "raw");
    const passed = record.cases.filter((x) => x.passed).length;
    record.summary = { total: record.cases.length, passed, failed: record.cases.length - passed };
    fs.writeFileSync(path.join(dir, `adversarial_${Date.now()}.json`), JSON.stringify(record, null, 2));
    console.log(`\nAdversarial summary: ${passed}/${record.cases.length} guards held`);
  });
});
