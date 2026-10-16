#!/usr/bin/env node
/**
 * Builds the MittrCraft desktop app, Dev or prod, from upstream's own build
 * steps plus the files under `brand/`.
 *
 *   node scripts/mittr/build-desktop.mjs --flavor dev|prod
 *   node scripts/mittr/build-desktop.mjs --check-strings [--flavor dev|prod]
 *
 * It runs upstream's `package` chain one step at a time so the visible-string
 * replacement can sit between the last build step and electron-builder, and it
 * stages the product inputs where the packaged app reads them:
 * `packages/electron/.product/product.json` and the splash logo it names
 * (packed at the app root) and `packages/electron/product-plugins/mittr-server.mjs`.
 * All are build output and are never committed.
 *
 * electron-builder's `--config` replaces the `build` block in
 * `packages/electron/package.json` instead of merging with it, so the brand
 * config is an overlay applied here: upstream's block with only our keys
 * changed, written to `.product/electron-builder.json` and passed as the
 * config. The merge rules are in `mergeBuilderConfig`.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import { resolveBunExecutable } from '../lib/bun-executable.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const brandDir = path.join(repoRoot, 'brand');
const electronDir = path.join(repoRoot, 'packages', 'electron');
const stagingDir = path.join(electronDir, '.product');
const pluginsDir = path.join(electronDir, 'product-plugins');
const serverPluginEntry = path.join(repoRoot, 'packages', 'mittr-server', 'src', 'plugin.js');
const webServerSource = path.join(repoRoot, 'packages', 'web', 'server');

const FLAVORS = ['dev', 'prod'];

// The web server is packed straight from its workspace source, so its
// visible strings are replaced in a staged copy that is packed in its place.
const STAGED_SERVER = '.product/web/server';
const PACKED_WEB = 'node_modules/@openchamber/web';

// Build output the visible-string replacement may touch, relative to
// `packages/electron`.
const VISIBLE_STRING_ROOTS = ['resources/web-dist/', 'dist-bundle/', `${STAGED_SERVER}/`];

// File-set arrays: an overlay entry whose `to` matches an upstream entry's
// replaces it; every other overlay entry is appended.
const FILE_SET_KEYS = new Set(['files', 'extraResources', 'extraFiles']);

const visibleStringsSchema = z.array(z.object({
  file: z.string().min(1),
  from: z.string().min(1),
  to: z.string(),
  count: z.number().int().positive(),
}).strict());

const isPlainObject = (value) => value?.constructor === Object;

const mergeFileSets = (base, overlay) => {
  const merged = [...base];
  for (const entry of overlay) {
    const target = isPlainObject(entry) ? entry.to : undefined;
    const index = target === undefined ? -1 : merged.findIndex((item) => isPlainObject(item) && item.to === target);
    if (index === -1) merged.push(entry);
    else merged[index] = entry;
  }
  return merged;
};

/**
 * Upstream's `build` block with the brand overlay applied. Objects merge key
 * by key; file-set arrays merge by `to`; other arrays and scalars replace.
 * `null` replaces too, as electron-builder reads it (`publish: null` means no
 * publishing, `afterPack: null` no hook), except inside `mac.extendInfo`,
 * where a `null` removes the key: those keys are copied into Info.plist, which
 * has no null.
 */
export const mergeBuilderConfig = (base, overlay) => {
  const mergeLevel = (from, over, keyPath) => {
    const merged = { ...from };
    for (const [key, value] of Object.entries(over)) {
      const childPath = [...keyPath, key];
      if (keyPath.length === 0 && FILE_SET_KEYS.has(key) && Array.isArray(value) && Array.isArray(merged[key])) {
        merged[key] = mergeFileSets(merged[key], value);
      } else if (isPlainObject(value) && isPlainObject(merged[key])) {
        merged[key] = mergeLevel(merged[key], value, childPath);
      } else if (value === null && keyPath.join('.') === 'mac.extendInfo') {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    return merged;
  };
  return mergeLevel(base, overlay, []);
};

// Before step 5 writes a file it keeps the text it found under
// `.product/pristine`, with the hash of what it wrote. A later check reads the
// kept text for a file that is still exactly what the build wrote, so it can
// run against a tree that has already been patched.
const PRISTINE_DIR = '.product/pristine';
const PRISTINE_MANIFEST = 'manifest.json';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

const readPristineManifest = (rootDir) => {
  const file = path.join(rootDir, PRISTINE_DIR, PRISTINE_MANIFEST);
  return fs.existsSync(file) ? readJson(file) : {};
};

const assertInBuildOutput = (file) => {
  if (!VISIBLE_STRING_ROOTS.some((root) => file.startsWith(root)) || file.split('/').includes('..')) {
    throw new Error(`visible-strings entry ${JSON.stringify(file)} must start with one of ${VISIBLE_STRING_ROOTS.join(', ')}`);
  }
};

/**
 * Works out every `{ file, from, to, count }` entry in order, in memory, so a
 * later entry sees the text earlier ones produced, and writes nothing. Each
 * result has the count found and the files it matched; an entry whose count
 * is off is not applied, and every such entry is in `mismatches`.
 *
 * `sources` maps an entry path prefix to another folder to read instead, such
 * as the server source for its staged copy when only checking.
 */
export const planVisibleStrings = ({ entries, rootDir, sources = {} }) => {
  const manifest = readPristineManifest(rootDir);
  const texts = new Map();
  const originals = new Map();
  const read = (absolute) => {
    if (!texts.has(absolute)) {
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      const pristine = path.join(rootDir, PRISTINE_DIR, relative);
      const live = fs.readFileSync(absolute, 'utf8');
      const text = manifest[relative] === sha256(live) && fs.existsSync(pristine) ? fs.readFileSync(pristine, 'utf8') : live;
      texts.set(absolute, text);
      originals.set(absolute, text);
    }
    return texts.get(absolute);
  };

  const results = visibleStringsSchema.parse(entries).map((entry) => {
    assertInBuildOutput(entry.file);
    const alias = Object.keys(sources).find((prefix) => entry.file.startsWith(prefix));
    const cwd = alias ? sources[alias] : rootDir;
    const pattern = alias ? entry.file.slice(alias.length) : entry.file;
    const counted = fs.globSync(pattern, { cwd })
      .map((relative) => path.join(cwd, relative))
      .filter((target) => fs.statSync(target).isFile())
      .map((target) => ({ target, count: read(target).split(entry.from).length - 1 }))
      .filter(({ count }) => count > 0);
    const found = counted.reduce((total, { count }) => total + count, 0);
    if (found === entry.count) {
      for (const { target } of counted) texts.set(target, texts.get(target).split(entry.from).join(entry.to));
    }
    const shown = (target) => `${alias ?? ''}${path.relative(cwd, target).split(path.sep).join('/')}`;
    return { entry, found, files: counted.map(({ target, count }) => `${shown(target)}×${count}`) };
  });

  const changed = [...texts].filter(([target, text]) => text !== originals.get(target));
  return { results, mismatches: results.filter(({ entry, found }) => found !== entry.count), changed, originals };
};

export const describeMismatches = (mismatches) => mismatches
  .map(({ entry, found, files }) => `  ${JSON.stringify(entry.from)} in ${entry.file}: expected ${entry.count}, found ${found}${files.length > 0 ? ` (${files.join(', ')})` : ''}`)
  .join('\n');

/**
 * Replaces each entry's exact `from` with `to` in the files its glob matches
 * under `rootDir`. Any entry whose match count is not exactly `count` fails
 * the build before anything is written, and the error lists every such entry:
 * upstream moved, reworded or repeated the string, and shipping its text
 * unnoticed (or a replacement in a place nobody looked at) is the failure this
 * list exists to prevent.
 */
export const applyVisibleStrings = ({ entries, rootDir }) => {
  const { results, mismatches, changed, originals } = planVisibleStrings({ entries, rootDir });
  if (mismatches.length > 0) {
    throw new Error(`visible strings: ${mismatches.length} of ${results.length} entries do not match\n${describeMismatches(mismatches)}`);
  }
  const manifest = readPristineManifest(rootDir);
  for (const [target, text] of changed) {
    const relative = path.relative(rootDir, target).split(path.sep).join('/');
    const pristine = path.join(rootDir, PRISTINE_DIR, relative);
    fs.mkdirSync(path.dirname(pristine), { recursive: true });
    fs.writeFileSync(pristine, originals.get(target));
    fs.writeFileSync(target, text);
    manifest[relative] = sha256(text);
  }
  if (changed.length > 0) {
    fs.writeFileSync(path.join(rootDir, PRISTINE_DIR, PRISTINE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return results.map(({ entry, found }) => ({ file: entry.file, from: entry.from, count: found }));
};

/**
 * The builder `files` entries that pack the staged server copy in place of
 * the workspace one. Files upstream unpacks from the asar (helpers run by git,
 * built-in extensions) keep coming from the workspace: an `asarUnpack` pattern
 * matches the source path, which a mapped copy does not have. The web UI copy
 * and source HTML inside the package are left out: the desktop serves the UI
 * from `resources/web-dist`, for its own window and the loopback server alike.
 */
export const stagedServerFiles = (asarUnpack = []) => {
  const serverPrefix = `${PACKED_WEB}/server/`;
  const unpacked = asarUnpack.filter((pattern) => pattern.startsWith(serverPrefix));
  return [
    `!${PACKED_WEB}/server{,/**}`,
    ...unpacked,
    `!${PACKED_WEB}/{dist,public}{,/**}`,
    `!${PACKED_WEB}/*.html`,
    {
      from: STAGED_SERVER,
      to: `${PACKED_WEB}/server`,
      filter: ['**/*', ...unpacked.map((pattern) => `!${pattern.slice(serverPrefix.length)}`)],
    },
  ];
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * The shared `visible-strings.json` entries, then the flavor's own
 * `visible-strings.<flavor>.json` when there is one: replacements whose text
 * differs per flavor, such as the deep-link scheme. A flavor entry may match
 * text a shared entry already wrote.
 */
export const readVisibleStrings = (flavor, dir = brandDir) => {
  const flavorFile = path.join(dir, `visible-strings.${flavor}.json`);
  return [
    ...visibleStringsSchema.parse(readJson(path.join(dir, 'visible-strings.json'))),
    ...(fs.existsSync(flavorFile) ? visibleStringsSchema.parse(readJson(flavorFile)) : []),
  ];
};

const parseFlavor = (argv) => {
  const index = argv.indexOf('--flavor');
  const flavor = index === -1 ? argv.find((arg) => arg.startsWith('--flavor='))?.slice('--flavor='.length) : argv[index + 1];
  if (!FLAVORS.includes(flavor)) {
    throw new Error(`Usage: node scripts/mittr/build-desktop.mjs --flavor ${FLAVORS.join('|')}`);
  }
  return flavor;
};

const step = (label) => console.log(`\n[mittr] ${label}`);

const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(' ')} failed in ${path.relative(repoRoot, cwd) || '.'} (exit ${result.status ?? result.signal})`);
  }
};

// The product file and the builder config describe one app; a mismatch ships
// an app that registers a scheme its bundle does not declare, or a name its
// installer does not use.
const assertConsistent = ({ product, builderConfig }) => {
  const schemes = (builderConfig.protocols ?? []).flatMap((entry) => entry.schemes ?? []);
  const stagedFiles = (builderConfig.files ?? [])
    .filter((entry) => isPlainObject(entry) && entry.from === '.product')
    .flatMap((entry) => entry.filter ?? []);
  const problems = [
    builderConfig.productName !== product.appName && `productName ${builderConfig.productName} != appName ${product.appName}`,
    builderConfig.appId !== product.appUserModelId?.packaged && `appId ${builderConfig.appId} != appUserModelId.packaged ${product.appUserModelId?.packaged}`,
    !schemes.includes(product.deepLinkProtocol) && `protocols do not declare ${product.deepLinkProtocol}`,
    product.splashSvg && !stagedFiles.includes(product.splashSvg) && `files do not pack the splash logo ${product.splashSvg}`,
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`brand files disagree: ${problems.join('; ')}`);
};

const findDmg = ({ productName, startedAt }) => {
  const distDir = path.join(electronDir, 'dist');
  if (!fs.existsSync(distDir)) return null;
  return fs.readdirSync(distDir)
    .filter((name) => name.startsWith(`${productName}-`) && name.endsWith('.dmg'))
    .map((name) => path.join(distDir, name))
    .find((file) => fs.statSync(file).mtimeMs >= startedAt) ?? null;
};

/**
 * `--check-strings [--flavor dev|prod]`: checks every visible-string entry,
 * for one flavor or both, against what is built now (`resources/web-dist` and
 * `dist-bundle`, as they were before the last build patched them) and the
 * server source, writes nothing, and lists every entry whose count is off.
 */
const checkStrings = (argv) => {
  const flavors = argv.some((arg) => arg.startsWith('--flavor')) ? [parseFlavor(argv)] : FLAVORS;
  let failed = false;
  for (const flavor of flavors) {
    const { results, mismatches } = planVisibleStrings({
      entries: readVisibleStrings(flavor),
      rootDir: electronDir,
      sources: { [`${STAGED_SERVER}/`]: webServerSource },
    });
    if (mismatches.length === 0) {
      console.log(`[mittr] ${flavor}: all ${results.length} visible-string entries match`);
      continue;
    }
    failed = true;
    console.error(`[mittr] ${flavor}: ${mismatches.length} of ${results.length} visible-string entries do not match\n${describeMismatches(mismatches)}`);
  }
  return failed ? 1 : 0;
};

const main = async () => {
  if (process.argv.includes('--check-strings')) {
    process.exitCode = checkStrings(process.argv.slice(2));
    return;
  }
  const flavor = parseFlavor(process.argv.slice(2));
  const startedAt = Date.now();
  const bun = resolveBunExecutable();

  const productSource = path.join(brandDir, `product.${flavor}.json`);
  const productOverride = readJson(productSource);
  const builderOverlay = readJson(path.join(brandDir, `electron-builder.${flavor}.json`));
  const visibleStrings = readVisibleStrings(flavor);

  const { readProduct } = await import(pathToFileURL(path.join(electronDir, 'product.mjs')).href);
  const upstreamBuild = readJson(path.join(electronDir, 'package.json')).build;
  const merged = mergeBuilderConfig(upstreamBuild, builderOverlay);
  const builderConfig = { ...merged, files: [...merged.files, ...stagedServerFiles(merged.asarUnpack)] };
  assertConsistent({ product: productOverride, builderConfig });

  console.log(`[mittr] building ${builderConfig.productName} (${builderConfig.appId}) ${builderConfig.extraMetadata?.version ?? ''}`);

  step('1/7 workspace build');
  run(bun, ['run', 'build'], repoRoot);

  step('2/7 server plugin bundle');
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  run(bun, [
    'build', serverPluginEntry,
    '--target=node', '--format=esm',
    '--external', 'electron', '--external', '@openchamber/web', '--external', '@openchamber/web/*',
    '--outfile', path.join(pluginsDir, 'mittr-server.mjs'),
  ], repoRoot);

  step('3/7 product files and server copy');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.copyFileSync(productSource, path.join(stagingDir, 'product.json'));
  if (productOverride.splashSvg) {
    fs.copyFileSync(path.join(brandDir, productOverride.splashSvg), path.join(stagingDir, productOverride.splashSvg));
  }
  fs.cpSync(webServerSource, path.join(electronDir, STAGED_SERVER), { recursive: true });
  const product = readProduct({ appPath: stagingDir });
  for (const entry of productOverride.serverPlugins ?? []) {
    if (!fs.existsSync(path.join(electronDir, entry))) throw new Error(`server plugin ${entry} was not built`);
  }
  console.log(`[mittr] product: ${product.appName}, scheme ${product.deepLinkProtocol}, port ${product.desktopPort}`);

  step('4/7 upstream desktop build steps');
  // Staging the engine runs `opencode --version`, which appends to the log
  // under the XDG data home; keep that out of the builder's own OpenCode.
  const engineProbeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-engine-'));
  try {
    const engineProbeEnv = {
      ...process.env,
      ...Object.fromEntries(['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map((key) => [key, path.join(engineProbeHome, key)])),
    };
    run(bun, ['run', 'build:web-assets'], electronDir);
    run(bun, ['run', 'prepare:opencode-cli'], electronDir, engineProbeEnv);
    run(bun, ['run', 'bundle:main'], electronDir);
    run(bun, ['run', 'rebuild:native'], electronDir);
  } finally {
    fs.rmSync(engineProbeHome, { recursive: true, force: true });
  }

  step('5/7 visible strings');
  for (const { file, from, count } of applyVisibleStrings({ entries: visibleStrings, rootDir: electronDir })) {
    console.log(`[mittr] ${count}x ${JSON.stringify(from)} in ${file}`);
  }
  if (visibleStrings.length === 0) console.log('[mittr] none listed');

  step('6/7 package');
  const configFile = path.join(stagingDir, 'electron-builder.json');
  fs.writeFileSync(configFile, `${JSON.stringify(builderConfig, null, 2)}\n`);
  run(process.execPath, [path.join('scripts', 'package.mjs'), '--config', configFile], electronDir);

  step('7/7 result');
  const dmg = findDmg({ productName: builderConfig.productName, startedAt });
  if (process.platform === 'darwin' && !dmg) throw new Error(`no ${builderConfig.productName} dmg was produced in packages/electron/dist`);
  console.log(dmg ?? `[mittr] no dmg on ${process.platform}; see packages/electron/dist`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[mittr] ${error.message}`);
    process.exit(1);
  });
}
