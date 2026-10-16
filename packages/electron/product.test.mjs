import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  UPSTREAM_PRODUCT,
  applyProductEnv,
  ensureProductDirs,
  readProduct,
  readSplashSvg,
  resolveAppNames,
} from './product.mjs';

const HOME = '/home/someone';
const APP_PATH = '/opt/app/resources/app';

const fakeFs = (files) => ({
  readFileSync(file) {
    if (!Object.hasOwn(files, file)) {
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    }
    return files[file];
  },
});

const productFile = (value) => fakeFs({ [path.join(APP_PATH, 'product.json')]: JSON.stringify(value) });

test('UPSTREAM_PRODUCT is frozen and equals the upstream literals', () => {
  assert.equal(Object.isFrozen(UPSTREAM_PRODUCT), true);
  assert.equal(Object.isFrozen(UPSTREAM_PRODUCT.links), true);
  assert.deepEqual(UPSTREAM_PRODUCT, {
    appName: 'OpenChamber',
    linuxDesktopName: 'openchamber.desktop',
    deepLinkProtocol: 'openchamber',
    appUserModelId: {
      packaged: 'dev.openchamber.desktop',
      dev: 'dev.openchamber.desktop.dev',
    },
    desktopPort: 57123,
    links: {
      bugReport: 'https://github.com/openchamber/openchamber/issues/new?template=bug_report.yml',
      ideas: 'https://github.com/openchamber/openchamber/discussions/categories/ideas',
      discord: 'https://discord.gg/ZYRSdnwwKA',
    },
    updaterFeed: { provider: 'github', owner: 'openchamber', repo: 'openchamber' },
    splashSvg: null,
    env: {},
    ensureDirs: [],
    serverPlugins: [],
  });
});

test('readProduct without product.json returns UPSTREAM_PRODUCT', () => {
  assert.deepEqual(readProduct({ appPath: APP_PATH, fs: fakeFs({}), homeDir: HOME }), UPSTREAM_PRODUCT);
});

test('readProduct returns a copy that cannot change the defaults', () => {
  const product = readProduct({ appPath: APP_PATH, fs: fakeFs({}), homeDir: HOME });
  product.links.discord = 'changed';
  product.ensureDirs.push('x');
  assert.equal(UPSTREAM_PRODUCT.links.discord, 'https://discord.gg/ZYRSdnwwKA');
  assert.deepEqual(UPSTREAM_PRODUCT.ensureDirs, []);
});

test('readProduct merges product.json and expands ~/', () => {
  const product = readProduct({
    appPath: APP_PATH,
    fs: productFile({
      appName: 'X',
      appUserModelId: { dev: 'x.dev' },
      env: { A: '~/a', B: 'plain', C: '~other' },
      ensureDirs: ['~/data/projects', '/abs/themes'],
    }),
    homeDir: HOME,
  });
  assert.equal(product.appName, 'X');
  assert.equal(product.env.A, path.join(HOME, 'a'));
  assert.equal(product.env.B, 'plain');
  assert.equal(product.env.C, '~other');
  assert.deepEqual(product.ensureDirs, [path.join(HOME, 'data/projects'), '/abs/themes']);
  assert.deepEqual(product.appUserModelId, { packaged: 'dev.openchamber.desktop', dev: 'x.dev' });
  assert.equal(product.deepLinkProtocol, UPSTREAM_PRODUCT.deepLinkProtocol);
  assert.deepEqual(product.links, UPSTREAM_PRODUCT.links);
  assert.deepEqual(product.updaterFeed, UPSTREAM_PRODUCT.updaterFeed);
});

test('readProduct does not expand ~/ outside env and ensureDirs', () => {
  const product = readProduct({
    appPath: APP_PATH,
    fs: productFile({ appName: '~/name' }),
    homeDir: HOME,
  });
  assert.equal(product.appName, '~/name');
});

test('serverPlugins resolve against appPath', () => {
  const product = readProduct({
    appPath: APP_PATH,
    fs: productFile({ serverPlugins: ['plugins/one.js', '/abs/two.js'] }),
    homeDir: HOME,
  });
  assert.deepEqual(product.serverPlugins, [path.join(APP_PATH, 'plugins/one.js'), '/abs/two.js']);
});

test('splashSvg resolves against appPath and its markup replaces the default', () => {
  const splashFile = path.join(APP_PATH, 'brand', 'splash.svg');
  const files = {
    [path.join(APP_PATH, 'product.json')]: JSON.stringify({ splashSvg: 'brand/splash.svg' }),
    [splashFile]: '<svg role="img"></svg>',
  };
  const product = readProduct({ appPath: APP_PATH, fs: fakeFs(files), homeDir: HOME });
  assert.equal(product.splashSvg, splashFile);
  assert.equal(readSplashSvg(product, fakeFs(files)), '<svg role="img"></svg>');
});

test('without a splashSvg, or with one that cannot be read, the default splash stays', () => {
  const upstream = readProduct({ appPath: APP_PATH, fs: fakeFs({}), homeDir: HOME });
  assert.equal(readSplashSvg(upstream, fakeFs({})), null);
  const missing = readProduct({ appPath: APP_PATH, fs: productFile({ splashSvg: 'gone.svg' }), homeDir: HOME });
  assert.equal(readSplashSvg(missing, fakeFs({})), null);
});

test('null links and updaterFeed survive the merge', () => {
  const product = readProduct({
    appPath: APP_PATH,
    fs: productFile({ links: { bugReport: null, ideas: null, discord: null }, updaterFeed: null }),
    homeDir: HOME,
  });
  assert.deepEqual(product.links, { bugReport: null, ideas: null, discord: null });
  assert.equal(product.updaterFeed, null);
});

test('arrays replace the defaults instead of concatenating', () => {
  const product = readProduct({
    appPath: APP_PATH,
    fs: productFile({ ensureDirs: ['/one'] }),
    homeDir: HOME,
  });
  assert.deepEqual(product.ensureDirs, ['/one']);
});

test('readProduct rejects a product.json that is not valid JSON', () => {
  const badFs = fakeFs({ [path.join(APP_PATH, 'product.json')]: '{ nope' });
  assert.throws(() => readProduct({ appPath: APP_PATH, fs: badFs, homeDir: HOME }), /product\.json/);
});

test('readProduct rejects a product.json that is not an object', () => {
  assert.throws(
    () => readProduct({ appPath: APP_PATH, fs: productFile(['x']), homeDir: HOME }),
    /product\.json/,
  );
});

test('applyProductEnv overrides a preset OPENCODE_CONFIG_DIR', () => {
  const env = { OPENCODE_CONFIG_DIR: '/personal', KEEP: 'yes' };
  const keys = applyProductEnv({ env: { OPENCODE_CONFIG_DIR: '/product/opencode', NEW: '1' } }, env);
  assert.equal(env.OPENCODE_CONFIG_DIR, '/product/opencode');
  assert.equal(env.NEW, '1');
  assert.equal(env.KEEP, 'yes');
  assert.deepEqual(keys, ['OPENCODE_CONFIG_DIR', 'NEW']);
});

test('applyProductEnv with no env leaves the environment alone', () => {
  const env = { A: '1' };
  assert.deepEqual(applyProductEnv(UPSTREAM_PRODUCT, env), []);
  assert.deepEqual(env, { A: '1' });
});

test('ensureProductDirs pre-creates projects/themes/speech-models', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-dirs-'));
  try {
    const dirs = ['projects', 'themes', 'speech-models'].map((name) => path.join(root, 'data', name));
    ensureProductDirs({ ensureDirs: dirs });
    for (const dir of dirs) assert.equal(fs.statSync(dir).isDirectory(), true);
    ensureProductDirs({ ensureDirs: dirs });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('app name comes from product', () => {
  const product = readProduct({
    appPath: APP_PATH,
    fs: productFile({ appName: 'MittrCraft', linuxDesktopName: 'mittrcraft.desktop' }),
    homeDir: HOME,
  });
  assert.deepEqual(resolveAppNames(product, { isDev: true }), {
    appName: 'MittrCraft',
    linuxDesktopName: 'mittrcraft.desktop',
    devUserDataName: 'MittrCraft Dev',
  });
  assert.equal(resolveAppNames(product, { isDev: false }).devUserDataName, null);
});

test('app names without a product.json equal the upstream literals', () => {
  assert.deepEqual(resolveAppNames(UPSTREAM_PRODUCT, { isDev: true }), {
    appName: 'OpenChamber',
    linuxDesktopName: 'openchamber.desktop',
    devUserDataName: 'OpenChamber Dev',
  });
});
