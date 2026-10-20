import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createStaticRoutesRuntime } from '../../web/server/lib/opencode/static-routes-runtime.js';
import { listen } from './mittr/test-helpers.js';
import { repoRoot } from './upstream-contract.js';
import { readWebBrand, registerBrandedWeb } from './web-brand.js';

const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
const DESKTOP_STRINGS = [...readJson('brand/visible-strings.json'), ...readJson('brand/visible-strings.prod.json')];
const WEB_DIST = 'resources/web-dist/';
const PWA_ROUTES = '.product/web/server/lib/opencode/pwa-manifest-routes.js';
const BRAND = readWebBrand();

const quoted = (text) => /'([^']*)'/.exec(text)[1];

test('the brand shipped beside the plugin is the desktop build\'s brand for the web UI and its manifest', () => {
  const expectedFiles = DESKTOP_STRINGS
    .filter((entry) => entry.file.startsWith(WEB_DIST))
    .map((entry) => ({ ...entry, file: entry.file.slice(WEB_DIST.length) }));
  assert.deepEqual(BRAND.files, expectedFiles, 'regenerate src/web-brand.json from brand/visible-strings*.json');

  const pwa = DESKTOP_STRINGS.filter((entry) => entry.file === PWA_ROUTES);
  assert.equal(pwa.length, 2);
  const [name, description] = [pwa.find((entry) => entry.from.startsWith('const DEFAULT_PWA_APP_NAME')), pwa.find((entry) => !entry.from.startsWith('const DEFAULT_PWA_APP_NAME'))];
  assert.deepEqual(BRAND.manifest, {
    name: { from: quoted(name.from), to: quoted(name.to) },
    description: { from: quoted(description.from), to: quoted(description.to) },
  });
  assert.equal(BRAND.manifest.name.to, readJson('brand/product.prod.json').appName);
});

const fromOf = (file) => BRAND.files.filter((entry) => entry.file === file).map((entry) => entry.from);

const upstreamDist = (t) => {
  const dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-web-dist-')));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><html><head>\n${fromOf('index.html').join('\n')}\n</head><body></body></html>\n`);
  fs.writeFileSync(path.join(dist, 'site.webmanifest'), `{\n${fromOf('site.webmanifest').join('\n')}\n}\n`);
  fs.writeFileSync(path.join(dist, 'sw.js'), fromOf('sw.js').join('\n'));
  fs.writeFileSync(path.join(dist, 'assets', 'main-Ab12Cd34.js'), `const t${BRAND.files.find((entry) => entry.file === 'assets/*.js' && entry.from === '="OpenChamber",').from}x;`);
  fs.writeFileSync(path.join(dist, 'assets', 'plain-Ef56Gh78.js'), 'export const plain = 1;');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
  fs.writeFileSync(path.join(path.dirname(dist), `${path.basename(dist)}-outside.js`), 'outside');
  t.after(() => fs.rmSync(path.join(path.dirname(dist), `${path.basename(dist)}-outside.js`), { force: true }));
  return dist;
};

const hostedServer = async (t, dist, { pwaAppName = '' } = {}) => {
  const app = express();
  const logger = { lines: [], log: (...args) => logger.lines.push(args.join(' ')), warn: () => {} };
  const registered = registerBrandedWeb({ app, logger }, { env: { OPENCHAMBER_DIST_DIR: dist } });
  createStaticRoutesRuntime({
    fs,
    path,
    process: { env: { OPENCHAMBER_DIST_DIR: dist } },
    __dirname: dist,
    express,
    resolveProjectDirectory: async () => ({ directory: null }),
    buildOpenCodeUrl: () => 'http://127.0.0.1:9',
    getOpenCodeAuthHeaders: () => ({}),
    readSettingsFromDiskMigrated: async () => ({ pwaAppName }),
    normalizePwaAppName: (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback),
    normalizePwaOrientation: (_value, fallback) => fallback,
    isRequestAuthorized: async () => false,
  }).registerStaticRoutes(app);
  const base = await listen(t, app);
  const get = async (route, init = {}) => {
    const response = await fetch(base + route, init);
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  return { registered, logger, get };
};

const SHELL_TITLE = '<title>MittrCraft - AI Coding Assistant</title>';

test('a hosted server serves the page, its manifest and the app code with the MittrCraft brand', async (t) => {
  const dist = upstreamDist(t);
  const { registered, logger, get } = await hostedServer(t, dist);
  assert.deepEqual(registered, { enabled: true, distDir: dist });
  assert.ok(logger.lines.some((line) => line.includes('served with the MittrCraft brand')));

  for (const route of ['/', '/index.html', '/session/abc', '/settings?tab=about']) {
    const page = await get(route);
    assert.equal(page.status, 200, route);
    assert.match(page.headers.get('content-type'), /^text\/html/, route);
    assert.ok(page.text.includes(SHELL_TITLE), route);
    assert.ok(page.text.includes('<meta name="application-name" content="MittrCraft" />'), route);
    assert.ok(!page.text.includes('OpenChamber'), `${route}: ${page.text}`);
  }

  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');

  const code = await get('/assets/main-Ab12Cd34.js');
  assert.equal(code.text, 'const t="MittrCraft",x;');
  assert.match(code.headers.get('content-type'), /javascript/);
  assert.equal(code.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await get('/assets/plain-Ef56Gh78.js')).text, 'export const plain = 1;');

  const staticManifest = await get('/site.webmanifest');
  assert.ok(staticManifest.text.includes('"name": "MittrCraft",'), staticManifest.text);
  assert.ok(!staticManifest.text.includes('OpenChamber'), staticManifest.text);
  assert.equal((await get('/sw.js')).headers.get('cache-control'), 'no-store');

  const manifest = JSON.parse((await get('/manifest.webmanifest')).text);
  assert.equal(manifest.name, 'MittrCraft');
  assert.equal(manifest.short_name, 'MittrCraft');
  assert.equal(manifest.description, 'MittrCraft, a workspace for AI coding agents');
  assert.equal(JSON.parse((await get('/manifest.webmanifest?appName=Team%20Mittr')).text).name, 'Team Mittr');

  assert.equal((await get('/favicon.svg')).text, '<svg/>');
  assert.notEqual((await get(`/assets/..%2F..%2F${path.basename(dist)}-outside.js`)).text, 'outside');
});

test('a person\'s own install name for the app is kept', async (t) => {
  const { get } = await hostedServer(t, upstreamDist(t), { pwaAppName: 'Our Craft' });
  const manifest = JSON.parse((await get('/manifest.webmanifest')).text);
  assert.equal(manifest.name, 'Our Craft');
  assert.equal(manifest.description, 'MittrCraft, a workspace for AI coding agents');
});

test('a build that already carries the brand, or none to read, is left to upstream', async (t) => {
  const branded = upstreamDist(t);
  fs.writeFileSync(path.join(branded, 'index.html'), `<html><head>${SHELL_TITLE}</head></html>`);
  const { registered, get } = await hostedServer(t, branded);
  assert.deepEqual(registered, { enabled: false });
  assert.equal(JSON.parse((await get('/manifest.webmanifest')).text).name, 'OpenChamber');

  const missing = path.join(branded, 'not-built');
  assert.deepEqual(registerBrandedWeb({ app: express(), logger: console }, { env: { OPENCHAMBER_DIST_DIR: missing } }), { enabled: false });
  assert.deepEqual(registerBrandedWeb({ app: express(), logger: console }, { env: { OPENCHAMBER_DIST_DIR: upstreamDist(t) }, brand: null }), { enabled: false });
});
