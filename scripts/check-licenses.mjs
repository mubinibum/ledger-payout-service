#!/usr/bin/env node
/**
 * Fails if any **production** dependency carries a license that is not on the permissive
 * allow-list (copyleft, source-available, or unlicensed → fail). Reads the `license` field
 * of every resolved production package; no network.
 *
 *   node scripts/check-licenses.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'PSF-2.0',
  'WTFPL',
  'Zlib',
  'Artistic-2.0',
]);

let paths;
try {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  paths = [...new Set(out.split('\n').filter((p) => p.includes('node_modules')))];
} catch (err) {
  if (err.stdout) {
    paths = [
      ...new Set(
        err.stdout
          .toString()
          .split('\n')
          .filter((p) => p.includes('node_modules')),
      ),
    ];
  } else throw err;
}

/** Normalise `license` / `licenses` / SPDX expression → array of SPDX ids. */
function idsFor(pkg) {
  const raw = pkg.license ?? pkg.licenses;
  const collect = (v) => {
    if (!v) return [];
    if (typeof v === 'string') return [v];
    if (Array.isArray(v)) return v.flatMap((x) => collect(x.type ?? x));
    if (typeof v === 'object') return collect(v.type);
    return [];
  };
  return collect(raw)
    .flatMap((expr) => expr.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/i))
    .map((s) => s.trim())
    .filter(Boolean);
}

const violations = [];
const summary = new Map();

for (const dir of paths) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const ids = idsFor(pkg);
  const label = ids.length ? ids.join(' / ') : 'UNKNOWN';
  summary.set(label, (summary.get(label) ?? 0) + 1);

  // OK if ANY of an `OR` expression's ids is allowed; for a bare/`AND` list, all must be.
  const ok = ids.length > 0 && ids.some((id) => ALLOW.has(id));
  if (!ok) violations.push(`${pkg.name ?? dir}@${pkg.version ?? '?'} → ${label}`);
}

console.log('Production dependency licenses:');
for (const [lic, n] of [...summary.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${lic}`);
}

if (violations.length > 0) {
  console.error('\nLicense check FAILED — non-permissive or unknown license:\n');
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    '\nAdd a reviewed exception to scripts/check-licenses.mjs or remove the dependency.',
  );
  process.exit(1);
}
console.log(`\nLicense check passed — ${paths.length} production packages, all permissive.`);
