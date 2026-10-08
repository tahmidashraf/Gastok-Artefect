// Experiment 14 — Secure API Communication. Runs 16 real security tests against
// the live RealShare API and reports pass/fail. Re-run after rate limiting was
// added in revision (previously 15/16; the rate-limit control was the single gap).
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { createApp, JWT_SECRET } = require("./server");

const CREDS = { email: "investor@realshare.example", password: "S3cure!pass" };

async function run() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  const T = (name, category, pass, detail) => {
    results.push({ name, category, pass, detail });
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${String(results.length).padStart(2)}. ${name} — ${detail}`);
  };

  // Obtain a valid token (successful login is not rate-limited).
  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(CREDS),
  });
  const validToken = (await loginRes.json()).token;

  // 1. Access protected route with no token
  let r = await fetch(`${base}/properties`);
  T("Access without token", "Auth", r.status === 401, `HTTP ${r.status} (expect 401)`);

  // 2. Invalid/garbage token
  r = await fetch(`${base}/properties`, { headers: { Authorization: "Bearer not-a-real-token" } });
  T("Invalid token", "Auth", r.status === 401, `HTTP ${r.status} (expect 401)`);

  // 3. Tampered JWT payload (valid token with one character flipped)
  const tampered = validToken.slice(0, -2) + (validToken.slice(-2) === "AA" ? "BB" : "AA");
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Bearer ${tampered}` } });
  T("Tampered JWT payload", "Auth", r.status === 401, `HTTP ${r.status} (expect 401)`);

  // 4. Malformed Bearer prefix
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Token ${validToken}` } });
  T("Malformed Bearer prefix", "Auth", r.status === 401, `HTTP ${r.status} (expect 401)`);

  // 5. Valid token grants access
  r = await fetch(`${base}/properties`, { headers: { Authorization: `Bearer ${validToken}` } });
  T("Valid token grants access", "Auth", r.status === 200, `HTTP ${r.status} (expect 200)`);

  // 6. SQL-injection-style login is rejected (not authenticated)
  r = await fetch(`${base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "' OR '1'='1' --", password: "x" }),
  });
  T("SQL injection in login", "Injection", r.status === 401, `HTTP ${r.status} (expect 401, no auth)`);

  // 7. Missing required fields
  r = await fetch(`${base}/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.com" }),
  });
  T("Missing required fields", "Validation", r.status === 400, `HTTP ${r.status} (expect 400)`);

  // Header tests use the health endpoint
  const hres = await fetch(`${base}/health`);
  const H = (k) => hres.headers.get(k);

  // 8-12 security headers
  T("X-Content-Type-Options", "Headers", H("x-content-type-options") === "nosniff", `value: ${H("x-content-type-options")}`);
  T("X-Frame-Options", "Headers", !!H("x-frame-options"), `value: ${H("x-frame-options")}`);
  T("X-XSS-Protection", "Headers", hres.headers.has("x-xss-protection"), `present: ${hres.headers.has("x-xss-protection")}`);
  T("X-Powered-By hidden", "Headers", !hres.headers.has("x-powered-by"), `present: ${hres.headers.has("x-powered-by")}`);
  T("Content-Security-Policy", "Headers", !!H("content-security-policy"), `present: ${!!H("content-security-policy")}`);

  // 13. Brute-force rate limiting (control added in revision)
  let got429 = false;
  for (let i = 0; i < 10; i++) {
    const br = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: CREDS.email, password: "wrong-password" }),
    });
    if (br.status === 429) { got429 = true; break; }
  }
  T("Brute-force rate limiting", "Rate Limit", got429, got429 ? "429 returned after repeated failed logins" : "no 429 (limiter absent)");

  // 14. HSTS header present
  T("Strict-Transport-Security", "Headers", !!H("strict-transport-security"), `present: ${!!H("strict-transport-security")}`);

  // 15. CORS restricted (not wildcard)
  const cres = await fetch(`${base}/health`, { headers: { Origin: "https://realshare.example" } });
  const acao = cres.headers.get("access-control-allow-origin");
  T("CORS origin restricted", "Headers", !!acao && acao !== "*", `ACAO: ${acao}`);

  // 16. Oversized request body rejected
  const big = JSON.stringify({ email: "a@b.com", password: "x".repeat(20000) });
  r = await fetch(`${base}/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  T("Oversized body rejected", "Validation", r.status === 413, `HTTP ${r.status} (expect 413)`);

  server.close();

  const passed = results.filter((x) => x.pass).length;
  const total = results.length;
  const payload = {
    experiment: "exp14_security",
    timestamp: new Date().toISOString(),
    passed, total, score: `${((passed / total) * 100).toFixed(1)}%`,
    rateLimitingAdded: true,
    tests: results,
  };
  const dir = path.join(__dirname, "results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, `exp14_security_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));

  console.log(`\nSECURITY SCORE: ${passed}/${total} (${payload.score})`);
  console.log(`Saved: ${path.relative(__dirname, file)}`);
  if (passed !== total) process.exitCode = 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
