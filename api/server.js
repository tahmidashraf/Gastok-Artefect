// RealShare secure REST API.
// Mirrors the Objective-2 API (JWT auth, property/KYC/token routes) and the
// Objective-3 security controls. Rate limiting on the login route is the control
// added in revision after Experiment 14 flagged its absence.
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "realshare-dev-secret-change-in-prod";
const ALLOWED_ORIGIN = "https://realshare.example";

// Demo user store (passwords would be bcrypt-hashed in production).
const USERS = {
  "investor@realshare.example": { password: "S3cure!pass", role: "investor" },
  "investor2@realshare.example": { password: "An0ther!pass", role: "investor" },
  "admin@realshare.example": { password: "Adm1n!pass", role: "admin" },
};

// Revoked token identifiers (jti) — populated on logout / revocation.
const REVOKED = new Set();

function createApp() {
  const app = express();

  // --- Security middleware ---
  app.use(helmet());                       // CSP, HSTS, X-Frame-Options, X-Content-Type-Options, hides X-Powered-By
  app.use(cors({ origin: ALLOWED_ORIGIN })); // restrict CORS to a known origin (never "*")
  app.use(express.json({ limit: "10kb" }));  // body size cap (mitigates oversized-payload DoS)

  // --- Brute-force rate limiting on authentication (control added in revision) ---
  // Limits FAILED login attempts per IP; successful logins are not penalised.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many login attempts, please try again later." },
  });

  // --- Auth helpers ---
  function auth(req, res, next) {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or malformed token" });
    const token = h.slice(7);
    try {
      // algorithms pinned to HS256: defeats the alg:none / RS/HS confusion attacks.
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      if (decoded.jti && REVOKED.has(decoded.jti)) {
        return res.status(401).json({ error: "Token revoked" });
      }
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: "Invalid or tampered token" });
    }
  }

  // Role-based authorization: enforce the on-server role, never a client-supplied one.
  function requireRole(role) {
    return (req, res, next) => {
      if (!req.user || req.user.role !== role) return res.status(403).json({ error: "forbidden: insufficient role" });
      next();
    };
  }

  // --- Routes ---
  app.get("/health", (req, res) => res.json({ status: "ok" }));

  app.post("/auth/register", (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email and password are required" });
    // Reject non-string credentials (defeats NoSQL-style object injection, e.g. {"$gt":""}).
    if (typeof email !== "string" || typeof password !== "string")
      return res.status(400).json({ error: "email and password must be strings" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ error: "invalid email format" });
    // Mass-assignment protection: role is ASSIGNED by the server, never taken from the body.
    return res.status(201).json({ email, role: "investor" });
  });

  app.post("/auth/login", loginLimiter, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email and password are required" });
    if (typeof email !== "string" || typeof password !== "string")
      return res.status(401).json({ error: "invalid credentials" }); // NoSQL-object login rejected
    // Exact-match lookup on a parameter-bound key — injection strings simply fail to match.
    const user = USERS[email];
    // Generic error for both unknown-user and wrong-password: prevents account enumeration.
    if (!user || user.password !== password) return res.status(401).json({ error: "invalid credentials" });
    const jti = `${email}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const token = jwt.sign({ sub: email, role: user.role, jti }, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
    return res.json({ token });
  });

  app.post("/auth/logout", auth, (req, res) => {
    if (req.user.jti) REVOKED.add(req.user.jti);   // token replay after logout is now rejected
    return res.json({ loggedOut: true });
  });

  // Protected resource routes
  app.get("/properties", auth, (req, res) => res.json({ properties: [{ id: 1, name: "KLCC Tower A" }] }));

  // Owner-scoped resource: IDOR guard — a user may only read their own portfolio.
  app.get("/portfolio/:userId", auth, (req, res) => {
    if (req.user.sub !== req.params.userId) return res.status(403).json({ error: "forbidden: not your resource" });
    return res.json({ userId: req.params.userId, holdings: [] });
  });

  // Privileged operations require the admin role (enforced server-side).
  app.post("/properties", auth, requireRole("admin"), (req, res) => res.status(201).json({ created: true }));
  app.post("/kyc/approve", auth, requireRole("admin"), (req, res) => res.json({ approved: true }));
  app.post("/tokens/mint", auth, requireRole("admin"), (req, res) => res.json({ minted: true }));

  // Unsupported methods on known paths -> 405 (not a silent 404).
  app.all("/properties", (req, res) => res.status(405).json({ error: "method not allowed" }));
  app.all("/health", (req, res) => res.status(405).json({ error: "method not allowed" }));

  // Error handler: oversized bodies -> 413, malformed JSON -> 400 (no stack leak).
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "payload too large" });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "malformed JSON" });
    return res.status(500).json({ error: "internal error" });
  });

  return app;
}

module.exports = { createApp, JWT_SECRET };

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`RealShare API listening on :${port}`));
}
