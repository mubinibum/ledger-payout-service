# Contributing

This is a personal portfolio project. It is not looking for feature contributions, but bug
reports, correctness observations, and design feedback are very welcome — open an issue.

## Local setup

```sh
node -v                      # 20.19–20.x (see "engines" in package.json)
npm ci
cp .env.example .env         # placeholders only; edit as needed
docker compose up -d         # local PostgreSQL + Redis
npm run migrate:up
npm run dev                  # API (add publisher / worker / mock-provider in other terminals)
```

## Before you push

`npm run check` must pass. It runs, in order:

format check → lint → typecheck → OpenAPI drift check → doc-link check → tests
(unit + integration via Testcontainers) → build → docker-compose validation →
proprietary/secret scan.

Other useful gates:

```sh
npm run test:unit         # fast, no Docker
npm run openapi:generate  # after any route change — regenerate openapi/openapi.json and commit it
npm run sbom              # regenerate the CycloneDX SBOM
node scripts/check-licenses.mjs
node scripts/check-workflow.mjs
```

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, optional
  `feat(m4): …` milestone scope).
- **TypeScript strict**; no `any` without a comment justifying it.
- **Money is integer minor units** everywhere — `bigint` in code, `BIGINT` in the DB, a
  digit string in JSON. Never a float.
- Every expected failure is a `DomainError`; anything else becomes a `500` with no internal
  detail leaked.
- New HTTP routes require an `openapi/openapi.yaml` entry (the drift test enforces it).
- Significant design decisions get an ADR in `docs/adr/`.
- Never commit real company/client names, internal hostnames, or secrets. Keep the real
  names in `scripts/proprietary-terms.local.txt` (gitignored) so the scanner still catches
  them locally.

## What not to add

Real payment-provider integrations, real credentials, a heavy UI, or anything that makes the
demo resemble a production financial system in a way that could mislead.
