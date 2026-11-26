import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const sourceLoader = pathToFileURL(path.join(serverDir, '../scripts/register-server-sources.mjs')).href;

const PLUGIN = `export default ({ app, opencode }) => {
  const answer = (work) => async (_req, res) => {
    try { await work(); res.json({ ok: true }); } catch (error) { res.status(500).json({ error: String(error?.message ?? error) }); }
  };
  app.post('/probe/restart', answer(() => opencode.restart('probe')));
  app.post('/probe/account', answer(async () => {
    const token = await opencode.beforeAccountMutation();
    await opencode.accountMutationSettled(token);
  }));
}`;

const JOURNAL = `${JSON.stringify({ version: 1, entries: [{ owner: 'a'.repeat(64), sessionID: 'ses_reserved', phase: 'admitting' }] })}\n`;

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let root;
let engine;
let enginePort;
let child;
let base;
let output = '';
let received = [];
const held = new Set();

const send = (route, { method = 'POST', body = '{}', headers = {}, signal } = {}) => fetch(`${base}${route}`, {
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: method === 'GET' ? undefined : body,
  signal,
});

const prompt = (sessionID) => send(`/api/session/${sessionID}/prompt`, { body: JSON.stringify({ text: 'hello' }) });

const expectNothingBlocked = async (sessionID) => {
  expect((await prompt(sessionID)).status).toBe(200);
  expect((await prompt('ses_other')).status).toBe(200);
  const restart = await send('/probe/restart');
  expect({ status: restart.status, body: await restart.text() }).toEqual({ status: 200, body: '{"ok":true}' });
  const account = await send('/probe/account');
  expect({ status: account.status, body: await account.text() }).toEqual({ status: 200, body: '{"ok":true}' });
  expect((await prompt(sessionID)).status).toBe(200);
};

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-off-')));
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, '.config', 'opencode');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(path.join(root, 'project'));
  await fs.writeFile(path.join(dataDir, 'response-recovery.json'), JOURNAL);
  await fs.writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ mcp: { probe: { type: 'remote', url: 'https://mcp.example.test' } } }));
  const plugin = path.join(root, 'probe.mjs');
  await fs.writeFile(plugin, PLUGIN);

  engine = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://engine.example.test');
    received.push(`${req.method} ${pathname}`);
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    req.resume();
    req.on('end', () => {
      if (pathname === '/api/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': open\n\n');
        return held.add(res);
      }
      if (pathname === '/api/info') return json({ version: '2.3.2', pid: 1, urls: [], paths: { tmp: '/tmp' } });
      if (pathname === '/api/session/ses_error/command') return json({ error: 'boom' }, 503);
      if (pathname === '/api/session/ses_refused/command') return req.socket.destroy();
      if (pathname === '/api/session/ses_aborted/command' || pathname.endsWith('/wait')) return held.add(res);
      const session = req.method === 'GET' && /^\/api\/session\/(ses_[a-z]+)$/.exec(pathname);
      if (session) return json({ data: { id: session[1], location: { directory: path.join(root, 'project') } } });
      if (pathname === '/api/integration/mcp_probe') return json({ data: { name: 'probe', metadata: { source: 'mcp' } } });
      if (pathname.endsWith('/prompt')) return json({ data: { id: 'msg_1' } });
      return json({ data: [] });
    });
  });
  enginePort = await listen(engine);

  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GIT_|OPENCODE_|OPENCHAMBER_|XDG_|VITEST|NODE_OPTIONS)/.test(name)));
  const script = `
    const { startWebUiServer } = await import(process.env.PROBE_SERVER_URL);
    const handle = await startWebUiServer({ port: 0, host: '127.0.0.1', attachSignals: false, exitOnShutdown: false });
    console.log('PROBE_PORT=' + handle.httpServer.address().port);
    process.stdin.resume();
    process.stdin.on('end', async () => {
      await handle.stop({ exitProcess: false });
      console.log('PROBE_STOPPED');
      process.exit(0);
    });
  `;
  child = spawn(process.execPath, ['--import', sourceLoader, '--input-type=module', '-e', script], {
    env: {
      ...inherited,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, '.config'),
      XDG_DATA_HOME: path.join(root, '.local', 'share'),
      XDG_STATE_HOME: path.join(root, '.local', 'state'),
      XDG_CACHE_HOME: path.join(root, '.cache'),
      OPENCHAMBER_DATA_DIR: dataDir,
      OPENCODE_SKIP_START: 'true',
      OPENCODE_HOST: `http://127.0.0.1:${enginePort}`,
      OPENCHAMBER_UPDATE_CHECK_DISABLED: '1',
      OPENCHAMBER_SERVER_PLUGINS: JSON.stringify([plugin]),
      PROBE_SERVER_URL: pathToFileURL(path.join(serverDir, 'index.js')).href,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const started = Promise.withResolvers();
  const read = (chunk) => {
    output += chunk;
    const port = /PROBE_PORT=(\d+)/.exec(output)?.[1];
    if (port) started.resolve(port);
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.on('exit', () => started.reject(new Error(output)));
  base = `http://127.0.0.1:${await started.promise}`;
  for (let attempt = 0; attempt < 100 && (await prompt('ses_boot')).status !== 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 60_000);

afterAll(async () => {
  for (const response of held) response.destroy();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  engine?.closeAllConnections();
  await new Promise((resolve) => engine?.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => { received = []; });

describe('a server with response recovery off', () => {
  it('keeps every chat, the engine restart and an account change open after a send the engine failed', async () => {
    expect((await send('/api/session/ses_error/command')).status).toBe(503);
    await expectNothingBlocked('ses_error');
  });

  it('keeps them open after a send whose connection broke', async () => {
    expect((await send('/api/session/ses_refused/command')).status).toBeGreaterThanOrEqual(500);
    await expectNothingBlocked('ses_refused');
  });

  it('keeps them open after the client gave up on a send', async () => {
    const abort = new AbortController();
    const sending = send('/api/session/ses_aborted/command', { signal: abort.signal }).catch((error) => error.name);
    await expect.poll(() => received.includes('POST /api/session/ses_aborted/command')).toBe(true);
    abort.abort();
    expect(await sending).toBe('AbortError');
    await expectNothingBlocked('ses_aborted');
  });

  it('keeps them open after an MCP sign-in start the server answers itself', async () => {
    const start = await send('/api/integration/mcp_probe/connect/oauth', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'craft.example.test' } });
    expect(start.status).toBe(502);
    expect(await start.json()).toMatchObject({ kind: 'mcp_oauth' });
    await expectNothingBlocked('ses_oauth');
  });

  it('keeps them open while a worktree wait is held open', async () => {
    const abort = new AbortController();
    const waiting = send('/api/experimental/session/ses_task/wait', { signal: abort.signal }).catch((error) => error.name);
    await expect.poll(() => received.includes('POST /api/experimental/session/ses_task/wait')).toBe(true);
    await expectNothingBlocked('ses_task');
    abort.abort();
    expect(await waiting).toBe('AbortError');
  });

  it('leaves a journal from a build that had it on untouched, and stops at once', async () => {
    expect((await prompt('ses_reserved')).status).toBe(200);
    child.stdin.end();
    await expect.poll(() => output.includes('PROBE_STOPPED'), { timeout: 20_000 }).toBe(true);
    expect(await fs.readFile(path.join(root, 'data', 'response-recovery.json'), 'utf8')).toBe(JOURNAL);
    expect(output).not.toContain('[response-recovery]');
  });
});
