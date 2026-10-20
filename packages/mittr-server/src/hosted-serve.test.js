import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ENTRA_ENV } from './ui-auth/test-fixtures.js';
import { repoRoot } from './upstream-contract.js';

const GUARD = `
import fs from 'node:fs';
import net from 'node:net';
const log = process.env.HOSTED_TEST_EGRESS_LOG;
const loopback = (host) => host === 'localhost' || host === '::1' || /^(::ffff:)?127\\.\\d+\\.\\d+\\.\\d+$/.test(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : null;
  if (options?.path || (typeof first === 'string' && !/^\\d+$/.test(first))) return connect.apply(this, args);
  const host = String((options ? options.host ?? options.hostname : typeof args[1] === 'string' ? args[1] : undefined) ?? 'localhost').replace(/^\\[|\\]$/g, '').toLowerCase();
  if (loopback(host)) return connect.apply(this, args);
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, host, port: options?.port ?? first ?? null }) + '\\n');
  process.nextTick(() => this.destroy(Object.assign(new Error('refused by the test egress guard'), { code: 'ECONNREFUSED' })));
  return this;
};
`;

const FAKE_ENGINE = `
import fs from 'node:fs';
import http from 'node:http';
const args = process.argv.slice(2);
const watched = JSON.parse(process.env.HOSTED_TEST_WATCHED);
const companySignIn = Object.keys(process.env).filter((name) => name.startsWith('MITTR_AD_')).sort();
const seen = watched.filter((name) => name in process.env);
fs.appendFileSync(process.env.HOSTED_TEST_ENGINE_LOG, JSON.stringify({ args, companySignIn, seen, pid: process.pid }) + '\\n');
if (args.includes('--version')) {
  console.log('2.0.22');
  process.exit(0);
}
if (args[0] !== 'serve') process.exit(0);
const value = (flag) => args[args.indexOf(flag) + 1];
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(req.url.startsWith('/api/info') ? JSON.stringify({ version: '2.0.22' }) : '{}');
});
server.listen(Number(value('--port')), value('--hostname'), () => console.log('server listening on http://' + value('--hostname') + ':' + server.address().port));
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(0), 120_000);
`;

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const until = async (check, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const hostedLayout = (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mittrcraft-hosted-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'packages', 'mittr-server');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'packages/mittr-server/bin'), path.join(packageDir, 'bin'), { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'packages/mittr-server/src'), path.join(packageDir, 'src'), 'dir');
  fs.symlinkSync(path.join(repoRoot, 'packages/web'), path.join(root, 'packages', 'web'), 'dir');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'guard.mjs'), GUARD);
  fs.writeFileSync(path.join(tools, 'engine.mjs'), FAKE_ENGINE);
  const engine = path.join(tools, 'opencode');
  fs.writeFileSync(engine, `#!/bin/sh\nexec "${process.execPath}" "${path.join(tools, 'engine.mjs')}" "$@"\n`, { mode: 0o755 });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { bin: path.join(packageDir, 'bin', 'mittrcraft.mjs'), tools, engine, home };
};

const UPSTREAM_HOME_DIRS = ['.config/openchamber', '.config/opencode', '.local/share/opencode', '.local/state/opencode', '.cache/opencode', 'Library/Application Support/OpenChamber'];

const SERVER_ONLY = {
  OPENCODE_JWT_SECRET: 'jwt-secret-value',
  OPENCHAMBER_TUNNEL_TOKEN: 'tunnel-token-value',
  NGROK_AUTHTOKEN: 'ngrok-token-value',
  OPENCHAMBER_APNS_P8: 'apns-key-value',
  OPENCHAMBER_LINEAR_CLIENT_SECRET: 'linear-secret-value',
  OPENCHAMBER_JEV_API_KEY: 'jev-key-value',
};
const ENGINE_NEEDS = ['OPENCODE_SERVER_PASSWORD', 'OPENCODE_PASSWORD'];

const startHosted = async (t, extraEnv) => {
  const { bin, tools, engine, home } = hostedLayout(t);
  const egressLog = path.join(tools, 'egress.jsonl');
  const engineLog = path.join(tools, 'engine.jsonl');
  const port = await freePort();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|MITTR|NODE_OPTIONS$|npm_|BUN_)/i.test(name)));
  const server = spawn(process.execPath, [bin, 'serve', '--foreground', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: home,
    env: {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      SHELL: '/bin/sh',
      ...extraEnv,
      MITTRCRAFT_BROKER_URL: 'http://127.0.0.1:9',
      OPENCODE_BINARY: engine,
      NODE_OPTIONS: `--import ${path.join(tools, 'guard.mjs')}`,
      HOSTED_TEST_EGRESS_LOG: egressLog,
      HOSTED_TEST_ENGINE_LOG: engineLog,
      HOSTED_TEST_WATCHED: JSON.stringify([...Object.keys(SERVER_ONLY), ...ENGINE_NEEDS, 'BUN_BINARY', 'MITTRCRAFT_BIN_BUN_BINARY']),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hosted = { base: `http://127.0.0.1:${port}`, home, egressLog, engineLog, output: '' };
  server.stdout.on('data', (chunk) => { hosted.output += chunk; });
  server.stderr.on('data', (chunk) => { hosted.output += chunk; });
  const exited = new Promise((resolve) => server.once('exit', resolve));
  const exitWithin = (ms) => Promise.race([exited, new Promise((resolve) => setTimeout(resolve, ms).unref())]);
  hosted.stop = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await exitWithin(15_000);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    for (const { pid } of readLines(engineLog)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  };
  t.after(hosted.stop);
  hosted.ready = (route) => until(async () => {
    if (server.exitCode !== null) throw new Error(`the server exited:\n${hosted.output}`);
    const response = await fetch(`${hosted.base}${route}`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, 60_000, 'the server');
  hosted.engineStarted = () => until(() => readLines(engineLog).find((line) => line.args[0] === 'serve'), 60_000, `the engine to start\n${hosted.output}`);
  return hosted;
};

const assertNothingLeftTheMachine = (hosted) => {
  assert.deepEqual(readLines(hosted.egressLog), []);
  for (const dir of UPSTREAM_HOME_DIRS) assert.equal(fs.existsSync(path.join(hosted.home, dir)), false, `${dir} was written`);
  assert.ok(fs.existsSync(path.join(hosted.home, '.config', 'mittrcraft', 'managed-opencode')), `the engine registry is not under ~/.config/mittrcraft:\n${hosted.output}`);
};

test('a hosted server from the packed layout keeps company sign-in and server secrets from the engine, brands the page and writes no upstream folder', { timeout: 120_000 }, async (t) => {
  assert.ok(fs.existsSync(path.join(repoRoot, 'packages/web/dist/index.html')), 'packages/web/dist is not built; run bun run build:web first');
  const hosted = await startHosted(t, { ...ENTRA_ENV, MITTR_AD_BIND_PASSWORD: 'service-account-secret', ...SERVER_ONLY });

  assert.deepEqual(await hosted.ready('/auth/ad/status'), { enabled: true, mode: 'entra', passwordEnabled: false, tunnelLocked: false });
  const started = await hosted.engineStarted();
  const launches = readLines(hosted.engineLog);
  assert.ok(launches.some((line) => line.args.includes('--version')), 'the version preflight did not run');
  for (const line of launches) {
    assert.deepEqual(line.companySignIn, [], `engine ${line.args.join(' ')}`);
    assert.deepEqual(line.seen.filter((name) => name in SERVER_ONLY), [], `engine ${line.args.join(' ')}`);
  }
  assert.deepEqual(started.seen, ENGINE_NEEDS);

  const page = await (await fetch(`${hosted.base}/`)).text();
  assert.ok(page.includes('<title>MittrCraft - AI Coding Assistant</title>'), page.slice(0, 400));
  assert.ok(!page.includes('OpenChamber'));
  assert.equal((await (await fetch(`${hosted.base}/manifest.webmanifest`)).json()).name, 'MittrCraft');

  await hosted.stop();
  assertNothingLeftTheMachine(hosted);
  for (const secret of ['service-account-secret', ENTRA_ENV.MITTR_AD_CLIENT_SECRET, ...Object.values(SERVER_ONLY)]) assert.ok(!hosted.output.includes(secret));
});

test('a hosted server answers the update check and the model catalog without calling anyone', { timeout: 120_000 }, async (t) => {
  const hosted = await startHosted(t, {});
  await hosted.ready('/health');
  await hosted.engineStarted();

  const update = await fetch(`${hosted.base}/api/openchamber/update-check`, { headers: { accept: 'application/json' } });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).updatesDisabled, true);
  const metadata = await fetch(`${hosted.base}/api/openchamber/models-metadata`, { headers: { accept: 'application/json' } });
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {});
  const install = await fetch(`${hosted.base}/api/openchamber/update-install`, { method: 'POST', headers: { accept: 'application/json' } });
  assert.equal(install.status, 400);
  assert.deepEqual(await install.json(), { error: 'No update available', updatesDisabled: true });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal((await fetch(`${hosted.base}/health`)).status, 200, 'the server went away after the install request');

  await hosted.stop();
  assertNothingLeftTheMachine(hosted);
});
