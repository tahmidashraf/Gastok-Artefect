// M1 - reset probe, two variants.
//
// M1a (the literal specification): a constructor that sets n slots from zero to
//     non-zero and then overwrites each once in the SAME transaction.
//     Because the contract is fresh, every slot's pre-transaction value is zero,
//     so the overwrite is an EIP-2200 *dirty-slot* write, not a reset.
//
// M1b (true warm reset): eth_call state override places a synthetic contract
//     whose slots are ALREADY non-zero, so an overwrite has original != 0.
//     W1(n): per slot  SLOAD,POP                 (cold SLOAD only)
//     W2(n): per slot  SLOAD,POP,SSTORE(i,2)     (cold SLOAD + warm reset)
//     W2-W1 isolates the warm reset. No funds, no deployment.

const hx = (b) => b.toString(16).padStart(2, '0');
const sstore = (k, v) => '60' + hx(v) + '60' + hx(k) + '55';
const STOPRET = '60006000f3';
const ADDR = '0x00000000000000000000000000000000000c0de0';
const slot = (i) => '0x' + i.toString(16).padStart(64, '0');
const VAL1 = '0x' + '1'.padStart(64, '0');

const initA = (n) => { let s = ''; for (let i = 0; i < n; i++) s += sstore(i, 1); return '0x' + s + STOPRET; };
const initB = (n) => { let s = ''; for (let i = 0; i < n; i++) s += sstore(i, 1); for (let i = 0; i < n; i++) s += sstore(i, 2); return '0x' + s + STOPRET; };
const rtW1 = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '60' + hx(i) + '5450'; return '0x' + s + '00'; };
const rtW2 = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '60' + hx(i) + '5450' + sstore(i, 2); return '0x' + s + '00'; };

async function rpc(url, method, params) {
  for (let att = 0; att < 4; att++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error && /limit|busy|capacity|429/i.test(j.error.message || '')) { await new Promise(r => setTimeout(r, 900 * (att + 1))); continue; }
      return j;
    } catch (e) { await new Promise(r => setTimeout(r, 900 * (att + 1))); }
  }
  return { error: { message: 'rpc unreachable' } };
}

async function okCreate(url, data, gas) {
  const res = await rpc(url, 'eth_call', [{ data, gas: '0x' + gas.toString(16) }, 'latest']);
  if (res.error) return false;
  return true;
}
async function okCall(url, code, n, gas) {
  const st = {}; for (let i = 0; i < n; i++) st[slot(i)] = VAL1;
  const res = await rpc(url, 'eth_call', [{ to: ADDR, data: '0x', gas: '0x' + gas.toString(16) }, 'latest',
    { [ADDR]: { code, stateDiff: st } }]);
  if (res.error) return false;
  return true;
}
async function bisect(fn) {
  let lo = 21000, hi = 3000000;
  if (!(await fn(hi))) return null;
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (await fn(m)) hi = m; else lo = m + 1; }
  return lo;
}

const NETS = JSON.parse(process.argv[2]);
const NS = (process.argv[3] || '1,2,4,8,12,16').split(',').map(Number);
const out = {};
for (const net of NETS) {
  const bn = await rpc(net.url, 'eth_blockNumber', []);
  const cid = await rpc(net.url, 'eth_chainId', []);
  const rows = [];
  for (const n of NS) {
    const A = await bisect(g => okCreate(net.url, initA(n), g));
    const B = await bisect(g => okCreate(net.url, initB(n), g));
    const W1 = await bisect(g => okCall(net.url, rtW1(n), n, g));
    const W2 = await bisect(g => okCall(net.url, rtW2(n), n, g));
    rows.push({ n, A, B, dirtyTotal: (A && B) ? B - A : null,
                W1, W2, resetTotal: (W1 && W2) ? W2 - W1 : null,
                perReset: (W1 && W2) ? (W2 - W1) / n : null });
    console.error(`${net.name} n=${n} A=${A} B=${B} dirty=${A && B ? B - A : '-'} W1=${W1} W2=${W2} reset=${W1 && W2 ? W2 - W1 : '-'} /w=${W1 && W2 ? (W2 - W1) / n : '-'}`);
  }
  out[net.name] = { url: net.url, chainId: cid.result ? parseInt(cid.result, 16) : null,
                    block: bn.result ? parseInt(bn.result, 16) : null, rows };
}
console.log(JSON.stringify(out, null, 2));
