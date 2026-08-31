# Changelog

All notable changes to this project. This is a portfolio project developed in milestones;
the versions below track those milestones, not a released package.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/). The project
is not published to a registry.

## [Unreleased] — 2026-08-31 · M4.1.1 — Final post-redaction verification

### Resolved

- **The git-history redaction flagged as unresolved in M4.1 is now confirmed successful.**
  The owner ran `git filter-repo --invert-paths` to remove `scripts/scan-proprietary.mjs`
  from the entire history, then re-added only the already-sanitized version in one new
  commit. Verified, read-only: every prior commit hash from the one that first added the
  file is gone from the object database; the file's reachable history is now a single
  commit; a full-reachable-blob scan (283 blobs) finds zero proprietary-term matches
  anywhere in history; commit messages, tags, and path names are clean; full-history
  gitleaks (18 commits) stays clean; `git fsck` is clean with no dangling objects. All
  GitHub Action SHA pins and the finalized public metadata survived the rewrite intact.
- `docs/PUBLIC_RELEASE_CHECKLIST.md` status raised to `READY_FOR_REMOTE_CREATION`. No code,
  test, or business-invariant change — 192/192 tests still pass.

## [Unreleased] — 2026-08-31 · M4.1 — History-sanitization verification & CI supply-chain pinning

### Added

- **All GitHub Actions in `.github/workflows/ci.yml` pinned to full 40-character immutable
  commit SHAs** (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
  `gitleaks/gitleaks-action`, `aquasecurity/trivy-action`, `github/codeql-action/{init,analyze}`),
  each resolved read-only from its own upstream repository via `gh api`, with a
  human-readable version kept as a trailing comment. Also fixed an invalid tag reference
  (`aquasecurity/trivy-action@0.28.0` had no leading `v` and would have failed at run time).
- `scripts/check-workflow.mjs` now requires every `uses:` to be a full 40-hex SHA (not just
  "has an @ref") and fails on a leftover SHA-pinning TODO.
- `package.json` `repository`/`homepage`/`bugs` and the OpenAPI `info.contact.url` now point
  at the confirmed public target `github.com/mubinibum/ledger-payout-service` (the remote
  itself does not exist yet — this batch created no remote, pushed nothing).

### Found — NOT fixed automatically (by design)

- **A manually-run git-history redaction of `scripts/scan-proprietary.mjs` (intended to
  remove real company/brand names from history) was verified, read-only, to have had no
  effect.** `HEAD`/all commit hashes are unchanged from the pre-redaction state, and a
  full-reachable-history content scan still finds the local proprietary terms inside old
  `scripts/scan-proprietary.mjs` blobs. No history rewrite was attempted in this batch (by
  instruction). `docs/PUBLIC_RELEASE_CHECKLIST.md` status is `BLOCKED_FOR_PUBLIC_PUSH`.
- Full-history gitleaks (16 commits): clean, no secrets. No real `.env` ever committed.

## [0.4.0] — 2026-08-31 · M4 — Public readiness, observability, security & documentation

### Added

- **OpenAPI 3.1 spec** (`openapi/openapi.yaml` + generated `openapi/openapi.json`) covering
  every real HTTP route, with `npm run openapi:check` failing on structural errors, a stale
  JSON, or path/method drift versus the registered routes.
- **Prometheus `GET /metrics`** — opt-in via `METRICS_ENABLED` (default off → 404). HTTP
  request counter + duration histogram; identifier-free, bounded labels only. Exposition
  rendered from the in-process registry (no new dependency).
- **`Dockerfile`** — multi-stage, `node:20.20.2-bookworm-slim`, non-root, production-only
  deps, healthcheck, `STOPSIGNAL SIGTERM`; comprehensive `.dockerignore`.
- **Fail-closed production config** — `NODE_ENV=production` refuses to start without
  `WEBHOOK_SECRET`, with `ALLOW_FUNDING=true`, or with a placeholder DB password.
- **Security headers** on every response (`x-content-type-options`, `x-frame-options`,
  `referrer-policy`; `x-powered-by` removed).
- Docs: `docs/THREAT_MODEL.md`, `docs/RUNBOOK.md`, `docs/PERFORMANCE.md`,
  `docs/DEPENDENCY_LICENSE_REVIEW.md`, `docs/PUBLIC_RELEASE_CHECKLIST.md`, ADRs 0019–0021,
  `CONTRIBUTING.md`, `CHANGELOG.md`, rewritten public-facing `README.md` and `SECURITY.md`.
- Tooling: `scripts/generate-sbom.mjs` (deterministic CycloneDX), `scripts/check-licenses.mjs`,
  `scripts/check-workflow.mjs`, `scripts/check-doc-links.mjs`, `scripts/openapi.mjs`,
  `scripts/bench.mjs` (`LOCAL_BENCHMARK_ONLY`).
- Package metadata: `keywords`, `author`, `license`, placeholder `repository`/`homepage`/`bugs`.

### Changed

- **`scripts/scan-proprietary.mjs`** reworked to structural rules only (no literal
  company/brand names in the file) + an optional gitignored local term list.
- **CI** (`.github/workflows/ci.yml`) hardened — `permissions: contents: read`, split jobs
  for gitleaks (full history), Trivy (fs/config/image), CodeQL, container verification; SBOM
  + license gates; no `|| true` on any security/audit hard gate. Action SHA-pinning is a
  tracked pre-public item.

### Security

- Threat-modeled (STRIDE + abuse cases); container hardened and verified locally;
  supply-chain scans configured. Production `npm audit` remains **0**. Dev-only audit
  advisories (5 moderate, `uuid` via `testcontainers`) reviewed and accepted with rationale.

### Not done (by design)

No GitHub remote, push, or deploy. No authenticated admin HTTP API. No real provider. No
Kubernetes/cloud manifests. Benchmarks are local-only and excluded from the résumé.

## [0.3.2] — 2026-08-31 · M3.1 — Ambiguous-payout safety hardening

- Root-caused a double-spend risk (reconciliation / DLQ released reserved funds on an
  `unknown` / `processing` outcome).
- New non-terminal `manual_review` state: funds stay reserved, no automatic processing, not
  API-cancellable, operator-resolved via `npm run payout-admin` with a `payout_resolutions`
  audit trail.
- Reserved funds auto-release **only** after a definitive provider rejection or a
  pre-submission cancellation. `classifyTransportError` defaults to `ambiguous`;
  conservative `ProviderCapabilities` contract.
- Contradictory terminal webhook/status → logged, metered, `conflict_ignored`, no second
  effect. Outbox `queue.add` bounded by a timeout. ADR 0018.
- Delivery semantics stated precisely: at-least-once delivery + idempotent accounting
  effects + at-most-once settlement/release per payout (not exactly-once).

## [0.3.0] — 2026-08-30 · M3 — Payout, outbox, worker, signed webhook, reconciliation

- Payout state machine + reservation accounting (source → holding → provider clearing, all
  balanced), transactional outbox + publisher process, BullMQ worker process, local mock
  provider, HMAC-signed webhooks with replay protection, reconciliation pass. ADRs 0011–0017.

## [0.2.0] — 2026-08-29 · M2 — Ledger domain

- Accounts, double-entry ledger, idempotent transfers, non-negative-balance invariant,
  PostgreSQL-backed idempotency, concurrency tests (150 parallel transfers). ADRs 0006–0010.

## [0.1.0] — 2026-08-27 · M1 — Skeleton

- TypeScript strict, Fastify, Kysely, health/readiness, Docker Compose (PostgreSQL + Redis),
  CI skeleton. ADRs 0001–0005.
