# Public release checklist

- **Status:** `BLOCKED_FOR_PUBLIC_PUSH` — one blocker, §0. Everything else in §1–§3 is done.
- **Date:** 2026-08-31 (M4.1 — history-sanitization verification + CI supply-chain pinning)
- **Meaning of the status:** the working tree is clean and safe, and CI is now fully
  SHA-pinned and metadata-final, but **git history still contains real company/brand names**
  inside old versions of `scripts/scan-proprietary.mjs`. A history rewrite was attempted
  outside this session; M4.1 verified, read-only, that the rewrite **did not take effect** —
  see §0. Creating the remote and pushing is a manual step the owner performs — nothing in
  this repository does it.

## 0. BLOCKER — git history still contains the pre-redaction content

**M4.1 finding (2026-08-31): the manual history rewrite was not detected in this
repository.** Three independent, read-only checks against `~/Documents/Fathanmubina/ledger-payout-service/`:

1. `HEAD` and every commit hash on `main` are byte-identical to the pre-redaction session
   output (`git reflog show main` shows a plain linear sequence of `commit` /
   `commit (amend)` events — no rewrite operation, no `refs/original/` backup ref exists).
2. A content-level scan of **every blob reachable from every ref** (not just the tip) —
   structural patterns (RFC1918 addresses, AWS key ids, private-key blocks, `.internal`/
   self-hosted-GitLab hosts, hard-coded credential assignments) plus the entries in the
   gitignored `scripts/proprietary-terms.local.txt` — still finds **2 of the local terms**
   present inside old `scripts/scan-proprietary.mjs` blobs. (Counts only; no matched text or
   term-list content is reproduced here — see the M4.1 report.)
3. `git count-objects -v` and `git fsck --unreachable --dangling` show no pending/garbage
   objects and no dangling commits — consistent with a rewrite that was never run at all
   (not even one that was later garbage-collected).

**No rewrite was attempted by Claude in M4.1**, per instruction. This is a **verification
failure to report, not a defect to fix automatically.**

Likely causes to check on your end: the rewrite command was run against a different path
(e.g. a stale clone), it errored out silently, or a shell/quoting issue caused it to no-op.
The backup bundle `~/Documents/Fathanmubina/ledger-payout-service-before-redaction.bundle`
was **not** touched by this batch.

The redaction procedure below is unchanged from the M4 checklist and remains valid — it
reads the real term list from the gitignored `scripts/proprietary-terms.local.txt` so no
name is written into a tracked file:

Recommended — install `git-filter-repo`, then, **from inside
`~/Documents/Fathanmubina/ledger-payout-service/`**:

```sh
awk 'NF && $1 !~ /^#/ { print "regex:" $0 "==>redacted-identifier" }' \
  scripts/proprietary-terms.local.txt > /tmp/redactions.txt
git filter-repo --replace-text /tmp/redactions.txt --force
rm /tmp/redactions.txt
```

Or, with stock git only (slower; keeps a backup ref in `refs/original/` until you clean it):

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

**After running it, confirm the hashes actually changed** (this was the step that silently
failed last time) — `git log --oneline` should show a **different** short hash for every
commit from the one that first added `scripts/scan-proprietary.mjs` onward. Then verify —
this must print nothing:

```sh
git grep -f <(sed -E 's/[[:space:]]+//g; /^#/d; /^$/d' scripts/proprietary-terms.local.txt) \
  $(git rev-list --all) || echo "history is clean"
```

This changes every commit hash from that point forward. The repo has no remote and no other
clone, so the cost is zero. Afterwards: re-run `npm run check`, re-run gitleaks, re-run the
M4.1 full-history scan, and set this status to `READY_FOR_REMOTE_CREATION`.

## 1. Content & identity

- [x] No secrets in the working tree (`.env` gitignored; only placeholder `.env.example`).
- [x] No secrets in git history — `gitleaks` full-history scan (16 commits): clean.
- [x] No real company / client / brand / internal-host names in the working tree —
      `scripts/scan-proprietary.mjs` reworked to structural rules + a gitignored local
      term list; the file itself no longer contains any literal name.
- [ ] **BLOCKED** — real company / client / brand / internal-host names are still reachable
      in git history inside old `scripts/scan-proprietary.mjs` blobs (see §0). Working tree
      is clean; the history rewrite has not taken effect yet.
- [x] Git author identity reviewed with the owner — kept as `mubinibum <mubinaf29@…>` by
      explicit choice; no author rewrite (confirmed again in M4.1 — identity untouched).
- [x] `LICENSE` present (MIT); `package.json` has `license`, `author`, `keywords`.
- [x] `repository` / `homepage` / `bugs` point at the confirmed public target
      (`github.com/mubinibum/ledger-payout-service`) — the remote itself does not exist yet.
      OpenAPI `info.contact.url` updated to match.
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
      commit SHA (M4.1)**, resolved read-only from each action's upstream repository, with a
      human-readable version comment; `scripts/check-workflow.mjs` enforces this statically.
- [x] Threat model (`docs/THREAT_MODEL.md`) and runbook (`docs/RUNBOOK.md`) written.

## 4. Follow-ups before enabling public CI — NOT BLOCKING the push

- [x] ~~Re-pin every third-party GitHub Action to a full commit SHA~~ — **done in M4.1.**
- [ ] Enable `npm audit signatures` / provenance verification.
- [ ] Add Dependabot or Renovate (incl. the Node base-image digest, and to keep the M4.1
      SHA pins current as upstream actions release new versions).
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

## 6. The actual "go public" steps (for the owner, later, on approval)

1. **Fix §0 first** — get the history rewrite to actually take effect, and verify with the
   command in §0 that it printed "history is clean".
2. Create the empty public repo `mubinibum/ledger-payout-service` on GitHub.
3. `git remote add origin https://github.com/mubinibum/ledger-payout-service.git` and
   `git push -u origin main`.
4. Watch the first CI run go green on GitHub (Actions are already SHA-pinned; nothing else
   to change there).
5. Consider the §4 follow-ups (Dependabot, base-image digest, provenance).
