# ADR 0021: Runtime hardening and fail-closed production config

- **Status:** accepted (M4); container section amended (M4.2.2)
- **Date:** 2026-08-31

## Context

M4 makes the repository public-ready. Two related concerns: the container image should
follow least-privilege, and a real deployment must not be able to start with demo defaults
or missing safety-critical config.

## Decision

### Container

Multi-stage `Dockerfile`:

- base pinned to `node:20.20.2-bookworm-slim` at an **immutable manifest-list digest**
  (`@sha256:2cf067...`, M4.2.2 — same Node version, resolved read-only via
  `docker buildx imagetools inspect`; a manifest-list digest, not a single-arch one, so
  multi-arch pulls still resolve to the right platform);
- build stage compiles TypeScript and prunes to production dependencies (npm is used freely
  here — it never ships in the runtime stage);
- runtime stage runs a **minimal security upgrade** of the base image's OS packages
  (`apt-get update && apt-get upgrade -y --no-install-recommends`, no new packages
  installed, apt lists removed in the same layer) before dropping to the non-root user;
- runtime stage **removes the npm CLI, npx, and Corepack from the filesystem** (not just the
  `PATH`) — every runtime entry point is a plain `node <file>.js` and none of them ever
  invoke npm; this also removed npm's own bundled transitive dependencies
  (`tar`/`minimatch`/`glob`/etc.), which is what a container image scan had flagged;
- runtime stage carries only `dist/`, production `node_modules`, `package.json`, and
  `openapi/` — no `package-lock.json` (its only purpose, an in-image `npm audit`, no longer
  applies once npm is gone), no source, no tests, no dev tooling, no `.env`, no `.git` (a
  comprehensive `.dockerignore` + explicit `COPY`s);
- runs as the non-root `node` user, `NODE_ENV=production`, `STOPSIGNAL SIGTERM`;
- `HEALTHCHECK` uses `node -e fetch(...)` (no curl, no npm, in the slim image);
- writes nothing to disk → compatible with `--read-only --tmpfs /tmp --cap-drop ALL
  --security-opt no-new-privileges` (documented in the runbook);
- one image, command-overridden for API / publisher / worker / migrations.

Verified locally and in CI (`container` job): non-root uid 1000, `node` available, `npm`/
`npx` absent from both the filesystem and `PATH`, no `test`/`.git`/`.env`/`src`/
`package-lock.json` present, the app answers `/healthz` and its `HEALTHCHECK` goes
`healthy`, `/metrics` is 404 by default and 200 when opted in, SIGTERM stops it in well
under a second. A Trivy image scan (`severity HIGH,CRITICAL`, `exit-code 1`,
`ignore-unfixed`) found **no HIGH or CRITICAL findings against this build** — that is a
statement about one scan at one point in time, not a permanent guarantee; re-scan on every
build, which CI already does.

### Fail-closed config (`env.ts` `superRefine`)

When `NODE_ENV === 'production'` the process **refuses to start** if:

- `WEBHOOK_SECRET` is unset (the webhook endpoint must verify signatures);
- `ALLOW_FUNDING` is true (a real ledger has no money-creating endpoint);
- the Postgres password is still the local placeholder (`change-me-locally`) and no
  `DATABASE_URL` is given.

Development and test are unaffected. Fault injection already has no HTTP surface and
`armFault` is a no-op in production.

## Alternatives considered

- **Distroless base** — smaller and no shell, but the `HEALTHCHECK` and any debugging get
  harder; `bookworm-slim` + non-root is a reasonable first step. Noted as future work.
- **`tini`/`dumb-init` in the image** — instead rely on `--init` / `init: true` at run time
  plus the app's own signal handlers; keeps the image minimal.
- **Warn instead of refuse** on bad production config — a warning in a log nobody reads is
  how demo defaults reach production. Refusing to boot is the point.

## Consequences

- `npm start` in a plain local shell now needs real config or `NODE_ENV=development` — the
  README quick-start uses `npm run dev` (development), so this is not a friction point.
- The container test surface (`container` CI job) and `test/integration/production-guards.test.ts`
  lock in the hardening.
- **No `npm`/`npx` inside a running production container** — an operator can no longer
  `docker exec` into it and run an npm command for debugging; use the CLI locally against
  the same image's `dist/` output, or add a one-off debug image if that is ever needed.
- Digest pinning must be **re-resolved by hand** whenever the Node version is bumped (it is
  not automatic) — a Dependabot/Renovate rule for this is still an open follow-up.
- A distroless move remains open future work; `bookworm-slim` + non-root + no npm is the
  current position.
