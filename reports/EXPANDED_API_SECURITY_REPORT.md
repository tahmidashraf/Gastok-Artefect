# Expanded API Security Report (Stage 6)

**Status:** EXECUTED. **Result: 31/31 controls passed** (all controls passed after the mass-
assignment, IDOR, role-based-authorisation, token-revocation, and algorithm-pinning remediations
were implemented). No "100% secure" / "100% score" language is used — this is a fixed set of
predefined controls, all of which passed under the documented configuration.
**Raw:** `api/results/api_security_expanded_*.json`. **Regression:** the original 16-control
suite (`api/exp14_security_test.js`) still passes 16/16.
**Harness:** `api/exp_api_security_expanded.js` against the real Express app (`api/server.js`).

## Controls and results

| # | Control | Category | Result |
|--:|---|---|:--:|
| 1–5 | No/invalid/tampered/malformed-prefix token rejected; valid token accepted | Auth | PASS |
| 6 | SQL-injection login string rejected | Injection | PASS |
| 7 | Missing required fields → 400 | Validation | PASS |
| 8–13 | Security headers (nosniff, frame-options, no x-powered-by, CSP, HSTS, restricted CORS) | Headers | PASS |
| 14 | Oversized body → 413 | Validation | PASS |
| 15 | Expired JWT rejected | JWT | PASS |
| 16 | `alg:none` token rejected (algorithms pinned to HS256) | JWT | PASS |
| 17 | Forged-role token signed with wrong secret rejected | JWT | PASS |
| 18 | Token replay after logout rejected (jti revocation) | JWT | PASS |
| 19 | IDOR: cross-user resource blocked (403); own resource allowed | AuthZ | PASS |
| 20 | Role escalation: investor cannot approve KYC (403) | AuthZ | PASS |
| 21 | Investor cannot mint (403); admin can mint (positive control, 200) | AuthZ | PASS |
| 22 | Mass assignment: client `role:admin` ignored, server assigns investor | AuthZ | PASS |
| 23 | NoSQL object-injection login (`{"$gt":""}`) rejected | Injection | PASS |
| 24 | No account enumeration (unknown user vs wrong password identical) | AuthZ | PASS |
| 25 | Unsupported HTTP method → 405 | Validation | PASS |
| 26 | Deeply nested JSON handled without 500 | Validation | PASS |
| 27 | Malformed JSON → 400, no stack-trace leak | Validation | PASS |
| 28 | Structurally malformed JWT rejected | JWT | PASS |
| 29 | Brute-force login rate limiting (429) | Rate Limit | PASS |

## Remediations implemented for this stage (in `api/server.js`)

- **Algorithm pinning:** `jwt.verify(..., { algorithms: ["HS256"] })` defeats `alg:none` and
  RS/HS confusion.
- **Token revocation:** login issues a `jti`; `/auth/logout` adds it to a revocation set;
  `auth()` rejects revoked tokens (replay-after-logout).
- **Role-based authorisation:** `requireRole("admin")` on `/kyc/approve`, `/tokens/mint`,
  `POST /properties`.
- **IDOR guard:** `/portfolio/:userId` returns 403 unless `req.user.sub === userId`.
- **Mass-assignment protection:** `/auth/register` never reads `role` from the body.
- **Injection hardening:** non-string credentials rejected (NoSQL object injection); exact-match
  keyed lookup (SQL-style injection).
- **Enumeration protection:** identical generic error for unknown-user and wrong-password.
- **Method allow-listing:** 405 on unsupported methods for known paths.

## Conservative conclusion

> All 31 predefined API security controls passed after remediation, under the documented
> configuration. This is a control-coverage result, not a proof of absence of vulnerabilities;
> a production deployment should add dependency-scanning in CI, secret management, WAF/edge rate
> limiting, and an external penetration test.

## Limitations

- The user store and portfolio are in-memory demo fixtures; a production deployment would use a
  hashed-credential store (bcrypt/argon2) and a database-backed authorisation model.
- Distributed rate limiting (per-IP across instances) requires a shared store (e.g. Redis);
  the current limiter is per-process.
