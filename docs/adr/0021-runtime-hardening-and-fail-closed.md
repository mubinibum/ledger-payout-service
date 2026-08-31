# ADR 0021: Runtime hardening and fail-closed production config

- **Status:** accepted (M4)
- **Date:** 2026-08-31

## Context

M4 makes the repository public-ready. Two related concerns: the container image should
follow least-privilege, and a real deployment must not be able to start with demo defaults
or missing safety-critical config.

## Decision

### Container

Multi-stage `Dockerfile`:

- base pinned to `node:20.20.2-bookworm-slim` (a specific patch; a digest pin is a
  pre-public checklist item);
- build stage compiles TypeScript and prunes to production dependencies;
- runtime stage carries only `dist/`, production `node_modules`, `package.json` +
  `package-lock.json`, and `openapi/` — no source, no tests, no dev tooling, no `.env`,
  no `.git` (a comprehensive `.dockerignore` + explicit `COPY`s);
- runs as the non-root `node` user, `NODE_ENV=production`, `STOPSIGNAL SIGTERM`;
- `HEALTHCHECK` uses `node -e fetch(...)` (no curl in the slim image);
- writes nothing to disk → compatible with `--read-only --tmpfs /tmp --cap-drop ALL
  --security-opt no-new-privileges` (documented in the runbook);
- one image, command-overridden for API / publisher / worker / migrations.

Verified locally: non-root uid 1000, `npm audit --omit=dev` = 0 inside the image, no
`test`/`.git`/`.env`/`src` present, healthcheck goes `healthy`, SIGTERM stops it in <1 s.

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
- Base-image digest pinning and a distroless move remain open.
