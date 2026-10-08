// M2 - reset probe across the fourteen survey networks.
// Only the true warm-reset probe is run: W1(n) = n x (SLOAD,POP);
// W2(n) = n x (SLOAD,POP,SSTORE). W2-W1 is the warm-reset cost.
// n = 1 and 4 give the per-write slope. Ethereum schedule baseline = 2906/write.
const hx = (b) => b.toString(16).padStart(2, '0');
const sstore = (k, v) => '60' + hx(v) + '60' + hx(k) + '55';
const ADDR = '0x00000000000000000000000000000000000c0de0';
const slot = (i) => '0x' + i.toString(16).padStart(64, '0');
const VAL1 = '0x' + '1'.padStart(64, '0');
const rtW1 = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '60' + hx(i) + '5450'; return '0x' + s + '00'; };
const rtW2 = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '60' + hx(i) + '5450' + sstore(i, 2); return '0x' + s + '00'; };

async function rpc(url, method, params) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error && /limit|busy|capacity|429|exceed/i.test(j.error.message || '')) {
        await new Promise(r => setTimeout(r, 1200 * (a + 1))); continue;
      }
      return j;
    } catch (e) { await new Promise(r => setTimeout(r, 1200 * (a + 1))); }
  }
  return { error: { message: 'unreachable' } };
}
async function okCall(url, code, n, gas) {
  const st = {}; for (let i = 0; i < n; i++) st[slot(i)] = VAL1;
  const res = await rpc(url, 'eth_call', [{ to: ADDR, data: '0x', gas: '0x' + gas.toString(16) }, 'latest',
    { [ADDR]: { code, stateDiff: st } }]);
  return !res.error;
}
async function bisect(url, code, n) {
  let lo = 21000, hi = 120000;
  if (!(await okCall(url, code, n, hi))) return null;
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (await okCall(url, code, n, m)) hi = m; else lo = m + 1; }
  return lo;
}

const nets = JSON.parse(await (await import('fs')).promises.readFile(process.argv[2], 'utf8'));
const ETH_BASELINE = 2906;
async function doNet(net) {
  const cid = await rpc(net.url, 'eth_chainId', []);
  const bn = await rpc(net.url, 'eth_blockNumber', []);
  const r = {};
  for (const n of [1, 4]) {
    const w1 = await bisect(net.url, rtW1(n), n);
    const w2 = await bisect(net.url, rtW2(n), n);
    r[n] = (w1 && w2) ? w2 - w1 : null;
  }
  const perWrite = (r[1] !== null && r[4] !== null) ? (r[4] - r[1]) / 3 : null;
  const delta = perWrite !== null ? perWrite - ETH_BASELINE : null;
  const row = { name: net.name, chainId: cid.result ? parseInt(cid.result, 16) : null,
                block: bn.result ? parseInt(bn.result, 16) : null,
                reset_n1: r[1], reset_n4: r[4], perWrite, deltaVsEthereum: delta,
                repricesResets: delta === null ? 'unknown' : (delta === 0 ? 'no' : 'YES') };
  console.error(`${net.name.padEnd(20)} cid=${row.chainId} blk=${row.block} n1=${r[1]} n4=${r[4]} /w=${perWrite} delta=${delta} -> ${row.repricesResets}`);
  return row;
}
const out = await Promise.all(nets.map(doNet));
console.log(JSON.stringify(out, null, 2));
