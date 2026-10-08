// M4 (partial): creation gas of the neutral benchmark contracts, measured by
// eth_call gas-cap bisection on Amoy and on the Ethereum schedule.
// No funds and no deployment required. Produces A_1155, A_20 (factory) and
// D_20 (standalone neutral ERC-20), plus the Amoy-minus-Ethereum difference for
// the Eq. (1) cross-check. L_1155, d_1155 and d_20 need a real deployment.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = "E:/PHD Application/RealShare";
function art(name) {
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p);
      else if (f === name + ".json") hits.push(p);
    }
  })(path.join(ROOT, "artifacts"));
  return JSON.parse(fs.readFileSync(hits[0], "utf8"));
}

const coder = ethers.AbiCoder.defaultAbiCoder();
const targets = {
  "A_1155  BenchERC1155": art("BenchERC1155").bytecode,
  "A_20    BenchERC20Factory": art("BenchERC20Factory").bytecode,
  "D_20    BenchERC20 (standalone)":
    art("BenchERC20").bytecode + coder.encode(["string", "string"], ["Property", "PRP"]).slice(2),
};

const NETS = {
  "Ethereum Sepolia": "https://ethereum-sepolia-rpc.publicnode.com",
  "Polygon Amoy": "https://polygon-amoy-bor-rpc.publicnode.com",
};

async function rpc(url, method, params) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      return await r.json();
    } catch (e) { await new Promise((r) => setTimeout(r, 900 * (a + 1))); }
  }
  return { error: { message: "unreachable" } };
}
async function ok(url, data, gas) {
  const res = await rpc(url, "eth_call", [{ from: "0x71C59a35b79A18b0A44540501cB900761DC32fD0", data, gas: "0x" + gas.toString(16) }, "latest"]);
  return !res.error;
}
async function exact(url, data) {
  let lo = 21000, hi = 8000000;
  if (!(await ok(url, data, hi))) return null;
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (await ok(url, data, m)) hi = m; else lo = m + 1; }
  return lo;
}

(async () => {
  const out = {};
  for (const [net, url] of Object.entries(NETS)) {
    const bn = await rpc(url, "eth_blockNumber", []);
    out[net] = { block: parseInt(bn.result, 16), vals: {} };
    for (const [name, code] of Object.entries(targets)) {
      const g = await exact(url, code);
      out[net].vals[name] = g;
      console.error(`${net.padEnd(18)} ${name.padEnd(32)} ${g}`);
    }
  }
  console.log(JSON.stringify(out, null, 2));
  const e = out["Ethereum Sepolia"].vals, a = out["Polygon Amoy"].vals;
  console.error("\nAmoy - Ethereum difference per contract:");
  for (const k of Object.keys(targets)) {
    const d = (a[k] != null && e[k] != null) ? a[k] - e[k] : null;
    console.error(`  ${k.padEnd(32)} ${d}   (=> cold SSTORE count ${d != null ? d / 840 : "-"} if pure 840/slot)`);
  }
})();
