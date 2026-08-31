#!/usr/bin/env node
/**
 * Static checks on the GitHub Actions workflows that need no network. Complements the
 * scanners that only run once the repo is on GitHub.
 *
 *   - top-level `permissions` must be present and read-only
 *   - a job may only widen `permissions` to `security-events: write` (CodeQL)
 *   - no hard security/audit gate may be neutered with `|| true`
 *   - every `uses:` must carry an `@ref`
 *   - no `${{ secrets.* }}` reference (fork PRs must run the full pipeline)
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

  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    if (job.permissions && !isReadOnly(job.permissions)) {
      const keys = Object.entries(job.permissions)
        .filter(([, v]) => v === 'write')
        .map(([k]) => k);
      const allowed = keys.length === 1 && keys[0] === 'security-events';
      if (!allowed) where(`job "${jobName}" grants write permissions: ${keys.join(', ')}`);
    }
    for (const step of job.steps ?? []) {
      if (step.uses && !/@[\w.-]+$/.test(step.uses)) {
        where(`job "${jobName}": \`uses: ${step.uses}\` has no @ref`);
      }
      if (typeof step.run === 'string') {
        for (const line of step.run.split('\n')) {
          if (line.includes('|| true') && HARD_GATE.test(line)) {
            where(`job "${jobName}": security gate neutered with \`|| true\` → ${line.trim()}`);
          }
        }
      }
    }
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
