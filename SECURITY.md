# Security

## Status

This is a **portfolio / engineering-demonstration** project. It handles **no real money**,
integrates with **no real payment provider** (a mock is used), and has **no end-user
authentication** in the current milestone. Do not deploy it as anything other than a demo,
and only on a trusted network or behind an authenticating gateway.

## What is implemented

- **Signed inbound webhooks** — HMAC-SHA256 over the raw request body with a timestamp
  window and replay protection; the endpoint fails closed (`503`) if no secret is set.
- **Input validation at every boundary** — Zod schemas, `strict()` object shapes, size caps
  on free-text and metadata, `bodyLimit` on the HTTP server.
- **Defense-in-depth in the schema** — balanced-entry and non-negative-balance constraints,
  at-most-once settlement/release per payout enforced by DB CHECKs.
- **Fail-closed production config** — the process refuses to start in `NODE_ENV=production`
  without `WEBHOOK_SECRET`, with `ALLOW_FUNDING=true`, or with a placeholder DB password.
- **Conservative security headers** on every response; no `x-powered-by`.
- **Secret hygiene** — `.env` gitignored, only placeholder `.env.example` committed; a
  structural + local-term secret/proprietary scanner; gitleaks over full history in CI;
  `.dockerignore` keeps secrets, `.git`, and tests out of the image.
- **Supply chain** — `npm ci` from a committed lockfile; production `npm audit` is a hard
  CI gate; CycloneDX SBOM per build; license gate; Trivy (fs/config/image) and CodeQL
  configured.
- **Threat model** — [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) (STRIDE + abuse cases,
  with residual risk stated for each threat).
- **Runbook** — [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Known gaps (intentionally out of scope for now)

Authentication/authorization for the API; an authenticated admin service to replace the
direct-DB operator CLI; rate limiting; a real provider adapter with pinned host / TLS /
asymmetric webhook signatures; least-privilege DB roles; SSRF egress controls; GitHub Action
SHA-pinning; secret rotation tooling; PII governance for free-text fields. See
`docs/THREAT_MODEL.md` §5 and `docs/PUBLIC_RELEASE_CHECKLIST.md`.

## Reporting a vulnerability

This demo has no production system behind it and no bug bounty. If you find a security issue,
please open a GitHub issue (or a private security advisory if the platform offers one) with
enough detail to reproduce. There is no SLA.
