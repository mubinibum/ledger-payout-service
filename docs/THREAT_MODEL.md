# Threat model

- **Status:** M4, living document
- **Scope:** the `ledger-payout-service` codebase as it runs locally — the HTTP API, the
  outbox publisher, the BullMQ worker, the reconciliation pass, the operator CLI, and their
  use of PostgreSQL and Redis.
- **Not in scope:** a real payment provider, real funds, a real deployment topology, an
  authentication/authorization system, network/host hardening, and the mock provider
  (a local test double). Those are explicitly out of this milestone.

This is an engineering demonstration. The goal of this document is to show the reasoning,
name the risks honestly, and be clear about what is **mitigated**, what is **residual**, and
what a real deployment would still have to do. No risk here is claimed to be fully
eliminated.

---

## 1. Assets

| # | Asset | Why it matters |
|---|---|---|
| A1 | Ledger integrity — every transaction balances, no committed balance goes negative | The core correctness property; the whole project exists to protect it |
| A2 | Reserved payout funds | Must never be both released to the source **and** paid to the beneficiary (double-spend) |
| A3 | Idempotency records | A broken idempotency layer causes duplicate transfers/payouts |
| A4 | Outbox → queue delivery | Lost events strand reserved funds; duplicated events must be absorbed idempotently |
| A5 | `WEBHOOK_SECRET` | Anyone who has it can forge provider outcomes |
| A6 | Database / Redis credentials | Full read/write to all financial state |
| A7 | `payout_resolutions` audit trail | The only record of operator intervention |
| A8 | Availability of the API and workers | An outage strands in-flight payouts until recovery |
| A9 | Operator workstation running `payout-admin` | Can settle/release any payout in `manual_review` |

## 2. Trust boundaries

```
          ┌─────────────────────── trusted network (assumed) ───────────────────────┐
          │                                                                         │
client ──▶│  HTTP API  ──▶  PostgreSQL  ◀──  outbox publisher  ──▶  Redis  ──▶  worker  ──▶ provider
          │      ▲                                                    │                     │
          │      └──────────────── signed webhook ◀───────────────────┼─────────────────────┘
          │                                                           │
operator ─┼──▶  payout-admin CLI  ──▶  PostgreSQL                     │
          └─────────────────────────────────────────────────────────────────────────┘
```

- **B1 — Internet → API.** No authentication in this milestone. The service is designed to
  sit on a trusted network or behind an authenticating gateway. Every input is still
  validated (Zod) and every money path is still invariant-checked.
- **B2 — Provider → webhook endpoint.** The only externally-reachable authenticated
  surface: HMAC-SHA256 over the raw body with a timestamp window and replay protection.
- **B3 — App → PostgreSQL / Redis.** Assumed same trusted network; credentials from the
  environment, never in code or git.
- **B4 — Operator → CLI → PostgreSQL.** The CLI has direct DB access and no additional
  authn/authz. Operator identity is a free-text `operator_reference` recorded in the audit
  row — it is *not* verified. A real deployment needs an authenticated admin service with
  RBAC and a verified actor identity (see §5).
- **B5 — App → provider.** `mock` only. `PROVIDER_BASE_URL` is operator-configured; a real
  adapter must pin the host and use TLS + credentials.

---

## 3. STRIDE analysis

Likelihood/impact are **in the intended local/trusted-network context**. "Residual" is what
remains after the listed mitigation. "Verification" is where the property is checked.

### Spoofing

**T1 — Forged provider webhook.**
Likelihood: medium · Impact: high (A2, A1).
Attacker POSTs `payout.succeeded`/`payout.failed` to settle or release a payout.
*Mitigation:* HMAC-SHA256 over `"{timestamp}.{rawBody}"` with `WEBHOOK_SECRET`,
constant-time compare, `WEBHOOK_TOLERANCE_SEC` window, `503` when no secret is configured
(fail closed). Body is parsed only after the signature verifies.
*Residual:* whoever holds `WEBHOOK_SECRET` can forge freely; no per-message asymmetric
signature, no mTLS. A replayed-but-valid message inside the window is caught only by the
event-id dedupe (T4).
*Future:* asymmetric signatures (provider public key), IP allow-list, mTLS.
*Verification:* `test/unit/webhook-signature.test.ts`, `test/integration/webhooks.test.ts`.

**T2 — Caller impersonates another tenant / account owner.**
Likelihood: high on an untrusted network · Impact: high (A1, A2).
No authentication, so any caller can create transfers/payouts against any account id.
*Mitigation:* out of scope by design — documented as "trusted network / gateway only" in
the README, SECURITY.md and the OpenAPI `info`. Account ids are UUIDv4 (not enumerable).
*Residual:* total, if the API is exposed directly. This is the single biggest "do not
deploy as-is" caveat.
*Future:* authentication + per-account authorization is a prerequisite milestone before any
real deployment.
*Verification:* documented; `GET /` and OpenAPI state `env` and the no-auth position.

**T3 — Operator identity is unverified in the CLI.**
Likelihood: medium · Impact: medium (A7, A2).
`operator_reference` is free text; anyone with DB access and the CLI can act as anyone.
*Mitigation:* every action (including rejected ones) writes an immutable `payout_resolutions`
row; the CLI requires an explicit non-empty reference.
*Residual:* no authentication of the operator; audit attribution is only as trustworthy as
DB access control.
*Future:* authenticated admin service, SSO actor identity, break-glass logging.
*Verification:* `test/integration/manual-review.test.ts` asserts an audit row per action.

### Tampering

**T4 — Replayed webhook causes a second accounting effect.**
Likelihood: medium · Impact: high (A2).
*Mitigation:* `provider_webhook_events` has a unique `provider_event_id`; the receipt insert
and the payout transition commit in one transaction; a duplicate blocks on the unique index
and then replays the stored result (`replay: true`). A different payload under the same
event id is a `409`.
*Residual:* an attacker who can mint fresh event ids *and* a valid signature (i.e. holds the
secret) is not stopped by dedupe — that reduces to T1.
*Future:* bind the event id into the signed payload; provider-side idempotency contract.
*Verification:* `test/integration/webhooks.test.ts` (replay + conflict cases).

**T5 — Direct database mutation bypasses domain rules.**
Likelihood: low (needs A6) · Impact: critical (A1, A2, A3).
*Mitigation:* defense-in-depth in the schema — balanced-entry constraint, non-negative
balance trigger, CHECK constraints that make settlement and release mutually exclusive and
at-most-once per payout, `manual_review` cannot carry a settlement/release txn.
*Residual:* a sufficiently privileged operator can still `ALTER`/`DROP` or disable triggers.
*Future:* least-privilege DB roles, restricted migration role vs runtime role, WAL/audit
shipping.
*Verification:* migration tests; `test/integration/*` exercise the constraints.

**T6 — Money precision / overflow tampering.**
Likelihood: low · Impact: high (A1).
Floating-point drift or a huge amount overflowing arithmetic.
*Mitigation:* money is integer minor units end-to-end (`bigint` / `BIGINT` / digit-string in
JSON); amounts are validated as digit strings; `parseMinorUnits` rejects out-of-range.
*Residual:* `BIGINT` max is ~9.2e18 minor units — effectively unreachable but not infinite.
*Future:* `NUMERIC` column + explicit max-amount policy per currency.
*Verification:* `test/unit/money.test.ts`.

**T7 — Idempotency-key collision or reuse with a different body.**
Likelihood: medium · Impact: high (A3).
*Mitigation:* `(scope, idempotency_key)` unique; the stored `request_hash` is compared —
same key + different body → `409 idempotency_conflict`; same key + same body → the stored
response is replayed. In-progress requests → `409 request_in_progress`.
*Residual:* a client that reuses a key across semantically different-but-hash-equal requests
gets the first result; keys are client-generated so a careless client can still foot-gun
itself (never a cross-client effect — scope is per operation).
*Verification:* `test/integration/idempotency.test.ts`.

### Repudiation

**T8 — An operator denies making a resolution.**
Likelihood: low · Impact: medium (A7).
*Mitigation:* append-only `payout_resolutions` (previous/new status, resolution, reason,
operator reference, resulting ledger txn id, timestamp); the contradictory-resolution path
writes its audit row in a *separate* transaction so a rolled-back attempt is still recorded.
*Residual:* no cryptographic non-repudiation; a DB admin could delete rows (T5).
*Future:* signed audit log / external append-only sink.
*Verification:* `test/integration/manual-review.test.ts`.

**T9 — Lost trace of an automated state change.**
Likelihood: low · Impact: low.
*Mitigation:* structured logs with `x-request-id` on every request; `payout_transitions_total`
metrics by from/to; `definitive_outcome_source` recorded on the payout row.
*Residual:* logs are not shipped anywhere by default; retention is deployment-defined.

### Information disclosure

**T10 — Secrets in code, git history, images, or logs.**
Likelihood: medium (human error) · Impact: high (A5, A6).
*Mitigation:* `.env` gitignored, only `.env.example` (placeholders) committed; `loadEnv`
takes everything from the environment; pino redacts `authorization`/`cookie`/`*.password`/
`*.secret`; `scripts/scan-proprietary.mjs` (structural + local term list) + gitleaks (full
history) in CI; `.dockerignore` keeps `.env`, `.git`, tests, and the local term list out of
the image; the image was verified to contain none of them.
*Residual:* a brand-new secret shape not covered by the structural rules could slip past a
fresh clone (the local term list is not published); a developer can still paste a secret
into a log line that isn't on the redact path.
*Future:* pre-commit hook, secret manager, log-pipeline scrubbing.
*Verification:* `npm run scan:proprietary`, gitleaks job, `container` CI job.

**T11 — `/metrics` exposes sensitive data or high-cardinality identifiers.**
Likelihood: medium · Impact: medium.
*Mitigation:* the route is **not registered** unless `METRICS_ENABLED=true` (default off →
404). Every label is a bounded enum, HTTP method, status class, or normalised route template
(`/v1/accounts/:id`, never a real id). No payout/account/idempotency/provider id, raw
reference, or error string is ever a label.
*Residual:* the exposition still reveals traffic shape and error rates; if enabled it must
sit behind an auth proxy or on a scrape-only network.
*Future:* auth on the endpoint, separate metrics port.
*Verification:* `test/integration/metrics.test.ts` (disabled-by-default, content type,
required series, no id-shaped label values).

**T12 — Verbose errors leak internals to the client.**
Likelihood: medium · Impact: low/medium.
*Mitigation:* one error envelope; unexpected errors become `500 internal_error` with no
detail; only `DomainError`/Zod issues are surfaced; stack traces only to logs.
*Residual:* validation messages describe field constraints (intended); domain error
`details` include ids the caller already supplied.
*Verification:* `test/unit/error-mapping.test.ts`.

**T13 — PII in the ledger.**
Likelihood: low · Impact: medium.
Free-text `reference` / `metadata` on transfers and payouts could receive personal data.
*Mitigation:* size caps (200 chars / 20 keys / 4 KB); no PII field is required or modelled;
manual-review reasons are a fixed enum, never free text on the payout row.
*Residual:* a caller can still put PII in `metadata`; there is no scrubbing or retention
policy.
*Future:* field-level classification, retention/erasure tooling.

### Denial of service

**T14 — Request flood / large payloads.**
Likelihood: high on an untrusted network · Impact: medium (A8).
*Mitigation:* Fastify `bodyLimit` 256 KB; keyset pagination caps result pages at 100;
per-check readiness timeouts; DB pool bounded (`DB_POOL_MAX`) with a borrow timeout.
*Residual:* no rate limiting, no per-client quota, no connection cap at the app layer.
*Future:* rate limiter, gateway quotas, load-shedding on pool saturation.
*Verification:* `test/integration/concurrency.test.ts` (150 parallel), pagination tests.

**T15 — Hung Redis stalls the outbox and holds DB row locks.**
Likelihood: medium · Impact: medium (A4, A8).
*Mitigation:* `OUTBOX_ENQUEUE_TIMEOUT_MS` bounds a single `queue.add`; `FOR UPDATE SKIP
LOCKED` on the outbox poll means a stuck row does not block others; the publisher retries
the event next cycle.
*Residual:* a fully-down Redis stops *all* delivery until it returns; reserved funds are
safe but payouts do not progress.
*Future:* circuit breaker + alert on `outbox_oldest_pending_seconds`.
*Verification:* `test/integration/outbox.test.ts`, hung-Redis suite (M3.1).

**T16 — Poison job burns the worker attempt budget.**
Likelihood: medium · Impact: medium (A2 — *contained*).
*Mitigation:* bounded `WORKER_MAX_ATTEMPTS` with exponential backoff; on exhaustion the
payout goes to `manual_review` (funds stay reserved), **not** auto-released, unless it is
provably pre-submission.
*Residual:* a systemic bad deploy could push many payouts into `manual_review` at once,
creating an operator backlog (surfaced by `payout_manual_review` gauge).
*Verification:* `test/integration/payout-worker.test.ts`, `ambiguous-safety.test.ts`.

### Elevation of privilege

**T17 — SSRF via `PROVIDER_BASE_URL` / `MOCK_PROVIDER_WEBHOOK_URL`.**
Likelihood: low (operator-set, not user-set) · Impact: medium.
*Mitigation:* both are environment config validated as URLs, never taken from a request;
`mock` is the only adapter.
*Residual:* an operator who misconfigures the base URL can point the worker at an internal
host. No allow-list.
*Future:* host allow-list, block link-local/metadata ranges, egress policy.
*Verification:* config schema; `PAYOUT_PROVIDER` enum limited to `mock`.

**T18 — Fault-injection or funding reachable in production.**
Likelihood: low · Impact: high (A1, A2).
*Mitigation:* fault injection has **no HTTP surface** and `armFault` is a no-op when
`NODE_ENV==='production'`; funding returns `403` unless `ALLOW_FUNDING=true`, and the env
schema **refuses to start** in production if `ALLOW_FUNDING=true`; production also requires
`WEBHOOK_SECRET` and a non-placeholder DB password (fail-closed).
*Residual:* a deployment that sets `NODE_ENV` to something other than `production` loses
these guards — the runbook and checklist call this out.
*Verification:* `test/integration/funding-safety.test.ts`, `test/integration/production-guards.test.ts`.

**T19 — Dependency / supply-chain compromise.**
Likelihood: low/medium · Impact: high.
*Mitigation:* `npm ci` from a committed lockfile; production `npm audit` is a hard CI gate
at `--audit-level=low`; CycloneDX SBOM produced per build; license gate; Trivy (fs/config/
image) and CodeQL configured; Docker base image pinned to a Node patch version.
*Residual:* actions are pinned to tags not SHAs until the pre-public re-pin (tracked in the
checklist); no `npm` provenance/attestation verification; transitive typosquat risk.
*Future:* SHA-pin all actions, enable `npm audit signatures`, Dependabot/Renovate,
`packageManager` + corepack.
*Verification:* `verify` + `filesystem-scan` + `container` CI jobs, `scripts/check-licenses.mjs`.

**T20 — Container escape / privilege in the runtime image.**
Likelihood: low · Impact: high.
*Mitigation:* runs as non-root `node` (uid 1000, verified), `NODE_ENV=production`, no
package manager invoked at runtime, no shell in `CMD`, slim Debian base, no Docker socket,
minimal file set (dist + prod node_modules + package files + openapi). Compatible with
`--read-only` + `--cap-drop ALL` + `--security-opt no-new-privileges` (documented in the
runbook).
*Residual:* the base image still ships a libc and coreutils; no distroless; no seccomp
profile authored here.
*Future:* distroless/`node:*-slim` → distroless, seccomp/AppArmor profile, read-only root
enforced by the orchestrator.
*Verification:* `container` CI job; local `docker run` verification recorded in the M4 report.

---

## 4. Abuse cases

| Abuse case | Handling |
|---|---|
| **"Cancel my payout after it was sent, keep the money."** | Cancel only works in `requested`/`queued` with `provider_contact = false`. Once a worker starts submission it is not cancellable; ambiguous send → `manual_review`, never auto-release. |
| **"Replay a success webhook to get paid twice."** | Event-id dedupe + single-transaction apply + at-most-once settlement CHECK. Replays return the original result. |
| **"Send `payout.failed` after the payout already settled to get a refund too."** | Contradictory terminal outcome is logged, metered, acknowledged with `conflict_ignored`, and produces no second effect. |
| **"Reuse one idempotency key to fork a transfer into two."** | Same key + different body → `409`. Same key + same body → one effect, replayed response. |
| **"Fund my own account through the API."** | `403 funding_disabled` unless `ALLOW_FUNDING=true`; production refuses to boot with it enabled. |
| **"Flood payout creation to exhaust the source balance / the worker."** | Balance invariant rejects overdraw; worker attempt budget is bounded; exhaustion → `manual_review` (contained), surfaced by gauges. |
| **"Point the worker at an internal service."** | `PROVIDER_BASE_URL` is operator config, `mock` is the only adapter; residual SSRF risk noted (T17). |
| **"Brute-force the webhook signature."** | Constant-time compare, `503` with no secret, timestamp window; a wrong signature reveals nothing. Rate limiting is a documented gap. |

---

## 5. Known gaps a real deployment must close (not in this milestone)

1. **Authentication & authorization** for the public API (per-account) and a dedicated
   **authenticated admin service** with RBAC and a verified operator identity to replace the
   direct-DB CLI. This is a prerequisite, not an enhancement.
2. **Rate limiting / quotas** at the edge.
3. **Real provider adapter**: pinned host, TLS, credentials in a secret manager, asymmetric
   webhook signatures, an explicit `ProviderCapabilities` contract.
4. **Least-privilege DB roles** (separate migration vs runtime), audit-log shipping.
5. **Egress control / SSRF allow-list** for provider calls.
6. **Action SHA-pinning**, `npm audit signatures`, automated dependency updates.
7. **Key management**: rotation for `WEBHOOK_SECRET` and DB credentials.
8. **Data governance**: PII classification, retention, and erasure for `reference`/`metadata`.

---

## 6. Review triggers

Revisit this document when: a real provider adapter is added; authentication is introduced;
the webhook scheme changes; a new externally-reachable endpoint is added; the deployment
model changes; or a dependency with a known-exploited advisory lands in the production tree.
