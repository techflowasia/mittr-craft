#!/usr/bin/env node
// Regenerates THIRD-PARTY-NOTICES.md from the dependencies that actually ship.
//
// Only `dependencies` and `optionalDependencies` are walked, transitively, from
// the root manifest and every workspace package. devDependencies are skipped on
// purpose: build-only tooling is never handed to a user, so its licenses carry
// no distribution obligation. `sharp` is the reason this distinction matters —
// it pulls LGPL libvips but is build-only here.
//
// Usage: node scripts/generate-third-party-notices.mjs [--check]
//   --check  exit non-zero when the committed file is stale (for CI)

import { readFileSync, existsSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'THIRD-PARTY-NOTICES.md');
const checkOnly = process.argv.includes('--check');

// The engine binary is fetched from GitHub Releases at desktop build time
// (packages/electron/scripts/prepare-opencode-cli.mjs), so it never appears in
// node_modules and has to be declared here to be listed at all.
const EXTRA_COMPONENTS = [
  {
    name: 'opencode',
    version: 'see @opencode-ai/sdk pin in package.json',
    license: 'MIT',
    repository: 'https://github.com/anomalyco/opencode',
    note: 'Command-line binary downloaded at desktop build time and redistributed inside the desktop application bundle.',
  },
];

const readManifest = (dir) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

const workspaceManifests = () => {
  const manifests = [{ dir: repoRoot, pkg: readManifest(repoRoot) }];
  const packagesDir = path.join(repoRoot, 'packages');
  if (!existsSync(packagesDir)) return manifests;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const pkg = readManifest(dir);
    if (pkg) manifests.push({ dir, pkg });
  }
  return manifests;
};

// Bun's isolated layout stores real package directories under node_modules/.bun
// and symlinks them into place, so resolution walks up from the *real* path of
// the dependent rather than its symlinked location.
const resolvePackageDir = (name, fromDir) => {
  let current = realpathSync(fromDir);
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)(\..*)?$/i;

const readLicenseText = (dir) => {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const matches = names.filter((n) => LICENSE_FILE.test(n)).sort();
  if (matches.length === 0) return null;
  const parts = [];
  for (const name of matches) {
    try {
      // Normalize line endings: some packages ship CRLF license files, and git
      // stores this file as LF, so leaving them as-is makes `--check` report a
      // drift that no edit can fix.
      const text = readFileSync(path.join(dir, name), 'utf8').replace(/\r\n?/g, '\n').trim();
      if (text) parts.push(matches.length > 1 ? `----- ${name} -----\n${text}` : text);
    } catch {
      /* unreadable license file: fall back to the SPDX id alone */
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
};

const normalizeLicense = (pkg) => {
  const raw = pkg.license ?? pkg.licenses;
  if (!raw) return 'UNKNOWN';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((entry) => (typeof entry === 'string' ? entry : entry?.type ?? 'UNKNOWN')).join(' OR ');
  }
  return raw.type ?? 'UNKNOWN';
};

const normalizeRepository = (pkg) => {
  const repo = pkg.repository;
  const url = typeof repo === 'string' ? repo : repo?.url;
  if (!url) return pkg.homepage ?? null;
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
};

const collect = () => {
  const found = new Map();
  const queue = [];
  const workspaceNames = new Set();

  for (const { pkg } of workspaceManifests()) {
    if (pkg?.name) workspaceNames.add(pkg.name);
  }

  for (const { dir, pkg } of workspaceManifests()) {
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg?.[section] ?? {})) {
        // workspace:* entries are our own packages, not third-party code.
        if (workspaceNames.has(name) || String(range).startsWith('workspace:')) continue;
        queue.push({ name, fromDir: dir });
      }
    }
  }

  const missing = new Set();
  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    const dir = resolvePackageDir(name, fromDir);
    if (!dir) {
      missing.add(name);
      continue;
    }
    const pkg = readManifest(dir);
    if (!pkg) {
      missing.add(name);
      continue;
    }
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) continue;
    found.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: normalizeLicense(pkg),
      repository: normalizeRepository(pkg),
      licenseText: readLicenseText(dir),
    });
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [depName, range] of Object.entries(pkg[section] ?? {})) {
        if (workspaceNames.has(depName) || String(range).startsWith('workspace:')) continue;
        queue.push({ name: depName, fromDir: dir });
      }
    }
  }

  return { components: [...found.values()], missing: [...missing].sort() };
};

const render = ({ components, missing }) => {
  const sorted = [...components].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  );
  const byLicense = new Map();
  for (const component of sorted) {
    const list = byLicense.get(component.license) ?? [];
    list.push(component);
    byLicense.set(component.license, list);
  }

  const lines = [];
  lines.push('# Third-Party Notices');
  lines.push('');
  lines.push('MittrCraft is distributed with the third-party components listed below. Each');
  lines.push('component remains under its own license and the notices reproduced here apply to');
  lines.push('that component only, not to MittrCraft as a whole.');
  lines.push('');
  lines.push('Generated by `node scripts/generate-third-party-notices.mjs` — do not edit by hand.');
  lines.push('Build-only tooling is intentionally excluded: it is never redistributed.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| License | Components |');
  lines.push('| --- | ---: |');
  for (const [license, list] of [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`| ${license} | ${list.length} |`);
  }
  lines.push('');

  if (EXTRA_COMPONENTS.length > 0) {
    lines.push('## Components bundled outside the package manager');
    lines.push('');
    for (const extra of EXTRA_COMPONENTS) {
      lines.push(`### ${extra.name}`);
      lines.push('');
      lines.push(`- Version: ${extra.version}`);
      lines.push(`- License: ${extra.license}`);
      if (extra.repository) lines.push(`- Source: ${extra.repository}`);
      if (extra.note) lines.push(`- Note: ${extra.note}`);
      lines.push('');
    }
  }

  if (missing.length > 0) {
    lines.push('## Unresolved');
    lines.push('');
    lines.push('These declared dependencies could not be resolved from node_modules when this');
    lines.push('file was generated. Install dependencies and regenerate before shipping.');
    lines.push('');
    for (const name of missing) lines.push(`- ${name}`);
    lines.push('');
  }

  lines.push('## Components');
  lines.push('');
  for (const component of sorted) {
    lines.push(`### ${component.name}@${component.version}`);
    lines.push('');
    lines.push(`- License: ${component.license}`);
    if (component.repository) lines.push(`- Source: ${component.repository}`);
    lines.push('');
    if (component.licenseText) {
      lines.push('```');
      lines.push(component.licenseText.replace(/```/g, "'''"));
      lines.push('```');
      lines.push('');
    } else {
      lines.push(`No license file shipped with this package; see \`${component.license}\` terms at its source.`);
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
};

const result = collect();
const rendered = render(result);

if (checkOnly) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (current !== rendered) {
    console.error('THIRD-PARTY-NOTICES.md is out of date. Run: node scripts/generate-third-party-notices.mjs');
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.md is up to date (${result.components.length} components).`);
} else {
  writeFileSync(outputPath, rendered);
  console.log(`Wrote THIRD-PARTY-NOTICES.md: ${result.components.length} components.`);
  if (result.missing.length > 0) {
    console.warn(`Unresolved dependencies: ${result.missing.join(', ')}`);
  }
}
