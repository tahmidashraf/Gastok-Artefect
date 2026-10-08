# Fuzz and Invariant Test Report

**Status:** EXECUTED. Tool: fast-check (property-based testing) driving the real compiled
`RealShareERC1155` on a local Hardhat EVM. Foundry/Echidna were not available in the evaluation
environment; this is documented as a tooling substitution — fast-check exercises the deployed
bytecode through its ABI rather than the Solidity source symbolically.
**Suite:** `test/security/fuzz_invariant.test.js`. **Raw:** `results/security/raw/fuzz_invariant_*.json`.

## Configuration

- Generator seeds: fast-check default randomness; `endOnFailure: true` so any counterexample
  halts and is reported (none occurred).
- Input domains: property id ∈ [0,3]; recipient KYC ∈ {true,false}; mint amount ∈ [0, 2,000,000];
  operation sequences of length 3–12 over {mint, transfer} across 5 holder wallets.
- Executed counts are read from the raw JSON and reported exactly.

## Fuzz property P1 — mint validation (12,000 cases)

For a fixture where property 0 is listed+active (cap 1,000,000), property 1 is inactive, and
properties 2–3 are unlisted, and one KYC'd vs one non-KYC recipient:

- **Assertion:** `mintFractions(pid, to, amount)` succeeds **iff**
  `pid==0 (listed∧active) ∧ kycApproved[to] ∧ amount>0 ∧ mintedTotal+amount ≤ cap`, else reverts.
- **Result:** 12,000 cases executed, **0 counterexamples**. Post-condition check: the on-chain
  `mintedFractions` counter equalled the independently tracked cumulative total (998,839 in the
  recorded run), confirming no accounting drift under random load.

## Invariant property P2 — balance conservation (400 random sequences)

Each sequence deploys a fresh contract, lists property 0 (cap 100,000), KYC-approves 5 holders,
then applies 3–12 random valid mint/transfer operations.

- **Invariants checked after every sequence:**
  1. `Σ balanceOf(holder, 0) == mintedFractions(0)`
  2. `mintedFractions(0) == cumulative minted` (no phantom supply)
  3. `mintedFractions(0) ≤ cap`
- **Result:** 400 sequences executed, **0 violations**.

## Total

**12,400 executed cases; all invariants held; zero counterexamples.**

## Limitations and honest scope

- fast-check tests the compiled contract via JS transactions, not the source symbolically; a
  Foundry/Echidna campaign (in-EVM, cheaper per case, ≥10⁶ cases feasible) is recommended as a
  stronger follow-up and is listed in the thesis future work.
- The fuzz domains cover the core mint/transfer/KYC/supply logic; batch-mint and multi-property
  interaction fuzzing would extend coverage further.
- Results are on the Ethereum gas schedule (local EVM); they are logic/behaviour tests, not
  gas or network tests.
