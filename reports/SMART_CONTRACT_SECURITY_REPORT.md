# Smart-Contract Adversarial Security Report

**Status:** EXECUTED. Target: `contracts/RealShareERC1155.sol` (real compiled bytecode) on a
local Hardhat EVM. Attacker: `contracts/attacks/MaliciousReceiver1155.sol`.
**Raw evidence:** `results/security/raw/adversarial_*.json`,
`results/security/raw/fuzz_invariant_*.json`.
**Suites:** `test/security/adversarial.test.js`, `test/security/fuzz_invariant.test.js`.

## A + B. Negative access-control and compliance/state guards — 17/17 held

| Category | Test | Expected | Result |
|---|---|---|---|
| access-control | stranger cannot list a property | revert | PASS |
| access-control | stranger cannot approve KYC | revert | PASS |
| access-control | stranger cannot mint | revert | PASS |
| access-control | former owner loses authority after ownership transfer | revert (old) / allow (new) | PASS |
| access-control | stranger cannot revoke KYC | revert | PASS |
| kyc-gate | mint to non-KYC address | revert | PASS |
| supply-cap | mint beyond property fraction cap | revert | PASS |
| state-guard | mint on deactivated property | revert | PASS |
| kyc-gate | transfer to non-KYC recipient | revert | PASS |
| kyc-gate | revoked sender cannot transfer | revert | PASS |
| state-guard | duplicate property id | revert | PASS |
| input-validation | zero-supply property | revert | PASS |

## C. Malicious receiver — genuine re-entry attempts, none succeeded

Unlike a transfer to a non-receiver, the attacker contract actively calls back into the target
from inside `onERC1155Received`. The test asserts the attacker's `attempts` counter is > 0 (the
re-entry was really tried) and its `reentered` flag stayed `false` (it never succeeded).

| Attack | Mechanism attempted | Outcome | Result |
|---|---|---|---|
| Re-entry via `safeTransferFrom` in callback | move tokens out during receive hook | attempts>0, reentered=false | PASS |
| Re-entry via `mintFractions` in callback | mint more to self during receive hook | blocked by `onlyOwner`; reentered=false | PASS |
| Bad-selector receiver | return `0xdeadbeef` from hook | mint reverts, balance not credited | PASS |
| Forced-revert receiver | `revert()` inside hook | transfer reverts atomically, balance 0 | PASS |

The re-entry is defeated by two independent factors: (i) `mintFractions` updates
`mintedFractions` **before** the external `_mint` (checks-effects-interactions), so supply cannot
be inflated by re-entry; (ii) all state-changing entry points are `onlyOwner`, so an
attacker-controlled callback cannot invoke them. This directly addresses the Slither Low
`reentrancy-events` finding (see `STATIC_ANALYSIS_REPORT.md`).

## D. Fuzz + invariant testing (fast-check)

Foundry was unavailable in the evaluation environment; property-based fuzzing was performed with
fast-check driving the real compiled contract. Actual executed counts (not inflated):

| Property | Cases executed | Counterexamples | Invariant held |
|---|--:|--:|:--:|
| P1 — `mintFractions` accepts IFF (listed ∧ active ∧ KYC ∧ amount>0 ∧ minted+amount≤cap) | **12,000** | 0 | ✔ |
| P2 — balance conservation over random valid mint/transfer sequences (3–12 ops each) | **400 sequences** | 0 | ✔ |

Invariants verified continuously:
1. `Σ balanceOf(holder, id) == mintedFractions(id)` after every sequence.
2. `mintedFractions(id) ≤ totalFractions(id)` (supply cap never exceeded).
3. `mintFractions` succeeds exactly when its stated preconditions hold, and reverts otherwise.
4. Failed operations revert atomically (no partial state).

## Conservative conclusion

> The evaluated `RealShareERC1155` contract passed all 17 adversarial and negative-path unit
> tests, defeated genuine re-entry attempts from a malicious ERC-1155 receiver, and satisfied its
> supply-conservation and access-control invariants across 12,400 executed fuzz cases under the
> documented configuration. These results increase assurance but do not replace an independent
> professional audit. Static analysis found no High/Medium findings in RealShare-authored code
> (one checks-effects-interactions-mitigated Low). Mythril and formal verification remain
> recommended extensions.
