#!/usr/bin/env node
/**
 * Builds the MittrCraft desktop app, Dev or prod, from upstream's own build
 * steps plus the files under `brand/`.
 *
 *   node scripts/mittr/build-desktop.mjs --flavor dev|prod
 *   node scripts/mittr/build-desktop.mjs --flavor dev --gate
 *   node scripts/mittr/build-desktop.mjs --check-strings [--flavor dev|prod] [--gate]
 *
 * It runs upstream's `package` chain one step at a time so the visible-string
 * replacement can sit between the last build step and electron-builder, and it
 * stages the product inputs where the packaged app reads them:
 * `packages/electron/.product/product.json` and the splash logo it names
 * (packed at the app root) and `packages/electron/product-plugins/mittr-server.mjs`.
 * All are build output and are never committed. The plugin bundle is rebuilt
 * from source on every run, and packing stops if any source it was built
 * from is newer than the bundle.
 *
 * The packed app carries upstream's MIT licence as
 * `Contents/Resources/LICENSE.openchamber.txt`, and the build ends with the
 * brand-leak scan on the packed app: a leak fails the build.
 *
 * The engine gets ripgrep from the app instead of downloading it: the build
 * stages `rg` and its licences from the release archive pinned in
 * `scripts/mittr/ripgrep.json` (read from the electron build cache, or the
 * path in `MITTRCRAFT_RIPGREP_ARCHIVE`; the build never downloads it) into
 * `Contents/Resources/ripgrep`, and checks the packed copy at the end.
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

import { resolveTargetArchitecture } from '../../packages/electron/scripts/target-architecture.mjs';
import { matcherFor } from '../../packages/mittr-server/src/brand-matcher.js';
import { resolveBunExecutable } from '../lib/bun-executable.mjs';
import { AGENT_BROWSER_RESOURCE_DIR, CUA_DRIVER_RESOURCE_DIR, NOTICES_RESOURCE, assertDriverArchitecture, checkDriverSources, checkNotices, stageDrivers, verifyPackedDrivers } from './drivers.mjs';
import { RIPGREP_RESOURCE_DIR, defaultRipgrepArchive, readPinnedArchive, readRipgrepPin, stageRipgrep, verifyPackedRipgrep } from './ripgrep.mjs';
import { VAD_DIR, VAD_WEB_DIST, checkBundledOrtVersion, checkVadNotices, readVadPins, resolveVadSources, stageVadAssets, verifyPackedVadAssets } from './vad-assets.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const brandDir = path.join(repoRoot, 'brand');
const electronDir = path.join(repoRoot, 'packages', 'electron');
const stagingDir = path.join(electronDir, '.product');
const pluginsDir = path.join(electronDir, 'product-plugins');
const serverPluginEntry = path.join(repoRoot, 'packages', 'mittr-server', 'src', 'plugin.js');
const serverPluginBundle = path.join(pluginsDir, 'mittr-server.mjs');
const webServerSource = path.join(repoRoot, 'packages', 'web', 'server');

const FLAVORS = ['dev', 'prod'];
const USAGE = `Usage: node scripts/mittr/build-desktop.mjs --flavor ${FLAVORS.join('|')} [--gate]`;

const DEV_NAME = 'MittrCraft Dev';
const DEV_FOLDER = 'mittrcraft-dev';
const GATE = Object.freeze({ appName: 'MittrCraft Gate', idSuffix: '.gate', folder: 'mittrcraft-gate', desktopPort: 57188 });

export const RIPGREP_STAGING = `.product/${RIPGREP_RESOURCE_DIR}`;
export const AGENT_BROWSER_STAGING = `.product/${AGENT_BROWSER_RESOURCE_DIR}`;
export const CUA_DRIVER_STAGING = `.product/${CUA_DRIVER_RESOURCE_DIR}`;

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
    const matcher = matcherFor(entry.from);
    const counted = fs.globSync(pattern, { cwd })
      .map((relative) => path.join(cwd, relative))
      .filter((target) => fs.statSync(target).isFile())
      .map((target) => ({ target, count: matcher.count(read(target)) }))
      .filter(({ count }) => count > 0);
    const found = counted.reduce((total, { count }) => total + count, 0);
    if (found === entry.count) {
      for (const { target } of counted) texts.set(target, matcher.replace(texts.get(target), entry.to));
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
  if (!FLAVORS.includes(flavor)) throw new Error(USAGE);
  return flavor;
};

export const parseBuildArgs = (argv) => {
  const flavor = parseFlavor(argv);
  const gate = argv.includes('--gate');
  if (gate && flavor !== 'dev') throw new Error(`--gate builds only from --flavor dev\n${USAGE}`);
  return { flavor, gate };
};

const gateName = (text) => text.replaceAll(DEV_NAME, GATE.appName);
const gatePath = (text) => gateName(text.replace(new RegExp(`/${DEV_FOLDER}(?=/|$)`, 'g'), `/${GATE.folder}`));
const gateId = (id) => `${id}${GATE.idSuffix}`;

const gateProduct = (product) => ({
  ...product,
  appName: GATE.appName,
  linuxDesktopName: `${GATE.folder}.desktop`,
  desktopPort: GATE.desktopPort,
  appUserModelId: { packaged: gateId(product.appUserModelId.packaged), dev: gateId(product.appUserModelId.dev) },
  env: Object.fromEntries(Object.entries(product.env).map(([key, value]) => [key, gatePath(value)])),
  ensureDirs: product.ensureDirs.map(gatePath),
});

const gateOverlay = (overlay) => {
  const { entry } = overlay.linux.desktop;
  return {
    ...overlay,
    appId: gateId(overlay.appId),
    productName: GATE.appName,
    protocols: overlay.protocols.map((protocol) => ({ ...protocol, name: gateName(protocol.name) })),
    mac: {
      ...overlay.mac,
      extendInfo: { ...overlay.mac.extendInfo, NSLocalNetworkUsageDescription: gateName(overlay.mac.extendInfo.NSLocalNetworkUsageDescription) },
    },
    linux: {
      ...overlay.linux,
      executableName: GATE.folder,
      desktop: { ...overlay.linux.desktop, entry: { ...entry, Name: gateName(entry.Name), Comment: gateName(entry.Comment), Icon: GATE.folder, StartupWMClass: GATE.folder } },
    },
  };
};

const gateBrand = ({ product, overlay, visibleStrings }) => ({
  product: gateProduct(product),
  overlay: gateOverlay(overlay),
  visibleStrings: visibleStrings.map((entry) => ({ ...entry, to: gateName(entry.to) })),
});

export const readBrand = ({ flavor, gate = false, dir = brandDir }) => {
  const brand = {
    product: readJson(path.join(dir, `product.${flavor}.json`)),
    overlay: readJson(path.join(dir, `electron-builder.${flavor}.json`)),
    visibleStrings: readVisibleStrings(flavor, dir),
  };
  return gate ? gateBrand(brand) : brand;
};

export const stageProductFile = ({ flavor, gate, product, outDir, dir = brandDir }) => {
  const target = path.join(outDir, 'product.json');
  if (gate) fs.writeFileSync(target, `${JSON.stringify(product, null, 2)}\n`);
  else fs.copyFileSync(path.join(dir, `product.${flavor}.json`), target);
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
export const assertConsistent = ({ product, builderConfig }) => {
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
export const stringsToCheck = (argv, dir = brandDir) => {
  const named = argv.some((arg) => arg.startsWith('--flavor'));
  if (argv.includes('--gate')) {
    const { flavor } = parseBuildArgs(named ? argv : ['--flavor', 'dev', ...argv]);
    return [{ label: `${flavor} gate`, entries: readBrand({ flavor, gate: true, dir }).visibleStrings }];
  }
  return (named ? [parseFlavor(argv)] : FLAVORS).map((flavor) => ({ label: flavor, entries: readBrand({ flavor, dir }).visibleStrings }));
};

const checkStrings = (argv) => {
  let failed = false;
  for (const { label, entries } of stringsToCheck(argv)) {
    const { results, mismatches } = planVisibleStrings({
      entries,
      rootDir: electronDir,
      sources: { [`${STAGED_SERVER}/`]: webServerSource },
    });
    if (mismatches.length === 0) {
      console.log(`[mittr] ${label}: all ${results.length} visible-string entries match`);
      continue;
    }
    failed = true;
    console.error(`[mittr] ${label}: ${mismatches.length} of ${results.length} visible-string entries do not match\n${describeMismatches(mismatches)}`);
  }
  return failed ? 1 : 0;
};

export const LICENCE_RESOURCE = 'LICENSE.openchamber.txt';

/** The `.app` this build packed for `productName`, the newest one under `distDir`. */
export const findPackedApp = ({ productName, distDir, startedAt = 0 }) => {
  if (!fs.existsSync(distDir)) return null;
  return fs.readdirSync(distDir)
    .map((entry) => path.join(distDir, entry, `${productName}.app`))
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).mtimeMs >= startedAt)
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] ?? null;
};

/**
 * Checks the packed app before the build counts as done: upstream's licence
 * is in its resources, and the brand-leak scan exits 0. `scan` runs the scan
 * and returns its exit code.
 */
export const verifyPackedApp = ({ appPath, scan }) => {
  const licence = path.join(appPath, 'Contents', 'Resources', LICENCE_RESOURCE);
  if (!fs.existsSync(licence)) throw new Error(`the packed app has no ${LICENCE_RESOURCE}: ${licence}`);
  const status = scan(appPath);
  if (status !== 0) throw new Error(`the brand-leak scan of ${appPath} failed (exit ${status})`);
};

export const buildServerPlugin = ({ bun, outfile, metafile }) => {
  run(bun, [
    'build', serverPluginEntry,
    '--target=node', '--format=esm',
    '--external', 'electron', '--external', '@openchamber/web', '--external', '@openchamber/web/*',
    '--outfile', outfile,
    `--metafile=${metafile}`,
  ], repoRoot);
};

export const assertPluginBundleFresh = ({ bundle, metafile, rootDir = repoRoot }) => {
  if (!fs.existsSync(bundle)) throw new Error(`the server plugin ${bundle} was not built`);
  const builtAt = fs.statSync(bundle).mtimeMs;
  const sources = Object.keys(readJson(metafile).inputs).filter((input) => !input.split('/').includes('node_modules'));
  const newer = sources.find((source) => fs.statSync(path.resolve(rootDir, source)).mtimeMs > builtAt);
  if (newer) throw new Error(`the server plugin ${path.relative(rootDir, bundle)} is older than its source ${newer}; run the build again`);
  return sources;
};

export const checkRipgrepArchive = ({ env = process.env } = {}) => {
  const pin = readRipgrepPin();
  const archive = defaultRipgrepArchive(pin, env);
  readPinnedArchive({ archive, pin });
  return { pin, archive };
};

const runLeakScan = (appPath) => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'mittr', 'brand-leak-scan.mjs'), appPath], { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const main = async () => {
  if (process.argv.includes('--check-strings')) {
    process.exitCode = checkStrings(process.argv.slice(2));
    return;
  }
  const { flavor, gate } = parseBuildArgs(process.argv.slice(2));
  const { pin: ripgrepPin, archive: ripgrepArchive } = checkRipgrepArchive();
  assertDriverArchitecture(resolveTargetArchitecture().node);
  const drivers = checkDriverSources();
  checkNotices({ pins: drivers.pins });
  const vadPins = readVadPins();
  checkVadNotices({ pins: vadPins });
  const vadSources = resolveVadSources({ pins: vadPins });
  const startedAt = Date.now();
  const bun = resolveBunExecutable();

  const { product: productOverride, overlay: builderOverlay, visibleStrings } = readBrand({ flavor, gate });

  const { readProduct } = await import(pathToFileURL(path.join(electronDir, 'product.mjs')).href);
  const upstreamBuild = readJson(path.join(electronDir, 'package.json')).build;
  const merged = mergeBuilderConfig(upstreamBuild, builderOverlay);
  const builderConfig = { ...merged, files: [...merged.files, ...stagedServerFiles(merged.asarUnpack)] };
  assertConsistent({ product: productOverride, builderConfig });

  console.log(`[mittr] building ${builderConfig.productName} (${builderConfig.appId}) ${builderConfig.extraMetadata?.version ?? ''}`);

  step('1/8 workspace build');
  run(bun, ['run', 'build'], repoRoot);

  step('2/8 server plugin bundle');
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  const pluginMetaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-build-plugin-'));
  const pluginMetafile = path.join(pluginMetaDir, 'meta.json');
  buildServerPlugin({ bun, outfile: serverPluginBundle, metafile: pluginMetafile });

  step('3/8 product files, server copy, ripgrep, drivers and notices');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  stageProductFile({ flavor, gate, product: productOverride, outDir: stagingDir });
  if (productOverride.splashSvg) {
    fs.copyFileSync(path.join(brandDir, productOverride.splashSvg), path.join(stagingDir, productOverride.splashSvg));
  }
  fs.cpSync(webServerSource, path.join(electronDir, STAGED_SERVER), { recursive: true });
  const ripgrep = stageRipgrep({ archive: ripgrepArchive, pin: ripgrepPin, outDir: path.join(electronDir, RIPGREP_STAGING) });
  console.log(`[mittr] ripgrep ${ripgrepPin.version} staged for the engine: ${path.relative(repoRoot, ripgrep.binary)}`);
  const staged = stageDrivers({ pins: drivers.pins, agentBrowserBinary: drivers.agentBrowserBinary, cuaArchive: drivers.cuaArchive, outDir: stagingDir });
  console.log(`[mittr] agent-browser ${drivers.pins.agentBrowser.version} and cua-driver ${drivers.pins.cuaDriver.version} staged: ${path.relative(repoRoot, staged.agentBrowser)}, ${path.relative(repoRoot, staged.cuaApp)}`);
  const product = readProduct({ appPath: stagingDir });
  for (const entry of productOverride.serverPlugins ?? []) {
    if (!fs.existsSync(path.join(electronDir, entry))) throw new Error(`server plugin ${entry} was not built`);
  }
  console.log(`[mittr] product: ${product.appName}, scheme ${product.deepLinkProtocol}, port ${product.desktopPort}`);

  step('4/8 upstream desktop build steps');
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
  const webDist = path.join(electronDir, 'resources', VAD_WEB_DIST);
  const vadStaged = stageVadAssets({ pins: vadPins, sources: vadSources, outDir: path.join(webDist, VAD_DIR) });
  const ortChunks = checkBundledOrtVersion({ webDist, pins: vadPins, required: true });
  console.log(`[mittr] ${vadStaged.length} VAD files staged beside the renderer: ${path.relative(repoRoot, path.join(webDist, VAD_DIR))}; ${ortChunks.length} bundled ONNX Runtime chunks carry the pinned version`);

  step('5/8 visible strings');
  for (const { file, from, count } of applyVisibleStrings({ entries: visibleStrings, rootDir: electronDir })) {
    console.log(`[mittr] ${count}x ${JSON.stringify(from)} in ${file}`);
  }
  if (visibleStrings.length === 0) console.log('[mittr] none listed');

  step('6/8 package');
  try {
    assertPluginBundleFresh({ bundle: serverPluginBundle, metafile: pluginMetafile });
  } finally {
    fs.rmSync(pluginMetaDir, { recursive: true, force: true });
  }
  const configFile = path.join(stagingDir, 'electron-builder.json');
  fs.writeFileSync(configFile, `${JSON.stringify(builderConfig, null, 2)}\n`);
  run(process.execPath, [path.join('scripts', 'package.mjs'), '--config', configFile], electronDir);

  step('7/8 result');
  const dmg = findDmg({ productName: builderConfig.productName, startedAt });
  if (process.platform === 'darwin' && !dmg) throw new Error(`no ${builderConfig.productName} dmg was produced in packages/electron/dist`);
  console.log(dmg ?? `[mittr] no dmg on ${process.platform}; see packages/electron/dist`);

  if (process.platform === 'darwin') {
    step('8/8 licence, brand-leak scan, ripgrep, drivers and notices');
    const appPath = findPackedApp({ productName: builderConfig.productName, distDir: path.join(electronDir, 'dist'), startedAt });
    if (!appPath) throw new Error(`no ${builderConfig.productName}.app was produced in packages/electron/dist`);
    verifyPackedApp({ appPath, scan: runLeakScan });
    verifyPackedRipgrep({ appPath, pin: ripgrepPin });
    const packedDrivers = verifyPackedDrivers({ appPath, pins: drivers.pins });
    const packedVad = verifyPackedVadAssets({ appPath, pins: vadPins });
    console.log(`[mittr] ${LICENCE_RESOURCE} and ripgrep ${ripgrepPin.version} are packed and the brand-leak scan passed: ${appPath}`);
    console.log(`[mittr] agent-browser ${packedDrivers.agentBrowserVersion}, cua-driver ${packedDrivers.cuaDriverVersion} (team ${packedDrivers.cuaTeamIdentifier}) and ${NOTICES_RESOURCE} are packed`);
    console.log(`[mittr] ${packedVad.length} VAD files are packed under Contents/Resources/${VAD_WEB_DIST}/${VAD_DIR} with their pinned sha256 values`);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[mittr] ${error.message}`);
    process.exit(1);
  });
}
