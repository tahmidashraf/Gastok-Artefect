// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/*
 * Gas-schedule micro-probes.
 *
 * Each probe isolates ONE opcode class inside its constructor. Deployment gas is
 * measured per chain with eth_estimateGas, which needs no funded account and no
 * deployment. For a given probe the init bytecode is byte-identical on every
 * chain, so intrinsic gas, calldata cost and code-deposit cost are identical
 * across chains and cancel in the per-chain difference
 *
 *     delta_k(chain) = gas_chain(probe_k) - gas_ethereum(probe_k)
 *
 * leaving only the repricing of the opcodes that probe executes. Probes come in
 * families with a varying count n so the per-operation surcharge is recovered
 * from the slope rather than from a single point.
 *
 * All state writes use inline assembly with values derived from block context so
 * the optimizer cannot fold or elide them.
 */

// ---------------------------------------------------------------- baseline
// Constructor does nothing. Captures intrinsic + deposit only.
contract ProbeBaseline {
    constructor() {}
}

// ------------------------------------------------- cold SSTORE (zero -> nonzero)
// n writes to n distinct never-touched slots.
contract ProbeColdSstore1 {
    constructor() { uint256 v = block.number | 1; assembly { sstore(0x1000, v) } }
}
contract ProbeColdSstore2 {
    constructor() { uint256 v = block.number | 1; assembly {
        sstore(0x2000, v) sstore(0x2001, v) } }
}
contract ProbeColdSstore4 {
    constructor() { uint256 v = block.number | 1; assembly {
        sstore(0x3000, v) sstore(0x3001, v) sstore(0x3002, v) sstore(0x3003, v) } }
}
contract ProbeColdSstore8 {
    constructor() { uint256 v = block.number | 1; assembly {
        sstore(0x4000, v) sstore(0x4001, v) sstore(0x4002, v) sstore(0x4003, v)
        sstore(0x4004, v) sstore(0x4005, v) sstore(0x4006, v) sstore(0x4007, v) } }
}
contract ProbeColdSstore16 {
    constructor() { uint256 v = block.number | 1; assembly {
        sstore(0x5000, v) sstore(0x5001, v) sstore(0x5002, v) sstore(0x5003, v)
        sstore(0x5004, v) sstore(0x5005, v) sstore(0x5006, v) sstore(0x5007, v)
        sstore(0x5008, v) sstore(0x5009, v) sstore(0x500a, v) sstore(0x500b, v)
        sstore(0x500c, v) sstore(0x500d, v) sstore(0x500e, v) sstore(0x500f, v) } }
}

// ------------------------------------------- warm SSTORE (nonzero -> nonzero)
// One cold write, then n warm rewrites of the same slot.
contract ProbeWarmSstore4 {
    constructor() { uint256 v = block.number | 1; assembly {
        sstore(0x6000, v)
        sstore(0x6000, add(v, 1)) sstore(0x6000, add(v, 2))
        sstore(0x6000, add(v, 3)) sstore(0x6000, add(v, 4)) } }
}
contract ProbeWarmSstore16 {
    constructor() { uint256 v = block.number | 1; assembly {
        sstore(0x7000, v)
        for { let i := 0 } lt(i, 16) { i := add(i, 1) } { sstore(0x7000, add(v, i)) } } }
}

// ---------------------------------------------------------- cold SLOAD
// n reads of distinct never-touched slots, accumulated so they cannot be elided.
contract ProbeColdSload8 {
    constructor() { uint256 acc; assembly {
        for { let i := 0 } lt(i, 8) { i := add(i, 1) } { acc := add(acc, sload(add(0x8000, i))) }
        sstore(0x8100, add(acc, 1)) } }
}
contract ProbeColdSload32 {
    constructor() { uint256 acc; assembly {
        for { let i := 0 } lt(i, 32) { i := add(i, 1) } { acc := add(acc, sload(add(0x9000, i))) }
        sstore(0x9100, add(acc, 1)) } }
}

// ------------------------------------------------------------------- LOG
// n LOG1 events with one word of data.
contract ProbeLog4 {
    constructor() { assembly {
        let p := mload(0x40) mstore(p, number())
        for { let i := 0 } lt(i, 4) { i := add(i, 1) } { log1(p, 0x20, i) } } }
}
contract ProbeLog16 {
    constructor() { assembly {
        let p := mload(0x40) mstore(p, number())
        for { let i := 0 } lt(i, 16) { i := add(i, 1) } { log1(p, 0x20, i) } } }
}

// ------------------------------------------ cold account access (EXTCODESIZE)
// n touches of distinct never-accessed addresses.
contract ProbeColdAccount8 {
    constructor() { uint256 acc; assembly {
        for { let i := 0 } lt(i, 8) { i := add(i, 1) } {
            acc := add(acc, extcodesize(add(0xC0FFEE0000, i))) }
        sstore(0xA100, add(acc, 1)) } }
}
contract ProbeColdAccount32 {
    constructor() { uint256 acc; assembly {
        for { let i := 0 } lt(i, 32) { i := add(i, 1) } {
            acc := add(acc, extcodesize(add(0xD0FFEE0000, i))) }
        sstore(0xB100, add(acc, 1)) } }
}

// ----------------------------------------------------- pure compute control
// KECCAK256 over memory. Touches no state. Should NOT diverge on any chain;
// serves as the negative control that isolates divergence to state access.
contract ProbeKeccak64 {
    constructor() { uint256 acc; assembly {
        let p := mload(0x40) mstore(p, number())
        for { let i := 0 } lt(i, 64) { i := add(i, 1) } {
            mstore(p, add(keccak256(p, 0x20), i)) }
        acc := mload(p)
        sstore(0xC100, add(acc, 1)) } }
}

// --------------------------------------------------- memory expansion control
contract ProbeMemory {
    constructor() { assembly {
        let p := mload(0x40)
        mstore(add(p, 0x2000), number())
        sstore(0xD100, mload(add(p, 0x2000))) } }
}

// ------------------------------------------- decomposition: warm-slot SSTORE_SET
// SLOAD first (pays the cold-access charge), then SSTORE zero->nonzero to the SAME
// slot (pays SSTORE_SET on an already-warm slot). Under the Ethereum schedule this
// costs the same total as a bare cold SSTORE, but the charge is composed
// differently, so the two probes separate a repriced COLD_SLOAD_COST from a
// repriced SSTORE_SET.
contract ProbeSloadThenSstore1 {
    constructor() { uint256 v = block.number | 1; assembly {
        let a := sload(0xE000)
        sstore(0xE000, add(v, a)) } }
}
contract ProbeSloadThenSstore4 {
    constructor() { uint256 v = block.number | 1; assembly {
        let a := 0
        a := add(a, sload(0xE100)) sstore(0xE100, add(v, a))
        a := add(a, sload(0xE101)) sstore(0xE101, add(v, a))
        a := add(a, sload(0xE102)) sstore(0xE102, add(v, a))
        a := add(a, sload(0xE103)) sstore(0xE103, add(v, a)) } }
}
