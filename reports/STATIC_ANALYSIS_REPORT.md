# Static Analysis Report

**Status:** EXECUTED. Tools: Slither 0.11.5, solhint 6.2.3, `npm audit`. Mythril was not run
(requires a container runtime unavailable in the evaluation environment).
**Raw evidence:** `results/security/raw/slither_realshare1155.json` (3.4 MB full JSON),
`results/security/raw/slither_realshare1155.txt`, `results/security/raw/solhint.txt`.
**Target:** `contracts/RealShareERC1155.sol` and the benchmark/baseline contracts, compiled with
solc 0.8.27 through the Hardhat project (20 contracts including OpenZeppelin dependencies).

## Slither summary

Across all 20 compiled contracts, Slither reported: **1 High, 9 Medium, 1 Low, 75 Informational.**
Restricting to **RealShare-authored contracts** (excluding OpenZeppelin library code):

| Severity | Count (own code) | Detail |
|---|--:|---|
| High | 0 | — |
| Medium | 0 | — |
| Low | 1 | `reentrancy-events` in `mintFractions`: `_mint` (external `onERC1155Received` callback) precedes the `FractionsMinted` event emission |
| Informational | 2 | `pragma` (multiple ^0.8.x versions across the dependency tree) and `solc-version` (generic ^0.8.20 advisory) |

### Classification of the Low finding (`reentrancy-events`)

- **Classification:** true positive, accepted / mitigated.
- **Analysis:** `mintFractions` performs `p.mintedFractions += amount;` (state effect) **before**
  `_mint(...)` (the external call that invokes `onERC1155Received`), so the supply accounting
  follows checks-effects-interactions and cannot be double-spent by re-entry. Only the *event*
  is emitted after the external call, which is what `reentrancy-events` flags. Additionally
  `mintFractions` is `onlyOwner`, so re-entry would require a malicious owner.
- **Adversarial confirmation:** exercised directly by the malicious-receiver test
  (`test/security/MaliciousReceiver.attack.js`), which attempts genuine re-entry during
  `onERC1155Received`; see `SMART_CONTRACT_SECURITY_REPORT.md`.

### The single High finding is an OpenZeppelin false positive

The lone High (`incorrect-exp`) is in `@openzeppelin/contracts/utils/math/Math.sol`
(`mulDiv`), where Slither misreads the intentional bitwise-XOR (`^`) in the Newton–Raphson
modular-inverse as a mistaken exponentiation. This is a well-known Slither false positive on
OpenZeppelin's audited library and is **not** in RealShare code.

- **Classification:** false positive (library), accepted risk.
- The eight remaining Medium findings are likewise confined to OpenZeppelin library internals
  (assembly usage, dead code in unused branches) and are accepted as audited-dependency behaviour.

## solhint

`npx solhint` on the RealShare-authored contracts: **0 errors, 125 warnings.** All warnings are
stylistic or micro-optimisation (NatSpec tags, custom-errors-vs-require, `++i` increment,
gas-small-strings). None indicate a security defect. Config: `.solhint.json` (`solhint:recommended`).

## Dependency audit

`npm audit --omit=dev`: **0 vulnerabilities** in production dependencies.

## Conservative conclusion

The RealShare-authored contracts produced **no High- or Medium-severity Slither findings and no
solhint errors** under the documented configuration; the single Low finding is a
checks-effects-interactions-mitigated, `onlyOwner`-gated event-ordering note that is exercised
adversarially in the malicious-receiver test. These results increase assurance but do not replace
an independent professional audit. Mythril and formal verification are recommended as further
assurance (see limitations).
