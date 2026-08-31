# Public release checklist

- **Status:** `READY_FOR_REMOTE_CREATION`
- **Date:** 2026-08-31 (M4.1.1 — final post-redaction verification)
- **Meaning of the status:** every item below is done and independently re-verified,
  read-only, after the history rewrite. **Creating the remote and pushing remain manual
  steps the owner performs** — nothing in this repository, and no automation here, does
  either of those.

## 0. History redaction — RESOLVED (verified 2026-08-31)

The owner ran `git filter-repo --invert-paths` to remove `scripts/scan-proprietary.mjs`
from the entire history, then added back only the already-sanitized working-tree version in
one new commit. Verified, read-only, after the fact:

- Every commit hash from the one that first introduced the file through the last pre-rewrite
  commit **no longer exists** in the object database (checked individually) — only the three
  commits that predate the file (`fa857bb`, `80f5912`, `471d13b`) kept their original hashes,
  exactly as expected.
- The file's entire reachable history is now **one commit** (`chore(security): restore
  sanitized proprietary scan`) — no older version is reachable from any ref.
- A content-level scan of **all 283 reachable blobs** (structural rules + the gitignored
  local term list) found **zero** local-term matches anywhere in history. The only remaining
  hits are benign placeholder connection strings (`.env.example`, CI throwaway Postgres
  creds, a test fixture) — not real credentials, and not a new finding.
- Commit messages, tags, and branch/reachable-path names: no local-term match anywhere.
- Full-history `gitleaks` (18 commits): clean, no secrets.
- `git fsck --full --strict`: clean. No dangling/backup objects.
- No remote is attached; working tree is clean; branch is `main`.

The gitignored `scripts/proprietary-terms.local.txt` was never committed at any point and
remains untracked.

## 1. Content & identity — DONE

- [x] No secrets in the working tree (`.env` gitignored; only placeholder `.env.example`).
- [x] No secrets in git history — `gitleaks` full-history scan (18 commits): clean.
- [x] No real company / client / brand / internal-host names anywhere in **reachable git
      history** — verified by content scan of every reachable blob, not just the working
      tree (see §0).
- [x] Git author identity reviewed with the owner — kept as `mubinibum <mubinaf29@…>` by
      explicit choice; unaffected by the path-removal rewrite (verified unchanged on the
      surviving commits).
- [x] `LICENSE` present (MIT); `package.json` has `license`, `author`, `keywords`.
- [x] `repository` / `homepage` / `bugs` point at the confirmed public target
      (`github.com/mubinibum/ledger-payout-service`) — the remote itself does not exist yet.
      OpenAPI `info.contact.url` matches.
- [x] No tracked binaries, dumps, `.DS_Store`, or large blobs (largest is
      `package-lock.json`).
- [x] `README.md` rewritten public-facing; `SECURITY.md`, `CONTRIBUTING.md`,
      `CHANGELOG.md` present; no broken local links (`npm run docs:links`).

## 2. Safety of the running code — DONE

- [x] Funding endpoint returns `403` unless `ALLOW_FUNDING=true`; production **refuses to
      boot** with it enabled.
- [x] Production refuses to boot without `WEBHOOK_SECRET` or with a placeholder DB password.
- [x] Fault injection has no HTTP surface and is a no-op when `NODE_ENV=production`.
- [x] Mock provider and its control API are a **separate process**, not part of the API
      runtime.
- [x] Manual-review resolution is a **local CLI only** — no HTTP admin endpoint, no
      hardcoded token, no pseudo-auth.
- [x] `/metrics` is opt-in (default off → 404); its labels carry no id / key / reference /
      error string.
- [x] Example credentials in `.env.example` are clearly non-production placeholders.
- [x] Automated public-surface test (`test/unit/public-surface.test.ts`) asserts no
      admin/fault/mock/internal route is registered and security headers are present.

## 3. Quality & security gates — DONE (locally)

- [x] `npm run check` green — format, lint, typecheck, `openapi:check`, `docs:links`,
      `workflow:check`, `licenses:check`, 192 tests, build, `compose:config`,
      `scan:proprietary`.
- [x] Production `npm audit --omit=dev` = **0**.
- [x] Dev `npm audit` = 5 moderate, reviewed and accepted (dev-only, one root cause) —
      `docs/DEPENDENCY_LICENSE_REVIEW.md`.
- [x] All production dependency licenses permissive (`scripts/check-licenses.mjs`).
- [x] CycloneDX SBOM generates deterministically (`npm run sbom`).
- [x] OpenAPI 3.1 spec valid and in sync with the routes (`npm run openapi:check` +
      `test/unit/openapi.test.ts`).
- [x] Docker image builds; runs as non-root (`uid 1000`); `NODE_ENV=production`; in-image
      `npm audit --omit=dev` = 0; no `test` / `.git` / `.env` / `src` in the image;
      healthcheck reports `healthy`; SIGTERM stops it in <1 s.
- [x] `.github/workflows/ci.yml` — `permissions: contents: read`; gitleaks (full history),
      Trivy (fs/config/image), CodeQL, container verification, SBOM + license gates; no
      `|| true` on any hard gate; **every `uses:` pinned to a full 40-character immutable
      commit SHA**, resolved read-only from each action's upstream repository, with a
      human-readable version comment; `scripts/check-workflow.mjs` enforces this statically
      — re-confirmed intact after the history rewrite.
- [x] Threat model (`docs/THREAT_MODEL.md`) and runbook (`docs/RUNBOOK.md`) written.

## 4. Follow-ups before enabling public CI — NOT BLOCKING the push

- [x] ~~Re-pin every third-party GitHub Action to a full commit SHA~~ — done.
- [ ] Enable `npm audit signatures` / provenance verification.
- [ ] Add Dependabot or Renovate (incl. the Node base-image digest, and to keep the SHA pins
      current as upstream actions release new versions).
- [ ] Pin the Docker base image to a digest.
- [ ] Confirm Trivy / CodeQL / gitleaks actually run green on the remote (they cannot run
      locally; configuration was validated statically).
- [ ] Decide on a distroless runtime base (future hardening).

## 5. Explicitly out of scope (do NOT do as part of "going public")

- Creating the GitHub remote, pushing, or enabling Pages / a demo deployment.
- Adding authentication or an admin API just to look complete.
- A real payment-provider integration.
- Kubernetes / cloud manifests.
- Putting the local benchmark numbers in a résumé or the README headline.

## 6. The actual "go public" steps (for the owner, on approval)

1. Create the empty public repo `mubinibum/ledger-payout-service` on GitHub.
2. `git remote add origin https://github.com/mubinibum/ledger-payout-service.git` and
   `git push -u origin main`.
3. Watch the first CI run go green on GitHub (Actions are already SHA-pinned; nothing else
   to change there).
4. Consider the §4 follow-ups (Dependabot, base-image digest, provenance) at your pace.
