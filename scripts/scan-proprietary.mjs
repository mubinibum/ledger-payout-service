#!/usr/bin/env node
/**
 * Fails the build if something that looks proprietary or secret leaks into the repository.
 *
 * This project is a public engineering demonstration written by an author who has also
 * worked on real payment systems professionally. The risk is that a real company/client
 * name, an internal hostname, a private schema prefix, or a credential gets pasted in by
 * accident. This scanner is the safety net.
 *
 * DESIGN: the scanner itself is public, so it must not *contain* the very strings it is
 * meant to keep out. It uses two layers:
 *
 *   1. STRUCTURAL rules (below) — patterns that match a *shape* (RFC1918 address, AWS key
 *      id, `.internal` hostname, `dbo.` schema prefix, `password = "…"` assignment) without
 *      naming any real system. These ship in the repo and run everywhere, incl. public CI.
 *
 *   2. A LOCAL term list — `scripts/proprietary-terms.local.txt`, one regex per line. That
 *      file is gitignored and is where the author keeps the actual company / brand / host
 *      names. It is read if present and skipped if absent, so `git clone && npm run
 *      scan:proprietary` still works for an outside contributor. See the committed
 *      `scripts/proprietary-terms.local.txt.example` for the format.
 *
 * Generic engineering vocabulary (`ledger`, `payout`, `outbox`, `webhook`, `idempotency`,
 * `Kafka`, `Debezium`, `CDC`, `reconciliation`, …) is expected here and is never matched.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const ROOT = process.cwd();
const SELF = join('scripts', 'scan-proprietary.mjs');
const LOCAL_TERMS = join('scripts', 'proprietary-terms.local.txt');

/**
 * Structural rules. Each matches a shape, not a name. `allowExample` rules tolerate the
 * reserved `example.com` / `example.org` / `*.example` / `localhost` placeholders so docs
 * and templates can show a URL without tripping the scanner.
 */
const STRUCTURAL_RULES = [
  {
    name: 'private-tld-hostname',
    re: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:internal|intranet|corp|lan)\b/i,
    kind: 'internal-only hostname',
    allowExample: true,
  },
  {
    name: 'company-cctld-domain',
    re: /\b[a-z0-9-]{2,}\.co\.(?:id|uk|jp|kr|nz|za|in|th)\b/i,
    kind: 'company ccTLD domain',
    allowExample: true,
  },
  {
    name: 'self-hosted-gitlab-host',
    re: /\bgitlab\.(?!com\b)[a-z0-9-]+(?:\.[a-z]{2,})+/i,
    kind: 'self-hosted GitLab hostname',
    allowExample: true,
  },
  {
    name: 'private-registry-host',
    re: /\b(?:harbor|nexus|artifactory)\.[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})*/i,
    kind: 'private container/artifact registry host',
    allowExample: true,
  },
  {
    name: 'rfc1918-address',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    kind: 'private-network IP address',
    allowExample: false,
  },
  {
    name: 'aws-access-key-id',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    kind: 'AWS access key id',
    allowExample: false,
  },
  {
    name: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    kind: 'private key material',
    allowExample: false,
  },
  {
    name: 'sqlserver-schema-prefix',
    re: /\bdbo\.[A-Za-z_]/,
    kind: 'SQL Server owner-schema prefix (foreign to a PostgreSQL project)',
    allowExample: false,
  },
  {
    name: 'hardcoded-credential-assignment',
    re: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|bearer)["'\s]*[:=]\s*["']([^"'\s${<]{8,})["']/i,
    kind: 'hard-coded credential-looking assignment',
    allowExample: false,
    // Tested against the captured VALUE only (group 1), not the whole line.
    placeholder:
      /change-me|replace-with|replace-me|^your-|example|^test|dummy|fake|placeholder|redacted|secret|sample|demo|local|xxxx|0000|1234/i,
  },
];

const EXAMPLE_HOST = /\bexample\.(?:com|org|net)\b|\.example\b|\blocalhost\b|\b127\.0\.0\.1\b/i;

/** Compile the optional local term list into extra rules. */
function loadLocalRules() {
  const path = join(ROOT, LOCAL_TERMS);
  if (!existsSync(path)) return [];
  const rules = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((raw, idx) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      try {
        rules.push({
          name: `local-term:${idx + 1}`,
          re: new RegExp(line, 'i'),
          kind: 'entry from scripts/proprietary-terms.local.txt',
          allowExample: false,
        });
      } catch {
        console.error(`  ! ${LOCAL_TERMS}:${idx + 1} is not a valid regex — skipped`);
      }
    });
  return rules;
}

const RULES = [...STRUCTURAL_RULES, ...loadLocalRules()];

const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo', '.vitest']);
const IGNORE_FILES = new Set(['package-lock.json']);
const EXTRA_BASENAMES = new Set([
  'Dockerfile',
  '.dockerignore',
  '.gitignore',
  '.env.example',
  '.prettierignore',
]);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.sql',
  '.env',
  '.example',
  '.txt',
  '.sh',
  '.toml',
  '.ini',
  '',
]);

/** @type {{file: string, line: number, rule: string, kind: string, hint: string}[]} */
const hits = [];

function scannable(entry, rel) {
  if (rel === SELF || rel === LOCAL_TERMS) return false;
  if (rel === `${LOCAL_TERMS}.example`) return false;
  if (IGNORE_FILES.has(basename(entry))) return false;
  if (EXTRA_BASENAMES.has(basename(entry))) return true;
  return TEXT_EXT.has(extname(entry));
}

/** @param {string} dir */
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (statSync(full).isDirectory()) {
      if (!IGNORE_DIRS.has(entry)) walk(full);
      continue;
    }
    if (!scannable(entry, rel)) continue;

    readFileSync(full, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        for (const rule of RULES) {
          const m = rule.re.exec(text);
          if (!m) continue;
          if (rule.allowExample && EXAMPLE_HOST.test(text)) continue;
          if (rule.placeholder && rule.placeholder.test(m[1] ?? text)) continue;
          hits.push({
            file: rel,
            line: i + 1,
            rule: rule.name,
            kind: rule.kind,
            hint: text.trim().slice(0, 80),
          });
        }
      });
  }
}

walk(ROOT);

if (hits.length > 0) {
  console.error('Proprietary / secret scan FAILED:\n');
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.rule}] ${h.kind}`);
    console.error(`      > ${h.hint}`);
  }
  console.error(
    '\nReplace the real value with a generic placeholder (example.com, <redacted>, …).',
  );
  console.error('If this is a false positive, narrow the rule in scripts/scan-proprietary.mjs.');
  process.exit(1);
}

const localCount = RULES.length - STRUCTURAL_RULES.length;
console.log(
  `Proprietary / secret scan clean — ${STRUCTURAL_RULES.length} structural rule(s)` +
    (localCount > 0
      ? ` + ${localCount} local term(s) from ${LOCAL_TERMS}.`
      : ` (no ${LOCAL_TERMS} present).`),
);
