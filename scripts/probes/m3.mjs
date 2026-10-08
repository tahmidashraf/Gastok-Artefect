// M3 - activation-block bisection for the Polygon cold-storage repricing.
// A single cold-SLOAD probe is run via eth_call at historical block heights.
// Probe: constructor SLOADs one slot and returns; cross-schedule cost differs by
// 3360 per cold SLOAD, so the probe value jumps at the activation block.
// Requires an archive endpoint. If historical state is unavailable the script
// reports the failure and the depth reached; it never estimates.

const PROBE = '0x600054' + '50' + '60006000f3'; // PUSH1 0 SLOAD POP PUSH1 0 PUSH1 0 RETURN

async function rpc(url, method, params, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return await r.json();
    } catch (e) { await new Promise(r => setTimeout(r, 700)); }
  }
  return { error: { message: 'unreachable' } };
}

async function okAt(url, gas, block) {
  const res = await rpc(url, 'eth_call',
    [{ data: PROBE, gas: '0x' + gas.toString(16) }, '0x' + block.toString(16)]);
  if (res.error) {
    const m = (res.error.message || '').toLowerCase();
    if (m.includes('missing trie') || m.includes('state') && m.includes('not') ||
        m.includes('pruned') || m.includes('archive') || m.includes('header not found'))
      throw new Error('NOSTATE:' + res.error.message);
    return false;
  }
  return true;
}

async function gasAt(url, block) {
  let lo = 21000, hi = 200000;
  if (!(await okAt(url, hi, block))) return null;
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (await okAt(url, m, block)) hi = m; else lo = m + 1; }
  return lo;
}

const url = process.argv[2];
const latest = parseInt((await rpc(url, 'eth_blockNumber', [])).result, 16);
console.error('latest block', latest);

// establish the two regimes
let gNow;
try { gNow = await gasAt(url, latest - 64); } catch (e) { console.error('latest probe failed', e.message); process.exit(1); }
console.error('gas at head-64 =', gNow);

// find a historical block that still has state and shows the OLD price
let lo = 0, hi = latest - 64, deepest = null, gOld = null;
// walk back in powers of two to find the deepest block with retrievable state
for (let back = 1024; back <= latest; back *= 4) {
  const b = latest - back;
  if (b < 1) break;
  try {
    const g = await gasAt(url, b);
    if (g === null) continue;
    deepest = b; gOld = g;
    console.error(`block ${b} (head-${back}) gas=${g}`);
    if (g !== gNow) break;
  } catch (e) {
    console.error(`block ${b} (head-${back}) NO STATE -> ${e.message.slice(0, 90)}`);
    break;
  }
}

if (gOld === null || gOld === gNow) {
  console.log(JSON.stringify({ status: 'INCONCLUSIVE', reason:
    gOld === null ? 'no historical state retrievable' :
    'no price change found within the retrievable window',
    deepestBlockWithState: deepest, gasAtDeepest: gOld, gasAtHead: gNow, latest }, null, 2));
  process.exit(0);
}

// bisect between deepest (old price) and head (new price)
lo = deepest; hi = latest - 64;
while (lo + 1 < hi) {
  const mid = Math.floor((lo + hi) / 2);
  let g;
  try { g = await gasAt(url, mid); } catch (e) { console.error('no state at', mid); break; }
  if (g === gOld) lo = mid; else hi = mid;
  console.error(`  bisect ${mid} -> ${g}`);
}
const blk = await rpc(url, 'eth_getBlockByNumber', ['0x' + hi.toString(16), false]);
console.log(JSON.stringify({ status: 'FOUND', activationBlock: hi,
  timestamp: blk.result ? parseInt(blk.result.timestamp, 16) : null,
  date: blk.result ? new Date(parseInt(blk.result.timestamp, 16) * 1000).toISOString() : null,
  gasBefore: gOld, gasAfter: gNow, delta: gNow - gOld }, null, 2));
