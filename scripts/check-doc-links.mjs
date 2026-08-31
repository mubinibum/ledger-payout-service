#!/usr/bin/env node
/**
 * Fails if any Markdown file in the repo has a broken **local** link — a relative link to a
 * file or directory that does not exist. External `http(s)` links are not fetched (CI runs
 * offline for this gate); they are only sanity-checked for a leftover placeholder host.
 *
 * Anchor-only links (`#section`) and `mailto:` are ignored.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const PLACEHOLDER_HOST_RE = /OWNER-PLACEHOLDER|your-account|<owner>|example-user/i;

const mdFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!IGNORE_DIRS.has(entry)) walk(full);
    } else if (extname(entry) === '.md') {
      mdFiles.push(full);
    }
  }
})(ROOT);

const problems = [];
let localChecked = 0;
let externalSeen = 0;

for (const file of mdFiles) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(LINK_RE)) {
    let target = (match[1] ?? '').trim().split(/\s+/)[0] ?? '';
    if (!target || target.startsWith('#') || target.startsWith('mailto:')) continue;

    if (/^https?:\/\//i.test(target)) {
      externalSeen += 1;
      if (PLACEHOLDER_HOST_RE.test(target)) {
        problems.push(`${rel}: link still points at a placeholder host → ${target}`);
      }
      continue;
    }

    const path = target.split('#')[0].split('?')[0];
    if (!path) continue;
    localChecked += 1;
    const resolved = join(dirname(file), path);
    if (!existsSync(resolved)) {
      problems.push(`${rel}: broken local link → ${target}`);
    }
  }
}

if (problems.length > 0) {
  console.error('Doc link check FAILED:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `Doc link check passed — ${mdFiles.length} files, ${localChecked} local links OK, ${externalSeen} external links skipped.`,
);
