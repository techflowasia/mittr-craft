import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createStaticRoutesRuntime } from '../../web/server/lib/opencode/static-routes-runtime.js';
import { listen } from './mittr/test-helpers.js';
import { repoRoot } from './upstream-contract.js';
import { createBrandedWeb, readWebBrand, registerBrandedWeb, servesApiOnly } from './web-brand.js';
import { WEB_BRAND_COMMAND, generateWebBrand } from './web-brand-source.js';

const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
const BRAND = readWebBrand();

test('the brand shipped beside the plugin is the desktop build\'s brand for the web UI and its manifest', () => {
  assert.deepEqual(BRAND, generateWebBrand(), `regenerate src/web-brand.json with ${WEB_BRAND_COMMAND}`);
  assert.equal(BRAND.manifest.name.to, readJson('brand/product.prod.json').appName);
});

const FIXTURE_FILES = ['index.html', 'site.webmanifest', 'sw.js'];
const FIXTURE_BRAND = {
  files: BRAND.files.filter((entry) => FIXTURE_FILES.includes(entry.file) || entry.from === '="OpenChamber",'),
  manifest: BRAND.manifest,
};

const fromOf = (file) => FIXTURE_BRAND.files.filter((entry) => entry.file === file).flatMap((entry) => Array(entry.count).fill(entry.from));

const tempDist = (t) => {
  const dist = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-web-dist-')));
  t.after(() => fs.rmSync(dist, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dist, 'assets'));
  return dist;
};

const upstreamDist = (t) => {
  const dist = tempDist(t);
  fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><html><head>\n${fromOf('index.html').join('\n')}\n</head><body></body></html>\n`);
  fs.writeFileSync(path.join(dist, 'site.webmanifest'), `{\n${fromOf('site.webmanifest').join('\n')}\n}\n`);
  fs.writeFileSync(path.join(dist, 'sw.js'), fromOf('sw.js').join('\n'));
  fs.writeFileSync(path.join(dist, 'assets', 'main-Ab12Cd34.js'), 'const t="OpenChamber",x;');
  fs.writeFileSync(path.join(dist, 'assets', 'plain-Ef56Gh78.js'), 'export const plain = 1;');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
  fs.writeFileSync(path.join(path.dirname(dist), `${path.basename(dist)}-outside.js`), 'outside');
  t.after(() => fs.rmSync(path.join(path.dirname(dist), `${path.basename(dist)}-outside.js`), { force: true }));
  return dist;
};

const recordingLogger = () => {
  const logger = { lines: [], warnings: [] };
  logger.log = (...args) => logger.lines.push(args.join(' '));
  logger.warn = (...args) => logger.warnings.push(args.join(' '));
  return logger;
};

const upstreamStaticRoutes = (dist, { pwaAppName = '' } = {}) => createStaticRoutesRuntime({
  fs,
  path,
  process: { env: { OPENCHAMBER_DIST_DIR: dist } },
  __dirname: dist,
  express,
  resolveProjectDirectory: async () => ({ directory: null }),
  buildOpenCodeUrl: () => 'http://127.0.0.1:9',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({ pwaAppName }),
  normalizePwaAppName: (value, fallback) => String(value ?? '').trim() || fallback,
  normalizePwaOrientation: (_value, fallback) => fallback,
  isRequestAuthorized: async () => false,
});

const hostedServer = async (t, dist, { pwaAppName = '', brand = FIXTURE_BRAND, env = {}, argv = [], apiOnly = false } = {}) => {
  const app = express();
  const logger = recordingLogger();
  const registered = registerBrandedWeb({ app, logger }, { env: { OPENCHAMBER_DIST_DIR: dist, ...env }, argv, brand });
  const routes = upstreamStaticRoutes(dist, { pwaAppName });
  if (apiOnly) routes.registerApiOnlyFallbackRoutes(app);
  else routes.registerStaticRoutes(app);
  await registered.web?.ready;
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
  assert.equal(registered.enabled, true);
  assert.equal(registered.distDir, dist);
  assert.ok(logger.lines.some((line) => line.includes('served with the MittrCraft brand')));
  assert.deepEqual(logger.warnings, []);
  assert.deepEqual(registered.web.files(), ['assets/main-Ab12Cd34.js', 'index.html', 'site.webmanifest', 'sw.js']);

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

test('asset paths that are not in the build add nothing to what the server holds', async (t) => {
  const { registered, get } = await hostedServer(t, upstreamDist(t));
  const known = registered.web.known();
  const files = registered.web.files();
  for (let index = 0; index < 50; index += 1) {
    assert.equal((await get(`/assets/random-${index}-${Math.random().toString(36).slice(2)}.js`)).status, 404);
  }
  assert.deepEqual(registered.web.known(), known);
  assert.deepEqual(registered.web.files(), files);
  assert.ok(known.every((file) => fs.existsSync(path.join(registered.distDir, file))));
});

test('an entry with {{id}} matches any minified identifier, as in the desktop build', async (t) => {
  const dist = tempDist(t);
  fs.writeFileSync(path.join(dist, 'assets', 'a-1.js'), 'x=[go(),Ab.open(c)];');
  fs.writeFileSync(path.join(dist, 'assets', 'b-2.js'), 'y=[go(),$q.open(z1_)];');
  const web = createBrandedWeb({ distDir: dist, brand: { files: [{ file: 'assets/*.js', from: 'go(),{{id}}.open({{id}})]', to: ']', count: 2 }], manifest: BRAND.manifest } });
  await web.ready;
  assert.deepEqual(web.mismatches(), []);
  assert.equal(web.text('assets/a-1.js'), 'x=[];');
  assert.equal(web.text('assets/b-2.js'), 'y=[];');
});

test('an entry whose count differs from the desktop build\'s is left out, and one warning names it', async (t) => {
  const dist = upstreamDist(t);
  fs.writeFileSync(path.join(dist, 'assets', 'twice-1.js'), 'const t="OpenChamber",x;');
  const extra = { file: 'sw.js', from: 'not in the build', to: 'x', count: 1 };
  const { registered, logger, get } = await hostedServer(t, dist, { brand: { ...FIXTURE_BRAND, files: [...FIXTURE_BRAND.files, extra] } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(registered.web.mismatches().map(({ from, expected, found }) => ({ from, expected, found })), [
    { from: '="OpenChamber",', expected: 1, found: 2 },
    { from: 'not in the build', expected: 1, found: 0 },
  ]);
  assert.equal(logger.warnings.length, 1);
  assert.ok(logger.warnings[0].includes('"=\\"OpenChamber\\","') && logger.warnings[0].includes('expected 1, found 2'), logger.warnings[0]);
  assert.ok(logger.warnings[0].includes('"not in the build" in sw.js: expected 1, found 0'), logger.warnings[0]);
  assert.equal((await get('/assets/main-Ab12Cd34.js')).text, 'const t="OpenChamber",x;');
  assert.ok((await get('/')).text.includes(SHELL_TITLE));
});

test('in API-only mode upstream answers every page itself and nothing is branded', async (t) => {
  for (const options of [{ env: { OPENCHAMBER_API_ONLY: 'true' } }, { env: { OPENCHAMBER_API_ONLY: '1' } }, { argv: ['node', 'cli.js', 'serve', '--api-only'] }]) {
    const { registered, get } = await hostedServer(t, upstreamDist(t), { ...options, apiOnly: true });
    assert.deepEqual(registered, { enabled: false }, JSON.stringify(options));
    const page = await get('/', { headers: { accept: 'text/html' } });
    assert.ok(page.text.includes('API-only mode') && !page.text.includes(SHELL_TITLE), page.text.slice(0, 200));
    assert.notEqual((await get('/assets/main-Ab12Cd34.js')).text, 'const t="MittrCraft",x;');
  }
  for (const argv of [['--api-only=true'], ['--api-only='], ['serve', '--api-only', '--port', '9']]) {
    assert.equal(servesApiOnly({}, argv), true, argv.join(' '));
  }
  for (const argv of [['--api-only-x'], ['--api-onlyx'], ['api-only'], ['--port', '--api'], []]) {
    assert.equal(servesApiOnly({}, argv), false, argv.join(' '));
  }
  const off = registerBrandedWeb({ app: express(), logger: recordingLogger() }, { env: { OPENCHAMBER_DIST_DIR: upstreamDist(t), OPENCHAMBER_API_ONLY: 'false' }, argv: ['--api-only-later'], brand: FIXTURE_BRAND });
  assert.equal(off.enabled, true);
  await off.web.ready;
});

test('the built web UI matches every brand entry exactly as the desktop build counts it', async () => {
  const dist = path.join(repoRoot, 'packages/web/dist');
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'packages/web/dist is not built; run bun run build:web first');
  const web = createBrandedWeb({ distDir: dist, brand: BRAND });
  await web.ready;
  assert.deepEqual(web.mismatches(), []);
  const page = web.text('index.html');
  assert.ok(page.includes(SHELL_TITLE));
  assert.ok(!page.includes('OpenChamber'));
  assert.ok(web.files().some((file) => web.text(file).includes('="MittrCraft",')), 'the window title is not branded');
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
  assert.deepEqual(registerBrandedWeb({ app: express(), logger: console }, { env: { OPENCHAMBER_DIST_DIR: missing }, argv: [] }), { enabled: false });
  assert.deepEqual(registerBrandedWeb({ app: express(), logger: console }, { env: { OPENCHAMBER_DIST_DIR: upstreamDist(t) }, argv: [], brand: null }), { enabled: false });
});
