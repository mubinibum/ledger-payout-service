# Public release checklist

- **Status:** `BLOCKED` — one blocker, §0. Everything else in §1–§3 is done.
- **Date:** 2026-08-31 (M4)
- **Meaning of the status:** the working tree is clean and safe, but **git history still
  contains real company/brand names** inside old versions of `scripts/scan-proprietary.mjs`.
  That must be redacted (a history rewrite) before the repo is pushed anywhere public.
  Creating the remote and pushing is a manual step the owner performs — nothing in this
  milestone does it.

## 0. BLOCKER — redact proprietary names from git history

The pre-M4 `scripts/scan-proprietary.mjs` embedded the real client / employer / brand /
internal-host names as scanner patterns. They are in every commit from the first
(`fa857bb`) through `321a081`. The M4 rework (`e43e64e`) removed them from the working tree,
but **history is unchanged**. `git log -p -- scripts/scan-proprietary.mjs` still shows them.

Claude prepared and validated a redaction but the history-rewrite command was blocked by the
session's safety classifier. **The owner runs it**, then re-runs the checks below and flips
this file to `READY_FOR_REMOTE`. The real term list is in `scripts/proprietary-terms.local.txt`
(gitignored) — the commands below read from it so no name is written into a tracked file.

Recommended — install `git-filter-repo`, then:

```sh
awk 'NF && $1 !~ /^#/ { print "regex:" $0 "==>redacted-identifier" }' \
  scripts/proprietary-terms.local.txt > /tmp/redactions.txt
git filter-repo --replace-text /tmp/redactions.txt --force
rm /tmp/redactions.txt
```

Or, with stock git only (slower; keeps a backup ref in `refs/original/`):

```sh
node -e '
  const fs=require("fs");
  const terms=fs.readFileSync("scripts/proprietary-terms.local.txt","utf8")
    .split("\n").map(l=>l.trim()).filter(l=>l && !l.startsWith("#"));
  fs.writeFileSync("/tmp/redact.mjs",
    `import {readFileSync,writeFileSync,existsSync} from "node:fs";
     const f="scripts/scan-proprietary.mjs";
     if(existsSync(f)){let s=readFileSync(f,"utf8");`+
     terms.map(t=>`s=s.replace(new RegExp(${JSON.stringify(t)},"gi"),"redacted-identifier");`).join("")+
     `writeFileSync(f,s);}`);
'
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force \
  --tree-filter 'node /tmp/redact.mjs' -- --all
git for-each-ref --format='%(refname)' refs/original/ | xargs -n1 git update-ref -d
git reflog expire --expire=now --all && git gc --prune=now --aggressive
rm /tmp/redact.mjs
```

Then verify — this must print nothing:

```sh
git grep -f <(sed -E 's/[[:space:]]+//g; /^#/d; /^$/d' scripts/proprietary-terms.local.txt) \
  $(git rev-list --all) || echo "history is clean"
```

This changes every commit hash. The repo has no remote and no other clone, so the cost is
zero. Afterwards: re-run `npm run check`, re-run the gitleaks scan, and set this status to
`READY_FOR_REMOTE`.

## 1. Content & identity — DONE

- [x] No secrets in the working tree (`.env` gitignored; only placeholder `.env.example`).
- [x] No secrets in git history — `gitleaks` over all commits: clean.
- [x] No real company / client / brand / internal-host names in the working tree —
      `scripts/scan-proprietary.mjs` reworked to structural rules + a gitignored local
      term list; the file itself no longer contains any literal name.
- [ ] **BLOCKED** — real company / client / brand / internal-host names are still in git
      history inside old `scripts/scan-proprietary.mjs` versions (see §0). Working tree is
      clean; history rewrite is pending the owner.
- [x] Git author identity reviewed with the owner — kept as `mubinibum <mubinaf29@…>` by
      explicit choice; no author rewrite.
- [x] `LICENSE` present (MIT); `package.json` has `license`, `author`, `keywords`.
- [x] `repository` / `homepage` / `bugs` URLs are obvious placeholders
      (`OWNER-PLACEHOLDER`) pending the real remote — flagged by `npm run docs:links` if
      they leak into docs.
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

- [x] `npm run check` green — format, lint, typecheck, `openapi:check`, `docs:links`, 192
      tests, build, `compose:config`, `scan:proprietary`.
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
      `|| true` on any hard gate; `scripts/check-workflow.mjs` enforces these statically.
- [x] Threat model (`docs/THREAT_MODEL.md`) and runbook (`docs/RUNBOOK.md`) written.

## 4. Follow-ups before enabling public CI — NOT BLOCKING the push

- [ ] **Re-pin every third-party GitHub Action to a full commit SHA** (currently on version
      tags; marked `TODO(pre-public)` in `ci.yml`). Blast radius today is limited — the
      pipeline is read-only and uses no secrets — but SHA-pinning is the correct posture.
- [ ] Enable `npm audit signatures` / provenance verification.
- [ ] Add Dependabot or Renovate (incl. the Node base-image digest).
- [ ] Pin the Docker base image to a digest.
- [ ] Confirm Trivy / CodeQL / gitleaks actually run green on the remote (they cannot run
      locally; configuration was validated statically).
- [ ] Fill in the real `repository` / `homepage` / `bugs` URLs once the remote name exists.
- [ ] Decide on a distroless runtime base (future hardening).

## 5. Explicitly out of scope (do NOT do as part of "going public")

- Creating the GitHub remote, pushing, or enabling Pages / a demo deployment.
- Adding authentication or an admin API just to look complete.
- A real payment-provider integration.
- Kubernetes / cloud manifests.
- Putting the local benchmark numbers in a résumé or the README headline.

## 6. The actual "go public" steps (for the owner, later, on approval)

1. Create the empty public repo `ledger-payout-service` under your account.
2. `git remote add origin <url>` and `git push -u origin main`.
3. Do the §4 follow-ups (Action SHA-pins first).
4. Watch the first CI run go green on GitHub.
5. Update `package.json` URLs and re-commit.
