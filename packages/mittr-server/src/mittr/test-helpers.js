import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Upstream's merge rule, by path: the server hands plugins this very function.
import { buildResult, toUsageWindow } from '../../../web/server/lib/quota/utils/formatters.js';
import { toMcpEntity } from '../../../web/server/lib/opencode/config-v2.js';
import { OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, OPENCHAMBER_ALL_ACTIONS, OPENCHAMBER_WEB_ACTION_DEFINITIONS } from '../../../web/server/lib/openchamber-control/actions.js';
import { OpenChamberControlError } from '../../../web/server/lib/openchamber-control/error.js';
import { SCREENSHOT_DIRECTORY, writeScreenshot } from '../../../web/server/lib/openchamber-control/screenshots.js';
import { mergeEngineConfig } from '../../../web/server/lib/server-plugins.js';

export const quotaResult = { buildResult, toUsageWindow };

// Stands in for the keychain and actually obscures the bytes, so a test that
// looks for a token on disk proves something.
export const encrypt = (text) => Buffer.from(Buffer.from(text, 'utf8').toString('base64'), 'utf8');
export const decrypt = (buffer) => Buffer.from(Buffer.from(buffer).toString('utf8'), 'base64').toString('utf8');

export const tempDataDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/** A fetch that never leaves the process: `respond(call)` answers each request. */
export const fakeFetch = (respond = () => json({})) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal };
    calls.push(call);
    return respond(call, calls.length);
  };
  impl.calls = calls;
  return impl;
};

/** Listens on a loopback port, closed after the test, and returns its base URL. */
export const listen = async (t, handler) => {
  const server = await new Promise((resolve) => {
    const listening = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
};

/** Mounts an express app on a loopback port and returns a JSON client for it, with its `base` URL. */
export const serve = async (t, app) => {
  const base = await listen(t, app);
  const call = async (method, route, body) => {
    const response = await fetch(base + route, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  call.base = base;
  return call;
};

/** A promise and the function that settles it, for holding a fetch mid-flight. */
export const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

/**
 * The parts of the server's plugin context that reach the engine: the bound
 * port, a managed OpenCode whose ready listeners the test fires, the
 * managed-config refresh and upstream's own merge rule.
 *
 * A refresh renders through `contribute` once connected, as the server does
 * through every plugin's `managedConfig()`, and records each result in
 * `rendered`. Setting `refreshGate` to a promise holds refreshes open until it
 * settles, the way a slow disk would.
 *
 * The user's OpenCode config lives in `userConfigFile`; each write is recorded
 * in `userConfigWrites` with the number of refreshes made before it. Setting
 * `userConfigError` makes reads throw, as upstream does for a file it cannot
 * parse. UI events the plugin broadcasts are recorded in `broadcasts`.
 */
export const USER_CONFIG_DIR = '/engine-config/opencode';

export const fakeEngineContext = ({ port = 4100, enginePort = 4096, userConfigFile = {} } = {}) => {
  const readyListeners = new Set();
  const refreshes = [];
  const rendered = [];
  const restarts = [];
  const userConfigWrites = [];
  const broadcasts = [];
  const quotaProviders = [];
  const quotaProviderOptions = [];
  const controlCalls = [];
  const eventListeners = new Set();
  const engine = {
    port: enginePort,
    url: (route = '/') => {
      if (engine.port === null) throw new Error('OpenCode port is not available');
      return `http://127.0.0.1:${engine.port}${route.startsWith('/') ? route : `/${route}`}`;
    },
    authHeaders: () => ({ Authorization: 'Basic b3BlbmNvZGU6cHc=' }),
    defaultDirectory: () => '/work',
    onReady: (listener) => {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    restart: async (reason) => { restarts.push(reason); },
    refresh: async (reason) => {
      restarts.push(reason);
      await fake.onRestart?.(reason);
    },
    launchedDataHome: () => fake.launchedDataHome,
    mcpEntity: toMcpEntity,
    userConfig: {
      path: path.join(USER_CONFIG_DIR, 'opencode.json'),
      read: () => {
        if (fake.userConfigError) throw fake.userConfigError;
        return structuredClone(fake.userConfigFile);
      },
      write: (config) => {
        userConfigWrites.push({ config: structuredClone(config), afterRefreshes: refreshes.length });
        fake.userConfigFile = structuredClone(config);
      },
    },
  };
  const server = { port };
  const fake = {
    context: {
      server: { port: () => server.port },
      opencode: engine,
      managedConfig: {
        refresh: async () => {
          refreshes.push(Date.now());
          await fake.refreshGate;
          if (fake.contribute) rendered.push(await fake.contribute());
          return { updated: true };
        },
      },
      mergeEngineConfig,
      registerQuotaProvider: (entry, options) => {
        if (quotaProviders.some((registered) => registered.providerId === entry.providerId)) throw new Error(`Quota provider ${entry.providerId} is already registered`);
        quotaProviders.push(entry);
        quotaProviderOptions.push(options);
        return () => {
          const at = quotaProviders.indexOf(entry);
          if (at !== -1) quotaProviders.splice(at, 1);
        };
      },
      quotaResult,
      events: {
        broadcast: (type, payload) => broadcasts.push({ type, payload }),
        subscribe: (listener) => {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        },
      },
      settings: { read: async () => fake.upstreamSettings },
      git: { remoteUrl: async (directory) => (fake.remotes ?? {})[directory] ?? null },
      requestScope: () => fake.scope,
      control: {
        execute: async (...args) => {
          controlCalls.push(args);
          return fake.controlAnswer(...args);
        },
        resolveSessionDirectory: async () => null,
        definitions: () => ({ control: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, web: OPENCHAMBER_WEB_ACTION_DEFINITIONS }),
        all: OPENCHAMBER_ALL_ACTIONS,
        ControlError: OpenChamberControlError,
        writeScreenshot,
        SCREENSHOT_DIRECTORY,
      },
    },
    controlCalls,
    controlAnswer: async () => ({}),
    scope: 'local',
    quotaProviders,
    quotaProviderOptions,
    server,
    broadcasts,
    remotes: {},
    engine,
    refreshes,
    rendered,
    restarts,
    readyListeners,
    contribute: null,
    refreshGate: null,
    userConfigFile: structuredClone(userConfigFile),
    userConfigWrites,
    userConfigError: null,
    launchedDataHome: null,
    onRestart: null,
    fireReady: () => { for (const listener of readyListeners) listener(); },
    eventListeners,
    upstreamSettings: {},
    emit: (payloads) => { for (const listener of eventListeners) listener({ payload: {}, translated: () => payloads }); },
  };
  return fake;
};

/** Waits until `predicate()` holds (or resolves to true), failing after `timeoutMs`. */
export const until = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * A fetch standing in for the engine's key routes, with its credential store
 * as the 2.0.22 engine keeps it: each connect adds an entry and makes it the
 * only active one for that integration. `answer(call)` may return a Response
 * to override any request. Other URLs answer `other(call)`.
 */
export const fakeEngineFetch = ({ entries = [], answer = () => null, other = () => json({}) } = {}) => {
  let next = entries.length + 1;
  const store = entries.map((entry) => ({ ...entry }));
  const impl = fakeFetch((call) => {
    const overridden = answer(call);
    if (overridden) return overridden;
    const { pathname } = new URL(call.url);
    const connect = pathname.match(/^\/api\/integration\/([^/]+)\/connect\/key$/);
    if (connect && call.method === 'POST') {
      const integrationID = decodeURIComponent(connect[1]);
      for (const entry of store) if (entry.integrationID === integrationID) entry.active = false;
      store.push({ id: `cred_${next}`, integrationID, label: `Key ${next}`, active: true, value: { type: 'key', key: call.body.key } });
      next += 1;
      return new Response(null, { status: 204 });
    }
    if (pathname === '/api/credential' && (call.method ?? 'GET') === 'GET') return json({ data: store });
    const one = pathname.match(/^\/api\/credential\/([^/]+)$/);
    if (one && call.method === 'DELETE') {
      const index = store.findIndex((entry) => entry.id === decodeURIComponent(one[1]));
      if (index === -1) return new Response(null, { status: 404 });
      store.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return other(call);
  });
  impl.store = store;
  impl.connects = () => impl.calls.filter((call) => call.url.endsWith('/connect/key'));
  return impl;
};

export const SCREEN_RECORDING_NOT_GRANTED = 'Screen Recording is NOT granted for this process.';

const CUA_DRIVER_STUB = `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
const argv = process.argv.slice(2);
const at = argv.indexOf('--socket');
const socketPath = at === -1 ? null : argv[at + 1];
const [command, ...rest] = at === -1 ? argv : argv.filter((_, index) => index !== at && index !== at + 1);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CUA_') || key === 'HOME'));
const log = (entry) => fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ ...entry, socketPath, pid: process.pid, env }) + '\\n');
const notRunning = () => {
  process.stderr.write('Cua Driver daemon is not running on ' + socketPath + '.\\nStart it first with: cua-driver serve --socket ' + socketPath + '\\n');
  process.exit(1);
};
const ask = (request, answered) => {
  const socket = net.connect({ path: socketPath });
  let buffer = '';
  socket.on('error', notRunning);
  socket.on('connect', () => socket.write(JSON.stringify(request) + '\\n'));
  socket.on('data', (chunk) => { buffer += chunk; });
  socket.on('end', () => answered(JSON.parse(buffer)));
};
const answerFor = (tool) => {
  const file = path.join(dir, tool + '.json');
  return fs.existsSync(file) ? { ok: true, result: JSON.parse(fs.readFileSync(file, 'utf8')) } : { ok: false, error: ${JSON.stringify(SCREEN_RECORDING_NOT_GRANTED)} };
};
if (command === 'hang') setTimeout(() => {}, 30000);
else if (command === 'serve') {
  log({ command });
  if (fs.existsSync(path.join(dir, 'serve-fails'))) {
    process.stderr.write('serve could not start\\n');
    process.exit(1);
  }
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\\n');
      if (end === -1) return;
      const request = JSON.parse(buffer.slice(0, end));
      if (request.method === 'shutdown') {
        socket.end(JSON.stringify({ ok: true }));
        server.close();
        fs.rmSync(socketPath, { force: true });
        setImmediate(() => process.exit(0));
      } else socket.end(JSON.stringify(answerFor(request.name)));
    });
  });
  server.listen(socketPath);
} else if (command === 'stop') {
  log({ command });
  ask({ method: 'shutdown' }, () => process.exit(0));
} else if (command === 'call') {
  const [tool] = rest;
  log({ command, tool, args: rest[1] });
  if (tool === 'hang') setTimeout(() => {}, 30000);
  else if (tool === 'garbled') process.stdout.write('not json');
  else ask({ method: 'call', name: tool, args: JSON.parse(rest[1] || '{}') }, (response) => {
    if (response.ok) process.stdout.write(JSON.stringify(response.result));
    else {
      process.stderr.write(response.error + '\\n');
      process.exitCode = 1;
    }
  });
} else {
  process.stderr.write('stub cua-driver does not know ' + command + '\\n');
  process.exit(64);
}
`;

export const stubCuaDriver = (t, answers = {}) => {
  const dir = tempDataDir(t);
  for (const [tool, answer] of Object.entries(answers)) fs.writeFileSync(path.join(dir, `${tool}.json`), JSON.stringify(answer));
  const file = path.join(dir, 'cua-driver');
  fs.writeFileSync(file, `#!${process.execPath}\n${CUA_DRIVER_STUB}`, { mode: 0o755 });
  return file;
};

export const stubCuaDriverCalls = (file) => {
  const log = path.join(path.dirname(file), 'calls.jsonl');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

const AGENT_BROWSER_STUB = `
const fs = require('node:fs');
const path = require('node:path');
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_BROWSER_') || key.endsWith('_PROXY')));
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, env, cwd: process.cwd() }) + '\\n');
const options = JSON.parse(fs.readFileSync(path.join(dir, 'options.json'), 'utf8'));
const capped = args.indexOf('--max-output');
const [command, ...rest] = capped === -1 ? args.slice(args.indexOf('--json') + 1) : args.slice(capped + 2);
const session = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
const urls = path.join(dir, 'urls.json');
const read = () => (fs.existsSync(urls) ? JSON.parse(fs.readFileSync(urls, 'utf8')) : {});
const write = (value) => fs.writeFileSync(urls, JSON.stringify(value));
const reply = (data) => process.stdout.write(JSON.stringify({ success: true, data }));
if (options.hang.includes(command)) setTimeout(() => {}, 60000);
else if (command === 'profiles') reply(options.profiles);
else if (command === 'session') reply({ sessions: Object.keys(read()) });
else if (command === 'close') {
  const open = read();
  if (rest[0] === '--all') write({});
  else { delete open[session]; write(open); }
  reply({ closed: true });
} else if (command === 'open') { write({ ...read(), [session]: rest[0] }); reply({ url: rest[0], title: 'Acme' }); }
else if (command === 'get') reply({ url: read()[session] ?? 'about:blank' });
else if (command === 'screenshot') { fs.writeFileSync(rest[0], Buffer.from(options.png, 'base64')); reply({ path: rest[0] }); }
else reply({ ran: command, args: rest });
`;

export const stubAgentBrowser = (t, { profiles = [{ directory: 'Default', name: 'Person' }], hang = [], png = '', running = {} } = {}) => {
  const dir = tempDataDir(t);
  const file = path.join(dir, 'agent-browser');
  fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify({ profiles, hang, png }));
  fs.writeFileSync(path.join(dir, 'urls.json'), JSON.stringify(running));
  fs.writeFileSync(file, `#!${process.execPath}\n${AGENT_BROWSER_STUB}`, { mode: 0o755 });
  const calls = () => {
    const log = path.join(dir, 'calls.jsonl');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  };
  const commands = () => calls().map(({ args }) => {
    const capped = args.indexOf('--max-output');
    return { session: args.includes('--session') ? args[args.indexOf('--session') + 1] : null, command: capped === -1 ? args.slice(args.indexOf('--json') + 1) : args.slice(capped + 2) };
  });
  return { file, calls, commands };
};
