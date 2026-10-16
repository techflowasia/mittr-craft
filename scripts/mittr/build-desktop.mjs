#!/usr/bin/env node
/**
 * Builds the MittrCraft desktop app, Dev or prod, from upstream's own build
 * steps plus the files under `brand/`.
 *
 *   node scripts/mittr/build-desktop.mjs --flavor dev|prod
 *
 * It runs upstream's `package` chain one step at a time so the visible-string
 * replacement can sit between the last build step and electron-builder, and it
 * stages the product inputs where the packaged app reads them:
 * `packages/electron/.product/product.json` (packed as `product.json` at the
 * app root) and `packages/electron/product-plugins/mittr-server.mjs`. Both
 * are build output and are never committed.
 *
 * electron-builder's `--config` replaces the `build` block in
 * `packages/electron/package.json` instead of merging with it, so the brand
 * config is an overlay applied here: upstream's block with only our keys
 * changed, written to `.product/electron-builder.json` and passed as the
 * config. The merge rules are in `mergeBuilderConfig`.
 */

import { spawnSync } from 'node:child_process';
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

const FLAVORS = ['dev', 'prod'];

// Build output the visible-string replacement may touch, relative to
// `packages/electron`.
const VISIBLE_STRING_ROOTS = ['resources/web-dist/', 'dist-bundle/'];

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

/**
 * Replaces each `{ file, from, to, count }` entry's exact `from` with `to` in
 * the files its glob matches under `rootDir`. An entry whose match count is
 * not exactly `count` fails the build: upstream moved, reworded or repeated the
 * string, and shipping its text unnoticed (or a replacement in a place nobody
 * looked at) is the failure this list exists to prevent.
 */
export const applyVisibleStrings = ({ entries, rootDir }) => {
  const applied = [];
  for (const entry of visibleStringsSchema.parse(entries)) {
    const { file, from, to } = entry;
    if (!VISIBLE_STRING_ROOTS.some((root) => file.startsWith(root)) || file.split('/').includes('..')) {
      throw new Error(`visible-strings entry ${JSON.stringify(file)} must start with one of ${VISIBLE_STRING_ROOTS.join(', ')}`);
    }
    const matches = fs.globSync(file, { cwd: rootDir })
      .map((relative) => path.join(rootDir, relative))
      .filter((target) => fs.statSync(target).isFile())
      .map((target) => ({ target, parts: fs.readFileSync(target, 'utf8').split(from) }))
      .filter(({ parts }) => parts.length > 1);
    const found = matches.reduce((total, { parts }) => total + parts.length - 1, 0);
    if (found !== entry.count) {
      throw new Error(`visible-strings entry ${JSON.stringify(entry)} expected ${entry.count} matches, found ${found}`);
    }
    for (const { target, parts } of matches) fs.writeFileSync(target, parts.join(to));
    applied.push({ file, from, count: found });
  }
  return applied;
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

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
  const problems = [
    builderConfig.productName !== product.appName && `productName ${builderConfig.productName} != appName ${product.appName}`,
    builderConfig.appId !== product.appUserModelId?.packaged && `appId ${builderConfig.appId} != appUserModelId.packaged ${product.appUserModelId?.packaged}`,
    !schemes.includes(product.deepLinkProtocol) && `protocols do not declare ${product.deepLinkProtocol}`,
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

const main = async () => {
  const flavor = parseFlavor(process.argv.slice(2));
  const startedAt = Date.now();
  const bun = resolveBunExecutable();

  const productSource = path.join(brandDir, `product.${flavor}.json`);
  const productOverride = readJson(productSource);
  const builderOverlay = readJson(path.join(brandDir, `electron-builder.${flavor}.json`));
  const visibleStrings = visibleStringsSchema.parse(readJson(path.join(brandDir, 'visible-strings.json')));

  const { readProduct } = await import(pathToFileURL(path.join(electronDir, 'product.mjs')).href);
  const upstreamBuild = readJson(path.join(electronDir, 'package.json')).build;
  const builderConfig = mergeBuilderConfig(upstreamBuild, builderOverlay);
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

  step('3/7 product file');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.copyFileSync(productSource, path.join(stagingDir, 'product.json'));
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
