#!/usr/bin/env node
/**
 * Static checks on the GitHub Actions workflows that need no network. Complements the
 * scanners that only run once the repo is on GitHub.
 *
 *   - top-level `permissions` must be present and read-only
 *   - a job may only widen `permissions` to `security-events: write` (CodeQL)
 *   - no hard security/audit gate may be neutered with `|| true` or `continue-on-error`
 *   - every `uses:` must be pinned to a full 40-character immutable commit SHA
 *     (M4.1 — no branch, no tag, no short SHA), with a human-readable version comment
 *   - no `${{ secrets.* }}` reference (fork PRs must run the full pipeline)
 *   - (M4.2.1) no `run:` step pipes a remote download straight into a shell
 *     (`curl ... | sh`, `wget ... | bash`, etc.)
 *   - (M4.2.1) a job that downloads a release binary/archive over curl/wget also verifies
 *     its checksum (`sha256sum`/`shasum`) in the same job before using it
 *   - (M4.2.1) no pinned tool version is the literal string `latest` or a bare branch name
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const DIR = join(process.cwd(), '.github', 'workflows');
const HARD_GATE = /\b(audit|trivy|gitleaks|codeql|scan:proprietary|check-licenses|license)\b/i;
const problems = [];

const isReadOnly = (perms) => {
  if (perms === 'read-all') return true;
  if (perms && typeof perms === 'object') {
    return Object.values(perms).every((v) => v === 'read' || v === 'none');
  }
  return false;
};

for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const raw = readFileSync(join(DIR, file), 'utf8');
  const doc = parse(raw);
  const where = (m) => problems.push(`${file}: ${m}`);

  if (!doc.permissions) where('missing top-level `permissions:` (expected read-only)');
  else if (!isReadOnly(doc.permissions)) where('top-level `permissions:` is not read-only');

  const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i;
  const FETCHES_BINARY = /\b(?:curl|wget)\b/i;
  const UNPACKS_ARCHIVE = /\.(?:tar\.gz|tgz|zip)\b|\btar\s+x|\bunzip\b/i;
  const CHECKSUM_VERIFIED = /\b(?:sha256sum|shasum|sha512sum|gpg\s+--verify)\b/i;
  const FLOATING_VERSION = /_VERSION\s*:\s*['"]?(?:latest|main|master|head)['"]?\s*$/im;

  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    if (job.permissions && !isReadOnly(job.permissions)) {
      const keys = Object.entries(job.permissions)
        .filter(([, v]) => v === 'write')
        .map(([k]) => k);
      const allowed = keys.length === 1 && keys[0] === 'security-events';
      if (!allowed) where(`job "${jobName}" grants write permissions: ${keys.join(', ')}`);
    }

    const jobScripts = [];
    let jobDownloadsArchive = false;
    for (const step of job.steps ?? []) {
      if (step.uses) {
        const at = step.uses.lastIndexOf('@');
        const ref = at >= 0 ? step.uses.slice(at + 1) : '';
        if (!/^[0-9a-f]{40}$/i.test(ref)) {
          where(
            `job "${jobName}": \`uses: ${step.uses}\` is not pinned to a full 40-char commit SHA`,
          );
        }
      }
      if (
        (step['continue-on-error'] === true || step['continue-on-error'] === 'true') &&
        (HARD_GATE.test(step.name ?? '') || HARD_GATE.test(step.run ?? ''))
      ) {
        where(`job "${jobName}": hard gate step neutered with \`continue-on-error: true\``);
      }
      if (typeof step.run === 'string') {
        jobScripts.push(step.run);
        if (FETCHES_BINARY.test(step.run) && UNPACKS_ARCHIVE.test(step.run)) {
          jobDownloadsArchive = true;
        }
        for (const line of step.run.split('\n')) {
          if (line.includes('|| true') && HARD_GATE.test(line)) {
            where(`job "${jobName}": security gate neutered with \`|| true\` → ${line.trim()}`);
          }
          if (PIPE_TO_SHELL.test(line)) {
            where(`job "${jobName}": remote download piped directly into a shell → ${line.trim()}`);
          }
        }
      }
      if (step.env) {
        for (const [k, v] of Object.entries(step.env)) {
          if (/_VERSION$/.test(k) && /^(latest|main|master|head)$/i.test(String(v))) {
            where(`job "${jobName}": ${k} is not pinned to a specific version (got "${v}")`);
          }
        }
      }
    }
    if (jobDownloadsArchive && !CHECKSUM_VERIFIED.test(jobScripts.join('\n'))) {
      where(
        `job "${jobName}": downloads an archive over curl/wget without a checksum verification step`,
      );
    }
  }
  if (FLOATING_VERSION.test(raw)) {
    where('a *_VERSION value is a floating branch name instead of a pinned release');
  }

  // Every SHA-pinned `uses:` line must carry a human-readable version comment, and no
  // TODO about pinning may remain.
  for (const line of raw.split('\n')) {
    if (/^\s*(?:-\s*)?uses:\s*\S+@[0-9a-f]{40}\s*$/i.test(line)) {
      where(`line without a trailing version comment: ${line.trim()}`);
    }
  }
  if (/TODO.*(?:SHA|pin)/i.test(raw)) {
    where('leftover TODO about SHA pinning');
  }

  if (/\$\{\{\s*secrets\./.test(raw)) {
    where('references `${{ secrets.* }}` — this pipeline must run without secrets');
  }
}

if (problems.length > 0) {
  console.error('Workflow static check FAILED:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Workflow static check passed.');
