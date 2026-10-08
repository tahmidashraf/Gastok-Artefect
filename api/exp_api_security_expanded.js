/**
 * Expanded API security test suite (Stage 6). Retains the original 16 controls and adds
 * OWASP-API-Top-10-oriented tests: JWT expiry/alg-confusion/replay, IDOR, role escalation,
 * unauthorized privileged operations, mass assignment, NoSQL-object injection, account
 * enumeration, unsupported methods, oversized/nested payloads, forged-role tokens.
 *
 * Runs against the real Express app in-process. Output: api/results/api_security_expanded_<ts>.json
 */
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createApp, JWT_SECRET } = require("./server");

const INV = { email: "investor@realshare.example", password: "S3cure!pass" };
const INV2 = { email: "investor2@realshare.example", password: "An0ther!pass" };
const ADMIN = { email: "admin@realshare.example", password: "Adm1n!pass" };

async function run() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  const T = (name, category, pass, detail) => {
    results.push({ name, category, pass, detail });
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${String(results.length).padStart(2)}. ${name} — ${detail}`);
  };
  const login = async (creds) => (await (await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds) })).json()).token;

  const invToken = await login(INV);
  const adminToken = await login(ADMIN);

  // ---- Original 16 controls ----
  let r = await fetch(`${base}/properties`);
  T("Access without token", "Auth", r.status === 401, `HTTP ${r.status}`);
  r = await fetch(`${base}/properties`, { headers: { Authorization: "Bearer not-a-real-token" } });
  T("Invalid token", "Auth", r.status === 401, `HTTP ${r.status}`);
  const tampered = invToken.slice(0, -2) + (invToken.slice(-2) === "AA" ? "BB" : "AA");
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Bearer ${tampered}` } });
  T("Tampered JWT payload", "Auth", r.status === 401, `HTTP ${r.status}`);
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Token ${invToken}` } });
  T("Malformed Bearer prefix", "Auth", r.status === 401, `HTTP ${r.status}`);
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Bearer ${invToken}` } });
  T("Valid token grants access", "Auth", r.status === 200, `HTTP ${r.status}`);
  r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "' OR '1'='1' --", password: "x" }) });
  T("SQL injection in login", "Injection", r.status === 401, `HTTP ${r.status}`);
  r = await fetch(`${base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.com" }) });
  T("Missing required fields", "Validation", r.status === 400, `HTTP ${r.status}`);
  const hres = await fetch(`${base}/health`); const H = (k) => hres.headers.get(k);
  T("X-Content-Type-Options", "Headers", H("x-content-type-options") === "nosniff", `${H("x-content-type-options")}`);
  T("X-Frame-Options", "Headers", !!H("x-frame-options"), `${H("x-frame-options")}`);
  T("X-Powered-By hidden", "Headers", !hres.headers.has("x-powered-by"), `present:${hres.headers.has("x-powered-by")}`);
  T("Content-Security-Policy", "Headers", !!H("content-security-policy"), `present:${!!H("content-security-policy")}`);
  T("Strict-Transport-Security", "Headers", !!H("strict-transport-security"), `present:${!!H("strict-transport-security")}`);
  const acao = (await fetch(`${base}/health`, { headers: { Origin: "https://realshare.example" } })).headers.get("access-control-allow-origin");
  T("CORS origin restricted", "Headers", !!acao && acao !== "*", `ACAO:${acao}`);
  const big = JSON.stringify({ email: "a@b.com", password: "x".repeat(20000) });
  r = await fetch(`${base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  T("Oversized body rejected", "Validation", r.status === 413, `HTTP ${r.status}`);

  // ---- Expanded controls (login-dependent tests run BEFORE the rate-limit test,
  //      which is placed last so it does not poison later login attempts) ----
  // 17. Expired JWT
  const expired = jwt.sign({ sub: INV.email, role: "investor", jti: "exp" }, JWT_SECRET, { algorithm: "HS256", expiresIn: -10 });
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Bearer ${expired}` } });
  T("Expired JWT rejected", "JWT", r.status === 401, `HTTP ${r.status}`);

  // 18. alg:none / algorithm confusion
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const noneToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: ADMIN.email, role: "admin" })}.`;
  r = await fetch(`${base}/tokens/mint`, { method: "POST", headers: { Authorization: `Bearer ${noneToken}`, "Content-Type": "application/json" }, body: "{}" });
  T("alg:none token rejected", "JWT", r.status === 401, `HTTP ${r.status}`);

  // 19. Forged role via wrong secret
  const forged = jwt.sign({ sub: INV.email, role: "admin", jti: "f" }, "wrong-secret", { algorithm: "HS256" });
  r = await fetch(`${base}/tokens/mint`, { method: "POST", headers: { Authorization: `Bearer ${forged}`, "Content-Type": "application/json" }, body: "{}" });
  T("Forged-role token (wrong secret) rejected", "JWT", r.status === 401, `HTTP ${r.status}`);

  // 20. Token replay after logout
  const tempTok = await login(INV);
  await fetch(`${base}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${tempTok}` } });
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Bearer ${tempTok}` } });
  T("Token replay after logout rejected", "JWT", r.status === 401, `HTTP ${r.status}`);

  // 21. IDOR — investor cannot read another user's portfolio
  r = await fetch(`${base}/portfolio/${encodeURIComponent(INV2.email)}`, { headers: { Authorization: `Bearer ${invToken}` } });
  T("IDOR cross-user resource blocked", "AuthZ", r.status === 403, `HTTP ${r.status}`);
  // own portfolio allowed
  r = await fetch(`${base}/portfolio/${encodeURIComponent(INV.email)}`, { headers: { Authorization: `Bearer ${invToken}` } });
  T("Own resource accessible", "AuthZ", r.status === 200, `HTTP ${r.status}`);

  // 22. Role escalation — investor cannot approve KYC
  r = await fetch(`${base}/kyc/approve`, { method: "POST", headers: { Authorization: `Bearer ${invToken}`, "Content-Type": "application/json" }, body: "{}" });
  T("Investor cannot approve KYC", "AuthZ", r.status === 403, `HTTP ${r.status}`);

  // 23. Unauthorized mint
  r = await fetch(`${base}/tokens/mint`, { method: "POST", headers: { Authorization: `Bearer ${invToken}`, "Content-Type": "application/json" }, body: "{}" });
  T("Investor cannot mint", "AuthZ", r.status === 403, `HTTP ${r.status}`);

  // 23b. Admin CAN mint (positive control)
  r = await fetch(`${base}/tokens/mint`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: "{}" });
  T("Admin can mint (positive control)", "AuthZ", r.status === 200, `HTTP ${r.status}`);

  // 24. Mass assignment — register with role:admin still returns investor
  r = await fetch(`${base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "mass@b.com", password: "P@ssw0rd1", role: "admin", isAdmin: true }) });
  const body = await r.json();
  T("Mass assignment (role) ignored", "AuthZ", r.status === 201 && body.role === "investor", `role=${body.role}`);

  // 25. NoSQL-object injection in login
  r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: { $gt: "" }, password: { $gt: "" } }) });
  T("NoSQL object injection rejected", "Injection", r.status === 401, `HTTP ${r.status}`);

  // 26. Account enumeration — unknown user vs wrong password identical
  const rUnknown = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "nobody@x.com", password: "x" }) });
  const rWrong = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: ADMIN.email, password: "x" }) });
  const same = rUnknown.status === rWrong.status && JSON.stringify(await rUnknown.json()) === JSON.stringify(await rWrong.json());
  T("No account enumeration", "AuthZ", same, `both HTTP ${rUnknown.status}, identical body`);

  // 27. Unsupported HTTP method -> 405
  r = await fetch(`${base}/health`, { method: "DELETE" });
  T("Unsupported method returns 405", "Validation", r.status === 405, `HTTP ${r.status}`);

  // 28. Deeply nested JSON (within size limit) does not crash the server
  let nested = { a: 1 }; for (let i = 0; i < 200; i++) nested = { n: nested };
  r = await fetch(`${base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(nested) });
  T("Nested JSON handled without 500", "Validation", r.status !== 500, `HTTP ${r.status}`);

  // 29. Malformed JSON -> 400 (no stack leak)
  r = await fetch(`${base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ not json" });
  const mbody = await r.text();
  T("Malformed JSON -> 400, no stack leak", "Validation", r.status === 400 && !/at .*\.js:\d+/.test(mbody), `HTTP ${r.status}`);

  // 30. Structurally malformed JWT (2 segments)
  r = await fetch(`${base}/properties`, { headers: { Authorization: "Bearer aaa.bbb" } });
  T("Structurally malformed JWT rejected", "JWT", r.status === 401, `HTTP ${r.status}`);

  // 31. Brute-force rate limiting — LAST, because it trips the per-IP login limiter.
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const br = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: INV.email, password: "wrong" }) });
    if (br.status === 429) { got429 = true; break; }
  }
  T("Brute-force rate limiting", "Rate Limit", got429, got429 ? "429 after repeated failures" : "no 429");

  server.close();

  const passed = results.filter((x) => x.pass).length, total = results.length;
  const payload = { experiment: "api_security_expanded", timestamp: new Date().toISOString(),
    passed, total, controls: total, remediated: passed === total, tests: results };
  const dir = path.join(__dirname, "results"); if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, `api_security_expanded_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`\nAPI SECURITY: ${passed}/${total} controls passed`);
  console.log(`Saved: ${path.relative(__dirname, file)}`);
  if (passed !== total) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
