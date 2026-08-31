# Dependency & license review

- **Status:** M4
- **Method:** `npm audit`, `scripts/check-licenses.mjs`, `scripts/generate-sbom.mjs`,
  manual review of the direct dependency set.

## 1. Vulnerabilities

### Production dependencies — **0**, and this is a hard gate

```
npm audit --omit=dev  →  0 vulnerabilities (info/low/moderate/high/critical all 0)
```

Verified both in the working tree and inside the built runtime image. CI runs
`npm audit --omit=dev --audit-level=low` as a **hard gate** (`verify` job).

### Development dependencies — 5 moderate, accepted

| Advisory | Path | Severity | Exposure |
|---|---|---|---|
| `uuid` — missing buffer bounds check in v3/v5/v6 when `buf` is supplied | `testcontainers` → `dockerode` → `uuid` | moderate | dev/test only |

The four other rows `npm audit` prints (`testcontainers`, `dockerode`,
`@testcontainers/postgresql`, `@testcontainers/redis`) are the **same advisory** surfaced at
each level of the dependency path.

**Why accepted, not fixed now:**

- `testcontainers` is a **devDependency** used only to spin up throwaway PostgreSQL/Redis
  containers for the integration tests. It is **not** in the production dependency closure
  (`npm audit --omit=dev` = 0) and **not** in the runtime image (verified — the image has no
  `uuid`, no `testcontainers`).
- The advisory requires calling `uuid` with a caller-provided `buf` argument; `testcontainers`
  and `dockerode` do not expose that path to us.
- The only fix is `testcontainers@12` — a **semver-major** bump that also pulls `undici` 7→8,
  `dockerode` 4→5, and ~55 new transitive packages (mostly esbuild platform binaries). That
  is a disproportionate change to the test harness for a dev-only, non-exploitable advisory.

**Conditions for revisiting:** the advisory is upgraded to high/critical; a fix lands
without a major bump; `testcontainers@12` is adopted for another reason; or `uuid` appears
anywhere in the production tree.

CI keeps the dev audit visible (informational step, never `|| true`-hidden) so a *new* or
*worse* advisory is not silently absorbed.

## 2. Licenses

`scripts/check-licenses.mjs` (a **hard CI gate**) reads the `license` field of every resolved
**production** package and fails on anything not on a permissive allow-list.

### Production closure — all permissive

| Count | License |
|---|---|
| ~74 | MIT |
| ~6 | BSD-3-Clause |
| ~4 | ISC |
| ~3 | Apache-2.0 |
| ~1 | 0BSD |

**No GPL / AGPL / LGPL / MPL / EPL / CDDL / SSPL / BUSL / "UNLICENSED" / unknown.** All are
compatible with releasing this project under **MIT**.

### Full tree (incl. dev) — spot check

A scan of the entire installed tree (~400 packages) found only permissive licenses: MIT,
Apache-2.0, ISC, BSD-2/3-Clause, BlueOak-1.0.0, 0BSD, Unlicense, and one `Python-2.0`
(`argparse`, a permissive PSF license). No copyleft anywhere.

### Project license

`LICENSE` is MIT, `"Copyright (c) 2026 Fathanmubina"`. `package.json` declares
`"license": "MIT"` and `"author": "Fathanmubina"`. No reason was found during the audit to
choose anything else. (The git commit author handle is `mubinibum` — a pre-existing
identity kept intentionally; it does not affect licensing.)

## 3. Direct dependencies — why each is here

| Package | Role | License |
|---|---|---|
| `fastify` | HTTP framework | MIT |
| `zod` | request/response + env validation | MIT |
| `kysely` | typed SQL query builder + migrator | MIT |
| `pg` | PostgreSQL driver | MIT |
| `bullmq` | Redis-backed job queue for the payout worker | MIT |
| `ioredis` | Redis client (BullMQ peer) | MIT |
| `pino` | structured logging | MIT |

Dev-only: `typescript`, `tsx`, `vitest`, `eslint` + `typescript-eslint`, `prettier`,
`testcontainers` (+ `@testcontainers/postgresql`, `@testcontainers/redis`), `pino-pretty`,
`yaml` (OpenAPI tooling), `@types/*`.

## 4. SBOM

`npm run sbom` writes a deterministic **CycloneDX 1.5** document (`sbom.json`, production
scope, ~82 components, no timestamp/serial so it diffs cleanly). Produced fresh as a CI
artefact on every run; gitignored locally.

## 5. Supply-chain posture

- `npm ci` from a committed `package-lock.json` (`lockfileVersion: 3`).
- Production audit hard gate; license hard gate; SBOM per build.
- Trivy (fs / config / image) and CodeQL configured in CI — they run once the repo is on
  GitHub (not available locally; configuration statically validated).
- **Open item:** GitHub Actions are pinned to version tags, not commit SHAs. Re-pinning to
  full SHAs is a blocker in `PUBLIC_RELEASE_CHECKLIST.md`.
- **Open item:** `npm audit signatures` / provenance verification not yet enabled.
