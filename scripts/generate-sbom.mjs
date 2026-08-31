#!/usr/bin/env node
/**
 * Generates a CycloneDX 1.5 SBOM for the **production** dependency closure (what ships in
 * the container) into `sbom.json`.
 *
 * Deterministic: no timestamp, no serial number, components sorted by purl. That means the
 * file only changes when the dependency graph changes, so CI can diff it. It is gitignored
 * locally and produced fresh as a CI artefact. Uses only `npm ls` output — no network, no
 * extra tooling.
 *
 *   node scripts/generate-sbom.mjs            # production deps (default)
 *   node scripts/generate-sbom.mjs --all      # include devDependencies
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const includeDev = process.argv.includes('--all');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const args = ['ls', '--all', '--json', '--long=false'];
if (!includeDev) args.push('--omit=dev');

let tree;
try {
  tree = JSON.parse(execFileSync('npm', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch (err) {
  // `npm ls` exits non-zero on peer-dep warnings but still prints valid JSON on stdout.
  if (err.stdout) tree = JSON.parse(err.stdout.toString());
  else throw err;
}

/** name -> Set(version) across the whole resolved tree. */
const seen = new Map();
function walk(deps) {
  for (const [name, node] of Object.entries(deps ?? {})) {
    if (!node || typeof node !== 'object') continue;
    if (node.version) {
      if (!seen.has(name)) seen.set(name, new Set());
      seen.get(name).add(node.version);
    }
    walk(node.dependencies);
  }
}
walk(tree.dependencies);

const purl = (name, version) => `pkg:npm/${name.replace('@', '%40')}@${version}`;

const components = [];
for (const [name, versions] of seen) {
  for (const version of versions) {
    components.push({
      type: 'library',
      'bom-ref': purl(name, version),
      name,
      version,
      purl: purl(name, version),
    });
  }
}
components.sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': `pkg:npm/${pkg.name}@${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      licenses: [{ license: { id: pkg.license } }],
    },
    properties: [{ name: 'scope', value: includeDev ? 'all' : 'production' }],
  },
  components,
};

writeFileSync('sbom.json', `${JSON.stringify(bom, null, 2)}\n`);
console.log(
  `sbom.json written — ${components.length} components (${includeDev ? 'all' : 'production'} scope).`,
);
