#!/usr/bin/env node
/**
 * Proves what the bundled OpenCode 2.x engine does with a Mittr-style
 * provider, the provider lock policies, an identity plugin and a quota
 * refusal, by running the real engine against two loopback stub providers.
 *
 * Everything runs under a fresh temporary HOME with all four XDG bases,
 * TMPDIR and OPENCODE_CONFIG inside it, on a random port with a random
 * password. The stubs listen on 127.0.0.1 only; no real provider or key is
 * used. The engine's HTTP(S)_PROXY points at a loopback recording proxy that
 * refuses every non-loopback target, so an outbound attempt is recorded and
 * never leaves the machine. The engine process group, the stubs and the proxy
 * are stopped and the temp HOME is deleted on exit.
 *
 * Exit status is 0 only when every scenario passed and nothing tried to leave
 * the machine.
 *
 * Usage:
 *
 *   node scripts/mittr/probe-engine-v2.mjs --json <out>
 *     [--keep]              keep the temp HOME for inspection
 *     [--only P7]           run only the user-config policy scenario
 *     [--only outbound]     run the engine with the server's outbound switches
 *                           and once without them (the control), and record
 *                           every attempt to leave the machine
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { identityLine, identityPluginSource } from '../../packages/mittr-opencode/src/identity-plugin.js';
import { ENGINE_OUTBOUND_OFF, ENGINE_SHARE_OFF } from '../../packages/mittr-server/src/engine-outbound.js';
import { toEngineRefusal } from '../../packages/mittr-server/src/mittr/exhausted.js';
import { catalogMcpEntity } from '../../packages/mittr-server/src/mittr/mcp-fragment.js';
import { policiesFor } from '../../packages/mittr-server/src/mittr/policies.js';
import { toMcpEntity } from '../../packages/web/server/lib/opencode/config-v2.js';

export const mcpEntityFromCatalog = (raw) => catalogMcpEntity(raw, toMcpEntity);

// What a user who owns OPENCODE_CONFIG might allow on their own (R45 probe):
// every provider, the other stub by name, and the hosted provider by name.
export const USER_ALLOW_POLICIES = [
  { action: 'provider.use', resource: '*', effect: 'allow' },
  { action: 'provider.use', resource: 'other', effect: 'allow' },
  { action: 'provider.use', resource: 'opencode', effect: 'allow' },
];

/** A turn the engine refused by policy: no answer and a `provider.no-route` failure. */
export const refusedByPolicy = (attempt) => !attempt.answered
  && (attempt.events ?? []).some((e) => e.error?.type === 'provider.no-route');

// What P3 expects the engine to send in place of its opening sentence; kept
// apart from the plugin on purpose, so the probe checks the plugin.
const HARNESS_SENTENCE = 'You are an AI agent running in OpenCode, a coding agent harness.';
const harnessReplacement = (productName) => `You are ${productName}, an AI coding agent.`;

// Probe-only: the retry hook the identity plugin would carry if a refusal
// were retried (the P2/P2b stop condition). It hooks nothing unless the
// fallback writes it with a provider.
const retryHookSource = (providerID = null) => `export default {
  id: 'mittrcraft.probe-retry-hook',
  setup: async (ctx) => {${providerID ? `
    await ctx.session.hook('retry', (e) => {
      if (String(e.error?.response?.body ?? '').includes('llm_quota_exhausted')) e.decision = { retry: false }
    }, { providerID: ${JSON.stringify(providerID)} })` : ''}
  },
}
`;

const HOOK_RECORDER_SOURCE = `import fs from 'node:fs'

const record = (hook) => (o) => {
  const first = Array.isArray(o.system) && o.system[0] && typeof o.system[0].text === 'string' ? o.system[0].text : ''
  try {
    fs.appendFileSync(process.env.MITTR_PROBE_HOOK_LOG, JSON.stringify({ hook, at: Date.now(), opening: first.slice(0, 120), parts: Array.isArray(o.system) ? o.system.length : null }) + '\\n')
  } catch {}
}

export default {
  id: 'mittrcraft.probe-hook-recorder',
  setup: async (ctx) => {
    for (const hook of ['context', 'generate', 'compaction']) await ctx.session.hook(hook, record(hook))
  },
}
`;

const isLoopbackHost = (host) => {
  const bare = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || bare.startsWith('127.') || bare === '::ffff:127.0.0.1' || bare === '*';
};

/** Remote endpoints from `lsof -nP -i` output that are not loopback. */
export const nonLoopbackFromLsof = (text) => {
  const found = new Set();
  for (const line of String(text).split('\n')) {
    const match = line.match(/->(\[[^\]]+\]|[^:\s]+):(\d+|\*)/);
    if (!match) continue;
    if (!isLoopbackHost(match[1])) found.add(`${match[1]}:${match[2]}`);
  }
  return [...found];
};

/** Loopback connections from `lsof -nP -i` output, as `local->remote` port pairs. */
export const loopbackPeersFromLsof = (text) => {
  const found = new Set();
  for (const line of String(text).split('\n')) {
    const match = line.match(/:(\d+)->(\[[^\]]+\]|[^:\s]+):(\d+)/);
    if (match && isLoopbackHost(match[2])) found.add(`${match[1]}->${match[3]}`);
  }
  return [...found];
};

/** Hosts named in http(s) URLs of an engine log that are not loopback. */
export const nonLoopbackFromLog = (text) => {
  const found = new Set();
  for (const match of String(text).matchAll(/https?:\/\/(\[[^\]]+\]|[A-Za-z0-9.-]+)/g)) {
    if (!isLoopbackHost(match[1])) found.add(match[1]);
  }
  return [...found];
};

/** Mentions of the engine's own name, not counting paths such as `.opencode/`. */
export const openCodeMentions = (text) => (String(text).match(/(?<![.\w/-])opencode\b/gi) ?? []).length;

/**
 * What each failed scenario means for later tasks, as the plan's stop
 * conditions say. `stop` means the phase cannot go on with this design.
 */
export const stopConditionFor = (scenario, { pass, fallbackPass = null }) => {
  if (pass) return { action: 'none', stop: false };
  switch (scenario) {
    case 'P1':
      return { action: 'Task 9 sessionIdOf reads whichever header the stub saw', stop: false };
    case 'P2':
    case 'P2b':
      return fallbackPass
        ? { action: 'the identity plugin carries the retry hook scoped to the Mittr provider', stop: false }
        : { action: 'stop and report: a refused turn would burn calls', stop: true };
    case 'P3':
      return { action: 'stop and report: the harness opening line cannot be rewritten through the plugin hook', stop: true };
    case 'P4':
    case 'P7':
      return { action: 'stop and report: data could reach a non-Mittr provider', stop: true };
    case 'P5':
      return { action: 'Tasks 10 and 13 call context.opencode.refresh(reason) after each managed-config write', stop: false };
    case 'P6':
      return { action: "Task 10 uses settings.apiKey '{env:MITTRCRAFT_SHIM_TOKEN}' through engineEnv()", stop: false };
    default:
      return { action: 'control failed: the probe cannot tell a retry from none', stop: true };
  }
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = path.join(REPO, 'packages/electron/resources/opencode-cli/opencode');
const RESERVED_PORTS = new Set([57123, 57133]);
const RESETS_AT = '2026-10-20T00:00:00+07:00';
const CANARY_HOST = 'egress-canary.invalid';
const SCENARIOS = ['P1', 'P2', 'P2b', 'P2c', 'P2-control', 'P3', 'P4', 'P5', 'P6', 'P7', 'proxy-control'];
const HOSTED_MODEL = 'big-pickle';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => (RESERVED_PORTS.has(port) ? freePort().then(resolve, reject) : resolve(port)));
    });
  });

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const frame of frames) res.write(`data: ${frame}\n\n`);
  res.end();
};

const chunk = (model, delta, finish = null, usage = null) => {
  const frame = {
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) frame.usage = usage;
  return JSON.stringify(frame);
};

const RATE_LIMIT_BODY = { error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'Slow down' } };

const answer = (stub, record, req, res) => {
  const model = record.body?.model ?? 'm1';
  if (stub.mode === 'refuse') {
    const refusal = toEngineRefusal({ kind: 'weekly', resetsAt: RESETS_AT });
    res.writeHead(refusal.status, { 'content-type': 'application/json', ...refusal.headers });
    res.end(JSON.stringify(refusal.body));
    return;
  }
  if (stub.mode === 'midstream') {
    const refusal = toEngineRefusal({ kind: 'weekly', resetsAt: RESETS_AT });
    sse(res, [chunk(model, { role: 'assistant', content: 'partial ' }), JSON.stringify(refusal.body), '[DONE]']);
    return;
  }
  if (stub.mode === 'ratelimit-no-retry' || stub.mode === 'ratelimit') {
    const headers = { 'content-type': 'application/json', 'retry-after': '1' };
    if (stub.mode === 'ratelimit-no-retry') headers['x-should-retry'] = 'false';
    res.writeHead(429, headers);
    res.end(JSON.stringify(RATE_LIMIT_BODY));
    return;
  }
  const call = stub.mode === 'tool' && stub.pickCall ? stub.pickCall(record.body) : null;
  record.calledTool = call?.name ?? null;
  if (call) {
    sse(res, [
      chunk(model, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${stub.requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }),
      chunk(model, {}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }),
      '[DONE]',
    ]);
    return;
  }
  if (record.body?.stream) {
    sse(res, [
      chunk(model, { role: 'assistant', content: stub.reply }),
      chunk(model, {}, 'stop', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }),
      '[DONE]',
    ]);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-probe', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: stub.reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }));
};

const startStub = async (name) => {
  const port = await freePort();
  const stub = { name, port, requests: [], mode: 'ok', pickCall: null, reply: `hello from ${name}` };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (part) => { raw += part; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const record = { at: Date.now(), method: req.method, url: req.url, headers: req.headers, body, unparsedBytes: body ? 0 : raw.length, mode: stub.mode };
      stub.requests.push(record);
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }, { id: 'm2', object: 'model' }] }));
        return;
      }
      answer(stub, record, req, res);
      record.answeredAt = Date.now();
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  stub.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  stub.posts = () => stub.requests.filter((r) => r.method === 'POST');
  stub.since = (mark) => stub.posts().filter((r) => r.at >= mark);
  stub.forSession = (sessionID) => stub.posts().filter((r) => r.headers['x-opencode-session-id'] === sessionID);
  return stub;
};

const splitHostPort = (authority) => {
  const match = String(authority).match(/^\[?([^\]]+?)\]?:(\d+)$/);
  return match ? { host: match[1], port: Number(match[2]) } : { host: String(authority), port: 443 };
};

/**
 * A loopback HTTP proxy for the engine's HTTP(S)_PROXY. It records every
 * request and CONNECT, forwards only loopback targets, and refuses the rest,
 * so nothing it sees reaches another host.
 */
const startProxy = async () => {
  const port = await freePort();
  const proxy = { port, attempts: [] };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let target = null;
    try { target = new URL(req.url); } catch { target = null; }
    const host = target?.hostname ?? '';
    const loopback = Boolean(target) && isLoopbackHost(host);
    proxy.attempts.push({ at: Date.now(), kind: 'http', host, port: Number(target?.port || 80), loopback });
    if (!loopback) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('probe proxy: egress refused');
      return;
    }
    const upstream = http.request({ host, port: Number(target.port || 80), method: req.method, path: `${target.pathname}${target.search}`, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const { host, port: targetPort } = splitHostPort(req.url);
    const loopback = isLoopbackHost(host);
    proxy.attempts.push({ at: Date.now(), kind: 'connect', host, port: targetPort, loopback });
    if (!loopback) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(targetPort, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  proxy.close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    server.close(resolve);
  });
  return proxy;
};

const providerEntry = (name, baseURL, models) => ({
  name,
  package: 'aisdk:@ai-sdk/openai-compatible',
  settings: { baseURL },
  models: Object.fromEntries(models.map((id) => [id, { modelID: id, name: id, capabilities: { tools: true } }])),
});

const writeJsonAtomic = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

const writePlugin = (dir, name, source) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0', private: true, type: 'module', exports: { '.': './index.js' } }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'index.js'), source, { mode: 0o600 });
};

const descendants = (pid) => {
  const all = [pid];
  for (let i = 0; i < all.length; i += 1) {
    const out = spawnSync('pgrep', ['-P', String(all[i])], { encoding: 'utf8' }).stdout ?? '';
    for (const child of out.split('\n').map((s) => Number(s.trim())).filter(Boolean)) all.push(child);
  }
  return all;
};

const startOutboundSampler = (pidRef, sink) => {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const pid = pidRef();
      if (pid) {
        const pids = descendants(pid);
        const out = spawnSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-i'], { encoding: 'utf8' }).stdout ?? '';
        sink.samples += 1;
        sink.pids = [...new Set([...sink.pids, ...pids])];
        for (const remote of nonLoopbackFromLsof(out)) sink.remotes.add(remote);
        for (const pair of loopbackPeersFromLsof(out)) if (!sink.loopbackPeers.has(pair)) sink.loopbackPeers.set(pair, Date.now());
      }
      await sleep(250);
    }
  };
  const done = loop();
  return async () => { stopped = true; await done; };
};

const signalGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stops the engine's whole process group, whatever state its leader is in. */
const stopEngine = async (engine) => {
  if (!engine || engine.stopped) return;
  signalGroup(engine.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && groupAlive(engine.pid)) await sleep(100);
  if (groupAlive(engine.pid)) signalGroup(engine.pid, 'SIGKILL');
  await Promise.race([engine.exited, sleep(2000)]);
  engine.stopped = !groupAlive(engine.pid);
};

const listenerOn = (port) => (spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '').trim();

const unusedPort = async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    if (!listenerOn(port)) return port;
  }
  throw new Error('no loopback port free of other listeners');
};

const startEngine = async ({ home, configFile, logFile, proxyPort, hookLog, onSpawn, extraEnv = {}, outboundEnv = ENGINE_OUTBOUND_OFF }) => {
  const port = await unusedPort();
  const password = randomBytes(24).toString('hex');
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const noProxy = '127.0.0.1,localhost,::1';
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    LANG: 'en_US.UTF-8',
    USER: process.env.USER ?? 'user',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_CONFIG: configFile,
    ...outboundEnv,
    OPENCODE_SERVER_PASSWORD: password,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    MITTR_PROBE_HOOK_LOG: hookLog,
    ...extraEnv,
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const log = fs.openSync(logFile, 'a');
  const startedAt = Date.now();
  const child = spawn(ENGINE, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--log-level', 'debug'], {
    cwd: work, env, detached: true, stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const engine = { child, pid: child.pid, exited, port, base: `http://127.0.0.1:${port}`, work };
  onSpawn(engine);
  engine.headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'x-opencode-directory': encodeURIComponent(work),
  };
  try {
    const deadline = Date.now() + 60_000;
    let lastError = null;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`engine exited early (${child.exitCode ?? child.signalCode}); see ${logFile}`);
      if (Date.now() >= deadline) throw new Error(`engine not ready: ${lastError?.message}`);
      try {
        const res = await fetch(`${engine.base}/api/session?limit=1`, { headers: engine.headers });
        if (res.ok) break;
        lastError = new Error(`health ${res.status}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
  } catch (error) {
    await stopEngine(engine);
    throw error;
  }
  engine.readyMs = Date.now() - startedAt;
  return engine;
};

const collectEvents = (client) => {
  const events = [];
  const controller = { stopped: false };
  const run = (async () => {
    try {
      for await (const event of client.event.subscribe()) {
        events.push({ at: Date.now(), type: event.type, data: event.data });
        if (controller.stopped) break;
      }
    } catch (error) {
      events.push({ at: Date.now(), type: 'probe.stream-error', data: { message: String(error?.message ?? error) } });
    }
  })();
  return { events, stop: async () => { controller.stopped = true; await Promise.race([run, sleep(500)]); } };
};

const sessionEvents = (events, sessionID, since = 0) =>
  events.filter((e) => e.at >= since && e.data && e.data.sessionID === sessionID);

const isIdleEvent = (e) =>
  e.type === 'session.idle'
  || (e.type === 'session.status' && e.data.status?.type === 'idle')
  || e.type === 'session.execution.succeeded'
  || e.type === 'session.execution.failed'
  || e.type === 'session.execution.interrupted';

const isRetryEvent = (e) => (e.type === 'session.status' && e.data.status?.type === 'retry') || e.type === 'session.retry.scheduled';

const waitFor = async (predicate, timeoutMs, stepMs = 100) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
};

const errorText = (error) => {
  if (!error) return null;
  const parts = [error.name, error.message, error.status, error.body && JSON.stringify(error.body), error.cause?.message];
  return parts.filter(Boolean).join(' | ').slice(0, 800);
};

const lastAssistant = async (client, sessionID) => {
  const page = await client.message.list({ sessionID, limit: 20, order: 'desc' });
  return page.data.find((m) => m.type === 'assistant' || m.role === 'assistant') ?? null;
};

const systemTextOf = (body) => {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (Array.isArray(m.content) ? JSON.stringify(m.content) : String(m.content)))
    .join('\n');
};

const promptAndSettle = async ({ client, collector, sessionID, text, timeoutMs = 30_000 }) => {
  const mark = Date.now();
  let promptError = null;
  try {
    await client.session.prompt({ sessionID, text });
  } catch (error) {
    promptError = errorText(error);
  }
  const idle = await waitFor(() => sessionEvents(collector.events, sessionID, mark).find(isIdleEvent), timeoutMs);
  return { mark, promptError, idleAt: idle?.at ?? null };
};

const newSession = async (client, work, providerID, id) => {
  try {
    const info = await client.session.create({ title: `probe ${providerID}/${id}`, model: { id, providerID }, location: { directory: work } });
    return { sessionID: info.id, createError: null };
  } catch (error) {
    return { sessionID: null, createError: errorText(error) };
  }
};

const summarizeEvents = (events) => events.map((e) => {
  const summary = { type: e.type };
  if (e.data.status?.type) summary.status = e.data.status.type;
  if (e.data.attempt !== undefined) summary.attempt = e.data.attempt;
  if (e.data.error) summary.error = { type: e.data.error.type, status: e.data.error.status, message: String(e.data.error.message ?? '').slice(0, 200) };
  return summary;
});

const readHookLog = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

const probeP1P3 = async ({ client, collector, stub, work, hookLog }) => {
  stub.mode = 'ok';
  const { sessionID, createError } = await newSession(client, work, 'stub', 'm1');
  if (!sessionID) return { P1: { pass: false, observed: { createError } }, P3: { pass: false, observed: { createError } } };
  const hooksBefore = readHookLog(hookLog).length;
  const run = await promptAndSettle({ client, collector, sessionID, text: 'Who are you? Answer in one word.' });
  const main = stub.forSession(sessionID).at(0) ?? null;
  const headers = main?.headers ?? {};
  const P1 = {
    pass: Boolean(main) && headers['x-opencode-session-id'] === sessionID && headers['x-session-id'] === sessionID,
    observed: {
      sessionID,
      stubRequests: stub.since(run.mark).length,
      'x-opencode-session-id': headers['x-opencode-session-id'] ?? null,
      'x-session-id': headers['x-session-id'] ?? null,
      'x-session-affinity': headers['x-session-affinity'] ?? null,
      'x-opencode-session': headers['x-opencode-session'] ?? null,
      'x-opencode-project': headers['x-opencode-project'] ?? null,
      'x-opencode-client': headers['x-opencode-client'] ?? null,
      'user-agent': headers['user-agent'] ?? null,
      authorization: headers.authorization ? `${headers.authorization.split(' ')[0]} <redacted>` : null,
      headerNames: Object.keys(headers).sort(),
      promptError: run.promptError,
      idle: Boolean(run.idleAt),
    },
  };
  const system = systemTextOf(main?.body);
  const identity = identityLine('MittrCraft');
  const hooks = readHookLog(hookLog).slice(hooksBefore);
  const hookCounts = Object.fromEntries(['context', 'generate', 'compaction'].map((name) => [name, hooks.filter((h) => h.hook === name).length]));
  const replacement = harnessReplacement('MittrCraft');
  const harnessRewritten = system.includes(replacement) && !system.includes(HARNESS_SENTENCE);
  const P3 = {
    pass: hookCounts.context > 0
      && harnessRewritten
      && system.includes(identity)
      && !system.includes('You are opencode')
      && !system.includes('You are OpenCode'),
    observed: {
      hookCounts,
      openingSeenByHook: hooks[0]?.opening ?? null,
      hookSawOriginalHarnessSentence: hooks.some((h) => h.opening.startsWith(HARNESS_SENTENCE.slice(0, 60))),
      harnessSentenceSent: system.includes(HARNESS_SENTENCE),
      harnessReplacementSent: system.includes(replacement),
      harnessRewritten,
      identityLinePresent: system.includes(identity),
      hasYouAreopencode: system.includes('You are opencode'),
      hasYouAreOpenCode: system.includes('You are OpenCode'),
      openCodeMentions: openCodeMentions(system),
      openCodeMentionsWithoutIdentityLine: openCodeMentions(system.replace(identity, '')),
      openCodeLines: system.split('\n').filter((line) => openCodeMentions(line) > 0).slice(0, 8).map((line) => line.slice(0, 200)),
      systemHead: system.slice(0, 200),
      systemMessages: (main?.body?.messages ?? []).filter((m) => m.role === 'system').length,
      systemContentIsPartList: Array.isArray(main?.body?.messages?.[0]?.content),
      requestKeys: Object.keys(main?.body ?? {}).sort(),
    },
  };
  return { P1, P3 };
};

const probeRefusal = async ({ client, collector, stub, work, mode, label, expectRetry = false, windowMs = 20_000 }) => {
  stub.mode = mode;
  const { sessionID, createError } = await newSession(client, work, 'stub', 'm1');
  if (!sessionID) {
    stub.mode = 'ok';
    return { pass: false, observed: { createError } };
  }
  const run = await promptAndSettle({ client, collector, sessionID, text: `probe ${label}`, timeoutMs: windowMs });
  await sleep(Math.max(0, run.mark + windowMs - Date.now()));
  const requests = stub.forSession(sessionID);
  const events = sessionEvents(collector.events, sessionID, run.mark);
  const retrySeen = events.some(isRetryEvent);
  let interruptError = null;
  if (expectRetry && !run.idleAt) {
    try { await client.session.interrupt({ sessionID }); } catch (error) { interruptError = errorText(error); }
    await waitFor(() => sessionEvents(collector.events, sessionID, run.mark).find(isIdleEvent), 5000);
  }
  stub.mode = 'ok';
  const firstAnsweredAt = requests[0]?.answeredAt ?? null;
  const idleAfterMs = run.idleAt && firstAnsweredAt ? run.idleAt - firstAnsweredAt : null;
  let assistant = null;
  let messageError = null;
  try { assistant = await lastAssistant(client, sessionID); } catch (error) { messageError = errorText(error); }
  const error = assistant?.error ?? null;
  const observed = {
    sessionID,
    stubRequests: requests.length,
    requestTimesMs: requests.map((r) => r.at - run.mark),
    idleAfterRefusalMs: idleAfterMs,
    retrySeen,
    events: summarizeEvents(events).slice(0, 24),
    assistantError: error ? { type: error.type, status: error.status ?? null, message: String(error.message ?? '').slice(0, 300), responseBody: error.response?.body ?? null } : null,
    assistantFinish: assistant?.finish ?? null,
    messageError,
    interruptError,
    promptError: run.promptError,
  };
  if (expectRetry) return { pass: requests.length > 1 || retrySeen, observed };
  let pass = requests.length === 1 && idleAfterMs !== null && idleAfterMs <= 2000 && !retrySeen;
  if (mode === 'refuse') pass = pass && error?.status === 402 && String(error?.response?.body ?? '').includes('llm_quota_exhausted');
  if (mode === 'midstream') pass = pass && error?.type === 'provider.quota' && String(error?.response?.body ?? '').includes('llm_quota_exhausted');
  return { pass, observed };
};

const PLATFORM_QUOTA_BODY = { error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', resets_at: RESETS_AT } };
const SHIM_TIMEOUT_MS = 3000;
const PLATFORM_FORBIDDEN_BODIES = {
  'forbidden-entitlement': { error: { message: 'desktop_entitlement_required', type: 'invalid_request_error', code: 'forbidden' } },
  'forbidden-stale': { error: { message: 'agent_not_granted', type: 'invalid_request_error', code: 'agent_not_granted' } },
};

const startPlatform = async () => {
  const port = await freePort();
  const platform = { port, requests: [], mode: 'ok' };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (part) => { raw += part; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const record = { at: Date.now(), method: req.method, url: req.url, authorization: req.headers.authorization ?? null, mode: platform.mode, answeredAt: null };
      platform.requests.push(record);
      const answered = () => { record.answeredAt ??= Date.now(); };
      const model = body?.model ?? 'm1';
      const open = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (record.mode === 'refuse') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify(PLATFORM_QUOTA_BODY));
        answered();
        return;
      }
      if (PLATFORM_FORBIDDEN_BODIES[record.mode]) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify(PLATFORM_FORBIDDEN_BODIES[record.mode]));
        answered();
        return;
      }
      if (record.mode === 'midstream') {
        open();
        res.write(`data: ${chunk(model, { role: 'assistant', content: 'partial ' })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify(PLATFORM_QUOTA_BODY)}\n\n`);
          answered();
        }, 200);
        return;
      }
      if (record.mode === 'cut') {
        open();
        res.write(`data: ${chunk(model, { role: 'assistant', content: 'partial ' })}\n\n`);
        setTimeout(() => {
          answered();
          req.socket.destroy();
        }, 200);
        return;
      }
      if (record.mode === 'stall') {
        open();
        res.write(`data: ${chunk(model, { role: 'assistant', content: 'partial ' })}\n\n`);
        res.on('close', answered);
        return;
      }
      if (record.mode === 'hang') {
        res.on('close', answered);
        return;
      }
      if (record.mode === 'drop') {
        answered();
        req.socket.destroy();
        return;
      }
      sse(res, [
        chunk(model, { role: 'assistant', content: 'hello from the platform' }),
        chunk(model, {}, 'stop', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }),
        '[DONE]',
      ]);
      answered();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  platform.since = (mark) => platform.requests.filter((r) => r.method === 'POST' && r.at >= mark);
  platform.close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  });
  return platform;
};

const startShim = async ({ platform, logLines }) => {
  const { default: express } = await import('express');
  const { SHIM_PREFIX, registerMittrShim, sessionIdOf } = await import('../../packages/mittr-server/src/mittr/shim-routes.js');
  const localToken = `mc_local_${randomBytes(32).toString('hex')}`;
  const record = (...args) => logLines.push({ at: Date.now(), line: args.map(String).join(' ') });
  const signedIn = { accessToken: 'probe-platform-token' };
  const state = { session: signedIn, onActiveHome: true };
  const requests = [];
  const app = express();
  app.use(SHIM_PREFIX, (req, _res, next) => {
    requests.push({ at: Date.now(), method: req.method, path: req.path, sessionId: sessionIdOf(req.headers) });
    next();
  });
  app.use(express.json({ limit: '50mb' }));
  registerMittrShim(app, {
    upstreamV1: `http://127.0.0.1:${platform.port}/v1`,
    localToken,
    ensureFreshSession: async () => state.session,
    engineOnActiveHome: () => state.onActiveHome,
    env: { MITTRCRAFT_SHIM_LOG: '1' },
    logger: { log: record, warn: record, error: record },
    upstreamTimeoutMs: SHIM_TIMEOUT_MS,
  });
  const port = await freePort();
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(port, '127.0.0.1', (error) => (error ? reject(error) : resolve(listening)));
  });
  return {
    port,
    localToken,
    state,
    requests,
    setState: (change) => Object.assign(state, { session: signedIn, onActiveHome: true }, change),
    baseURL: `http://127.0.0.1:${port}${SHIM_PREFIX}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
};

export const textsOf = (value, found = []) => {
  if (Array.isArray(value)) for (const item of value) textsOf(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'text' && typeof item === 'string') found.push(item);
      else textsOf(item, found);
    }
  }
  return found;
};

export const offeredTools = (body) => (Array.isArray(body?.tools) ? body.tools : [])
  .map((tool) => tool?.function?.name ?? tool?.name)
  .filter(Boolean);

export const toolToCall = (body, pattern) => {
  if (!pattern || hasToolResult(body)) return null;
  return offeredTools(body).find((name) => pattern.test(name)) ?? null;
};

const hasToolResult = (body) => (Array.isArray(body?.messages) ? body.messages : []).some((message) => message?.role === 'tool');

const systemPlainText = (body) => (Array.isArray(body?.messages) ? body.messages : [])
  .filter((message) => message?.role === 'system')
  .map((message) => (Array.isArray(message.content) ? textsOf(message.content).join('\n') : String(message.content ?? '')))
  .join('\n');

export const codeModeCall = (body, server, tool) => {
  if (hasToolResult(body) || !offeredTools(body).includes('execute')) return null;
  const callPath = `tools[${JSON.stringify(server)}].${tool}`;
  if (!systemPlainText(body).includes(`${callPath}(`)) return null;
  return { name: 'execute', arguments: { code: `return await ${callPath}({ query: "41" })` } };
};

const NO_ACTION = { action: 'none', stop: false };
const MCP_FALLBACK = 'Task 9 takes its named fallback: user-scope entries are written through context.opencode.userConfig and reconciled per account before each restart';

export const skillsMcpStopConditions = (scenarios) => {
  const { P8 = {}, P9 = {}, P10 = {}, P10b = {}, P11 = {}, P12 = {} } = scenarios;
  const conditions = {};
  if (!P8.nested && !P8.flat) conditions.P8 = { action: 'stop and report: catalog skills cannot reach the engine', stop: true };
  else if (!P8.nested) conditions.P8 = { action: 'Task 8 writes <skills>/mittr-<name>/ with the .mittr-version marker as the ownership mark, and drops the mittr/ folder', stop: false };
  else conditions.P8 = NO_ACTION;
  conditions.P9 = P9.pass ? NO_ACTION : { action: "after a change Task 8 calls context.opencode.refresh('mittr catalog skills changed'), as 1.22 did, and the note records the restart cost", stop: false };
  conditions.P10 = P10.pass ? NO_ACTION : { action: MCP_FALLBACK, stop: false };
  conditions.P10b = P10b.pass ? NO_ACTION : { action: MCP_FALLBACK, stop: false };
  const perProject = Array.isArray(P11.perProject) ? P11.perProject : [];
  conditions.P11 = P11.pass && perProject.every((n) => n <= 1)
    ? NO_ACTION
    : { action: 'owner note: the engine runs more than one connector process per project', stop: false };
  conditions.P12 = P12.pass ? NO_ACTION : { action: 'owner note: a removed connector is not stopped while the engine runs, so Task 9 cannot rely on a hot removal', stop: false };
  return conditions;
};

export const shimCallsFor = (logLines, sessionID) => logLines
  .map(({ line }) => line)
  .filter((line) => line.startsWith('[mittr] shim POST /chat/completions ') && line.endsWith(` session=${sessionID}`));

const probeShimTurn = async ({ client, collector, platform, shim, shimLog, work, mode, label, shimState = {}, windowMs = 20_000 }) => {
  platform.mode = mode;
  shim.setState(shimState);
  const { sessionID, createError } = await newSession(client, work, 'mittr', 'm1');
  if (!sessionID) {
    platform.mode = 'ok';
    return { observed: { createError } };
  }
  const run = await promptAndSettle({ client, collector, sessionID, text: `probe ${label}`, timeoutMs: windowMs });
  await sleep(Math.max(0, run.mark + windowMs - Date.now()));
  let interruptError = null;
  if (!run.idleAt) {
    try { await client.session.interrupt({ sessionID }); } catch (error) { interruptError = errorText(error); }
    await waitFor(() => sessionEvents(collector.events, sessionID, run.mark).find(isIdleEvent), 5000);
  }
  platform.mode = 'ok';
  shim.setState({});
  const events = sessionEvents(collector.events, sessionID, run.mark);
  const requests = platform.since(run.mark);
  const firstAnsweredAt = requests[0]?.answeredAt ?? null;
  let assistant = null;
  let messageError = null;
  let transcript = null;
  try {
    assistant = await lastAssistant(client, sessionID);
    const page = await client.message.list({ sessionID, limit: 50, order: 'asc' });
    transcript = page.data.map((m) => ({ type: m.type ?? m.role ?? null, texts: textsOf(m), error: m.error?.type ?? null, finish: m.finish ?? null }));
  } catch (error) {
    messageError = errorText(error);
  }
  const error = assistant?.error ?? null;
  return {
    observed: {
      sessionID,
      platformRequests: requests.length,
      shimRequests: shim.requests.filter((request) => request.sessionId === sessionID && request.path === '/chat/completions').length,
      platformRequestTimesMs: requests.map((r) => r.at - run.mark),
      platformAuthorization: [...new Set(requests.map((r) => (r.authorization === 'Bearer probe-platform-token' ? r.authorization : 'other')))],
      shimCalls: shimCallsFor(shimLog, sessionID).map((line) => line.replace(` session=${sessionID}`, '')),
      shimOtherLines: shimLog.filter(({ at, line }) => at >= run.mark && !line.startsWith('[mittr] shim POST ')).map(({ line }) => line),
      idleAfterAnswerMs: run.idleAt && firstAnsweredAt ? run.idleAt - firstAnsweredAt : null,
      idleAfterPromptMs: run.idleAt ? run.idleAt - run.mark : null,
      retrySeen: events.some(isRetryEvent),
      retryEvents: events.filter(isRetryEvent).length,
      events: summarizeEvents(events).slice(0, 24),
      assistantError: error ? { type: error.type, status: error.status ?? null, message: String(error.message ?? ''), responseBody: error.response?.body ?? null, keys: Object.keys(error).sort(), responseKeys: error.response ? Object.keys(error.response).sort() : null } : null,
      assistantTexts: textsOf(assistant),
      transcript,
      assistantFinish: assistant?.finish ?? null,
      messageError,
      interruptError,
      promptError: run.promptError,
    },
  };
};

const probeShim = async ({ client, collector, platform, shim, shimLog, work }) => {
  await waitFor(async () => (await modelIds(client, work).catch(() => [])).includes('mittr/m1'), 15_000, 100);
  let connectError = null;
  try {
    await client.integration.connect.key({ integrationID: 'mittr', key: shim.localToken, location: { directory: work } });
  } catch (error) {
    connectError = errorText(error);
  }
  const turn = (mode, label, shimState, windowMs) => probeShimTurn({ client, collector, platform, shim, shimLog, work, mode, label, shimState, windowMs });
  const control = await turn('ok', 'answer through the shim');
  const P2 = await turn('refuse', 'quota refusal through the shim');
  const P2b = await turn('midstream', 'mid-stream quota refusal through the shim');
  const cut = await turn('cut', 'stream cut after the first delta');
  const hang = await turn('hang', 'platform silent before the headers');
  const stall = await turn('stall', 'stream silent after the first delta');
  const entitlement = await turn('forbidden-entitlement', 'refused for want of an entitlement');
  const staleCatalog = await turn('forbidden-stale', 'refused because the agent was withdrawn');
  const notSignedIn = await turn('ok', 'no Mittr sign-in to read', { session: null });
  const switching = await turn('ok', 'engine on another account home', { onActiveHome: false });
  const unreachable = await turn('drop', 'platform drops the connection');
  const once = ({ observed }) => observed.platformRequests === 1 && observed.shimCalls.length === 1 && !observed.retrySeen;
  const quotaBody = ({ observed }) => String(observed.assistantError?.responseBody ?? '').includes('llm_quota_exhausted')
    || String(observed.assistantError?.message ?? '').includes('llm_quota_exhausted');
  const verdict = (value, pass) => ({ pass, ...value });
  const cutOff = ({ observed }) => once({ observed }) && observed.idleAfterAnswerMs !== null && observed.idleAfterAnswerMs <= 2000
    && observed.assistantError?.message === 'The answer was cut off. Send your message again.'
    && observed.assistantTexts.includes('partial ');
  const forbidden = ({ observed }, code) => once({ observed }) && observed.idleAfterAnswerMs !== null && observed.idleAfterAnswerMs <= 2000
    && observed.assistantError?.status === 403 && String(observed.assistantError?.responseBody ?? '').includes(code);
  const envelopeOf = ({ observed }) => {
    try {
      const { error } = JSON.parse(observed.assistantError?.responseBody ?? '');
      return error?.type === 'mittr_unavailable' ? error : null;
    } catch {
      return null;
    }
  };
  const readsAsEnvelope = ({ observed }, code, status) => {
    const envelope = envelopeOf({ observed });
    return envelope !== null && envelope.code === code && observed.assistantError?.status === status
      && observed.assistantError?.message === envelope.message;
  };
  const shimOwn = (turnResult, code, status) => !turnResult.observed.retrySeen
    && turnResult.observed.shimRequests === 1 && turnResult.observed.platformRequests === 0
    && readsAsEnvelope(turnResult, code, status);
  const scenarios = {
    control: verdict(control, control.observed.platformRequests === 1 && !control.observed.assistantError && control.observed.assistantTexts.some((t) => t.includes('hello from the platform'))),
    P2: verdict(P2, once(P2) && P2.observed.idleAfterAnswerMs !== null && P2.observed.idleAfterAnswerMs <= 2000 && P2.observed.assistantError?.status === 402 && quotaBody(P2)),
    P2b: verdict(P2b, once(P2b) && P2b.observed.idleAfterAnswerMs !== null && P2b.observed.idleAfterAnswerMs <= 2000 && P2b.observed.assistantError?.type === 'provider.quota' && quotaBody(P2b)),
    hang: verdict(hang, once(hang) && hang.observed.shimCalls[0] === '[mittr] shim POST /chat/completions timeout' && readsAsEnvelope(hang, 'platform_timeout', 504)),
    notSignedIn: verdict(notSignedIn, shimOwn(notSignedIn, 'not_signed_in', 401)),
    switching: verdict(switching, shimOwn(switching, 'switching_account', 503)),
    unreachable: verdict(unreachable, unreachable.observed.platformRequests === 1 && unreachable.observed.shimRequests === 1 && !unreachable.observed.retrySeen && readsAsEnvelope(unreachable, 'platform_unreachable', 502)),
    cut: verdict(cut, cutOff(cut)),
    stall: verdict(stall, cutOff(stall) && stall.observed.shimOtherLines.includes('[mittr] shim cut the answer: Mittr went silent')),
    entitlement: verdict(entitlement, forbidden(entitlement, 'desktop_entitlement_required') && entitlement.observed.shimOtherLines.includes('[mittr] model refused: entitlement')),
    staleCatalog: verdict(staleCatalog, forbidden(staleCatalog, 'agent_not_granted') && staleCatalog.observed.shimOtherLines.includes('[mittr] model refused: stale-catalog')),
  };
  return {
    pass: connectError === null && Object.values(scenarios).every((scenario) => scenario.pass),
    connectError,
    shimTimeoutMs: SHIM_TIMEOUT_MS,
    engineErrorTypes: Object.fromEntries(['notSignedIn', 'switching', 'unreachable', 'hang'].map((name) => [name, scenarios[name].observed.assistantError?.type ?? null])),
    scenarios,
  };
};

const tryPrompt = async ({ client, collector, stubs, work, providerID, modelID = 'm1' }) => {
  for (const s of Object.values(stubs)) s.mode = 'ok';
  const mark = Date.now();
  const { sessionID, createError } = await newSession(client, work, providerID, modelID);
  const counts = () => Object.fromEntries(Object.entries(stubs).map(([k, s]) => [k, s.since(mark).length]));
  if (!sessionID) return { providerID, answered: false, createError, stubRequests: counts() };
  const run = await promptAndSettle({ client, collector, sessionID, text: `probe via ${providerID}`, timeoutMs: 20_000 });
  await sleep(500);
  let assistant = null;
  let messageError = null;
  try { assistant = await lastAssistant(client, sessionID); } catch (error) { messageError = errorText(error); }
  const stubRequests = counts();
  const answered = (stubs[providerID]?.forSession(sessionID).length ?? 0) > 0 && Boolean(assistant) && !assistant.error;
  return {
    providerID,
    sessionID,
    answered,
    stubRequests,
    promptError: run.promptError,
    idle: Boolean(run.idleAt),
    assistantError: assistant?.error ? { type: assistant.error.type, status: assistant.error.status ?? null, message: String(assistant.error.message ?? '').slice(0, 300) } : null,
    messageError,
    events: summarizeEvents(sessionEvents(collector.events, sessionID, run.mark)).slice(0, 20),
  };
};

const modelIds = async (client, work) => {
  const out = await client.model.list({ location: { directory: work } });
  return out.data.map((m) => `${m.providerID}/${m.id}`).sort();
};

const readLogs = (home, logFile) => {
  const dir = path.join(home, '.local/share/opencode/log');
  const files = [logFile];
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isFile()) files.push(path.join(dir, entry.name));
  }
  return files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
};

export const failuresOf = (result, scenarios = SCENARIOS) => {
  const failures = [];
  if (result.fatal) failures.push('fatal');
  for (const name of scenarios) {
    if (!result.scenarios[name]) failures.push(`${name}: no verdict`);
    else if (!result.scenarios[name].pass) failures.push(`${name}: FAIL`);
  }
  const outbound = result.outbound;
  if (!outbound) failures.push('outbound: not recorded');
  else {
    if (outbound.nonLoopbackRemotes.length > 0) failures.push(`outbound: lsof ${outbound.nonLoopbackRemotes.join(', ')}`);
    if (outbound.nonLoopbackHostsInLog.length > 0) failures.push(`outbound: log ${outbound.nonLoopbackHostsInLog.join(', ')}`);
    if (outbound.proxyNonLoopback.length > 0) failures.push(`outbound: proxy ${outbound.proxyNonLoopback.join(', ')}`);
  }
  return failures;
};

/**
 * P7 (R45): providers and policies the user or a repository allows must not
 * undo the Mittr lock. Every "attacker" layer allows every provider (`*`, the
 * `other` stub and the hosted `opencode` by name) and defines `other`. Our
 * provider, plugin and policies come from the real managed-config runtime, as
 * the server builds them. Locked runs: a turn on `other` is refused before any
 * request, `stub` answers, and `opencode` is refused with no egress (R52).
 * Open runs (R40): `other` answers and `opencode` stays refused.
 *
 * Diagnostics record which rule the engine obeys and are not part of the
 * verdict: the order inside one policy list, our lock placed only in
 * OPENCODE_CONFIG_CONTENT under a user file, and a global config allow.
 */
const probeUserPolicy = async ({ home, stubs, proxy, identityDir, startWith }) => {
  const { createManagedConfigRuntime } = await import(pathToFileURL(path.join(REPO, 'packages/web/server/lib/opencode/managed-config-file.js')).href);
  const userFile = path.join(home, 'user-opencode.json');
  const repoFile = path.join(home, 'work', 'opencode.json');
  const globalFile = path.join(home, '.config', 'opencode', 'opencode.json');
  const other = providerEntry('Other', `http://127.0.0.1:${stubs.other.port}/v1`, ['m1']);
  const stub = providerEntry('Stub', `http://127.0.0.1:${stubs.stub.port}/v1`, ['m1']);
  const allowAll = { providers: { other }, experimental: { policies: USER_ALLOW_POLICIES } };
  const lock = policiesFor({ showOtherProviders: false, providerId: 'stub' });
  const fragment = (showOtherProviders) => ({
    providers: { stub },
    plugins: [identityDir],
    experimental: { policies: policiesFor({ showOtherProviders, providerId: 'stub' }) },
  });
  let dataDirs = 0;
  const serverEnv = async ({ showOtherProviders, userEnv = {} }) => {
    dataDirs += 1;
    const runtime = createManagedConfigRuntime({
      fsPromises: fs.promises,
      path,
      dataDir: path.join(home, `p7-data-${dataDirs}`),
      env: userEnv,
      readSettings: async () => ({}),
      isAgentMemoryAvailable: () => false,
      contributeConfig: async () => fragment(showOtherProviders),
    });
    const childEnv = await runtime.buildManagedChildEnv();
    return { ...userEnv, ...childEnv };
  };
  const egressSince = (mark) => proxy.attempts.filter((a) => a.at >= mark && !a.loopback).map(({ kind, host, port }) => ({ kind, host, port }));
  const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
  const placeFiles = (files) => {
    for (const file of [userFile, repoFile, globalFile]) fs.rmSync(file, { force: true });
    for (const [file, value] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, value);
    }
  };

  // The environment is built after the files are in place, as the server
  // builds it at each start from what is on disk then.
  const run = async ({ label, files = {}, buildEnv, prompts }) => {
    placeFiles(files);
    const env = await buildEnv();
    const { client, collector, engine } = await startWith(env);
    const observed = {
      label,
      layers: {
        OPENCODE_CONFIG: env.OPENCODE_CONFIG ? { file: path.relative(home, env.OPENCODE_CONFIG), policies: readJson(env.OPENCODE_CONFIG)?.experimental?.policies ?? null } : null,
        OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT).experimental?.policies ?? null : null,
        files: Object.fromEntries(Object.entries(files).map(([file, value]) => [path.relative(home, file), value.experimental?.policies ?? null])),
      },
    };
    try {
      for (const [providerID, modelID] of prompts) {
        const mark = Date.now();
        const attempt = await tryPrompt({ client, collector, stubs, work: engine.work, providerID, modelID });
        observed[providerID] = { ...attempt, refusedByPolicy: refusedByPolicy(attempt), egress: egressSince(mark) };
      }
      observed.modelsListed = await modelIds(client, engine.work).catch((error) => `error: ${errorText(error)}`);
    } finally {
      await collector.stop();
      await stopEngine(engine);
      placeFiles({});
    }
    return observed;
  };
  const allPrompts = [['other', 'm1'], ['stub', 'm1'], ['opencode', HOSTED_MODEL]];
  const userOwned = (content) => {
    const env = { OPENCODE_CONFIG: userFile };
    if (content) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content);
    return env;
  };

  const lockedContent = await run({
    label: 'switch OFF; the user sets OPENCODE_CONFIG and allows every provider in OPENCODE_CONFIG_CONTENT',
    files: { [userFile]: { providers: { other } } },
    buildEnv: () => serverEnv({ showOtherProviders: false, userEnv: userOwned({ experimental: { policies: USER_ALLOW_POLICIES } }) }),
    prompts: allPrompts,
  });
  const lockedFile = await run({
    label: 'switch OFF; the user allows every provider in their own OPENCODE_CONFIG file',
    files: { [userFile]: allowAll },
    buildEnv: () => serverEnv({ showOtherProviders: false, userEnv: userOwned(null) }),
    prompts: allPrompts,
  });
  const lockedRepo = await run({
    label: 'switch OFF; the project opencode.json allows every provider',
    files: { [repoFile]: allowAll },
    buildEnv: () => serverEnv({ showOtherProviders: false }),
    prompts: allPrompts,
  });
  const openRepo = await run({
    label: 'switch ON; the project opencode.json allows every provider',
    files: { [repoFile]: allowAll },
    buildEnv: () => serverEnv({ showOtherProviders: true }),
    prompts: allPrompts,
  });
  const open = await run({
    label: 'switch ON; the user sets OPENCODE_CONFIG and allows every provider in OPENCODE_CONFIG_CONTENT',
    files: { [userFile]: { providers: { other } } },
    buildEnv: () => serverEnv({ showOtherProviders: true, userEnv: userOwned({ experimental: { policies: USER_ALLOW_POLICIES } }) }),
    prompts: allPrompts,
  });

  const oneList = (policies) => ({ OPENCODE_CONFIG: userFile, OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { stub, other }, experimental: { policies } }) });
  const lockLastInList = await run({
    label: 'diagnostic: one list, the lock after the allows',
    files: { [userFile]: {} },
    buildEnv: async () => oneList([...USER_ALLOW_POLICIES, ...lock]),
    prompts: [['other', 'm1']],
  });
  const lockFirstInList = await run({
    label: 'diagnostic: one list, the lock before the allows',
    files: { [userFile]: {} },
    buildEnv: async () => oneList([...lock, ...USER_ALLOW_POLICIES]),
    prompts: [['other', 'm1']],
  });
  const lockInContentUnderUserFile = await run({
    label: 'diagnostic: the lock only in OPENCODE_CONFIG_CONTENT, the allows in the user OPENCODE_CONFIG file',
    files: { [userFile]: allowAll },
    buildEnv: async () => ({ OPENCODE_CONFIG: userFile, OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { stub }, plugins: [identityDir], experimental: { policies: lock } }) }),
    prompts: [['other', 'm1']],
  });
  const globalAllow = await run({
    label: 'diagnostic: the managed lock against a global opencode.json that allows every provider',
    files: { [globalFile]: allowAll },
    buildEnv: () => serverEnv({ showOtherProviders: false }),
    prompts: [['other', 'm1']],
  });

  const locked = (o) => o.other.refusedByPolicy && o.other.stubRequests.other === 0 && o.stub.answered;
  const hostedDenied = (o) => o.opencode.refusedByPolicy && o.opencode.egress.length === 0;
  const refusedOther = (o) => o.other.refusedByPolicy && o.other.stubRequests.other === 0;
  const pass = [lockedContent, lockedFile, lockedRepo].every((o) => locked(o) && hostedDenied(o))
    && [openRepo, open].every((o) => o.other.answered && o.stub.answered && hostedDenied(o));
  return {
    pass,
    engineObeys: {
      lockLastInOneList: refusedOther(lockLastInList),
      lockFirstInOneList: refusedOther(lockFirstInList),
      lockInContentOverUserFile: refusedOther(lockInContentUnderUserFile),
      lockInManagedFileOverGlobal: refusedOther(globalAllow),
    },
    lockedContent,
    lockedFile,
    lockedRepo,
    openRepo,
    open,
    diagnostics: { lockLastInList, lockFirstInList, lockInContentUnderUserFile, globalAllow },
  };
};

// How long each run stays up after its first turn, so a background fetch the
// engine starts on its own has time to show.
const OUTBOUND_SETTLE_MS = 15_000;

/**
 * One engine run as the app drives it: start, list the models and the
 * providers, answer a turn on the loopback stub, then stay up a while.
 */
const outboundRun = async ({ OpenCode, home, configFile, hookLog, stubs, proxy, outboundEnv, onSpawn }) => {
  fs.mkdirSync(home, { recursive: true });
  let engine = null;
  await startEngine({
    home, configFile, logFile: path.join(home, 'engine.out.log'), proxyPort: proxy.port, hookLog, outboundEnv,
    onSpawn: (spawned) => { engine = spawned; onSpawn(spawned); },
  });
  const client = OpenCode.make({ baseUrl: engine.base, headers: engine.headers });
  const collector = collectEvents(client);
  try {
    await sleep(500);
    await waitFor(async () => (await modelIds(client, engine.work).catch(() => [])).includes('stub/m1'), 15_000, 100);
    const models = await modelIds(client, engine.work).catch((error) => `error: ${errorText(error)}`);
    const providers = await client.provider.list({ location: { directory: engine.work } })
      .then((out) => (out.data ?? out).length)
      .catch((error) => `error: ${errorText(error)}`);
    const integrations = await client.integration.list({ location: { directory: engine.work } })
      .then((out) => (out.data ?? out).length)
      .catch((error) => `error: ${errorText(error)}`);
    const turn = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    await sleep(OUTBOUND_SETTLE_MS);
    return { models, providers, integrations, answered: turn.answered, settledMs: OUTBOUND_SETTLE_MS };
  } finally {
    await collector.stop().catch(() => {});
    await stopEngine(engine);
  }
};

/**
 * R69: with the server's outbound switches the engine makes no attempt to
 * leave the machine. The control run is the same engine and the same steps
 * without the switches, behind its own recording proxy and in its own HOME,
 * so the probe shows what the switches stop and that the proxy catches it.
 */
const probeOutbound = async ({ OpenCode, home, configFile, hookLog, stubs, proxy, onSpawn }) => {
  const ours = await outboundRun({ OpenCode, home, configFile, hookLog, stubs, proxy, outboundEnv: ENGINE_OUTBOUND_OFF, onSpawn });

  const controlHome = path.join(home, 'control');
  const controlProxy = await startProxy();
  const controlSink = { samples: 0, pids: [], remotes: new Set(), loopbackPeers: new Map() };
  let controlEngine = null;
  const stopControlSampler = startOutboundSampler(() => controlEngine?.pid ?? null, controlSink);
  let control;
  try {
    const run = await outboundRun({
      OpenCode, home: controlHome, configFile, hookLog, stubs, proxy: controlProxy, outboundEnv: {},
      onSpawn: (spawned) => { controlEngine = spawned; onSpawn(spawned, { control: true }); },
    });
    control = {
      ...run,
      without: Object.keys(ENGINE_OUTBOUND_OFF),
      proxyNonLoopback: [...new Set(controlProxy.attempts.filter((a) => !a.loopback).map((a) => `${a.host}:${a.port}`))].sort(),
      nonLoopbackRemotes: [...controlSink.remotes].sort(),
      nonLoopbackHostsInLog: nonLoopbackFromLog(readLogs(controlHome, path.join(controlHome, 'engine.out.log'))).sort(),
    };
  } finally {
    await stopControlSampler();
    await controlProxy.close();
  }
  return {
    pass: Array.isArray(ours.models) && ours.models.includes('stub/m1') && ours.answered && control.proxyNonLoopback.length > 0,
    ours: { env: ENGINE_OUTBOUND_OFF, ...ours },
    control,
  };
};

const STUB_MCP = path.join(REPO, 'scripts/mittr/stub-mcp-server.mjs');
const SKILLS_MCP_SCENARIOS = ['P8', 'P9', 'P10', 'P10b', 'P11', 'P12'];
const HOT_WINDOW_MS = 10_000;
const MCP_NAME = 'mittr-probe';
const LOOKUP = /lookup/;

const writeSkill = (dir, name, description) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nAnswer with the word ${name}.\n`, { mode: 0o600 });
};

const listSkills = async (client, directory) => {
  const out = await client.skill.list({ location: { directory } });
  return (out.data ?? out).map((skill) => ({ id: skill.id, name: skill.name, path: skill.path }));
};

const listMcp = async (client, directory) => {
  const out = await client.mcp.list({ location: { directory } });
  return (out.data ?? out).map((server) => ({ name: server.name, status: server.status?.status ?? null, error: server.status?.error ?? null }));
};

const markerProcesses = (marker) => {
  const out = spawnSync('pgrep', ['-fl', `stub-mcp-server.*${marker}`], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean).map((line) => {
    const [pid, ...rest] = line.trim().split(' ');
    return { pid: Number(pid), command: rest.join(' ').split(' ')[0] };
  }).filter((p) => p.pid && p.pid !== process.pid);
};

const readStubLog = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : []);

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const promptApproving = async ({ client, collector, sessionID, text, timeoutMs = 30_000 }) => {
  const mark = Date.now();
  let promptError = null;
  const permissions = [];
  const sent = client.session.prompt({ sessionID, text }).catch((error) => { promptError = errorText(error); });
  const idle = await waitFor(async () => {
    const pending = await client.permission.list({ sessionID }).catch(() => []);
    for (const request of (Array.isArray(pending) ? pending : pending?.data ?? [])) {
      if (permissions.some((p) => p.id === request.id)) continue;
      permissions.push({ id: request.id, action: request.action, resources: request.resources });
      await client.permission.reply({ sessionID, requestID: request.id, decision: 'once' }).catch(() => {});
    }
    return sessionEvents(collector.events, sessionID, mark).find(isIdleEvent);
  }, timeoutMs, 250);
  await Promise.race([sent, sleep(1000)]);
  return { mark, promptError, idleAt: idle?.at ?? null, permissions };
};

const toolTurn = async ({ client, collector, stub, directory, label, awaitConnected = false }) => {
  const connectAt = Date.now();
  const connected = awaitConnected
    ? await waitFor(async () => (await listMcp(client, directory).catch(() => [])).some((s) => s.name === MCP_NAME && s.status === 'connected'), HOT_WINDOW_MS, 250)
    : null;
  const connectedAfterMs = connected ? Date.now() - connectAt : null;
  const { sessionID, createError } = await newSession(client, directory, 'stub', 'm1');
  if (!sessionID) return { createError };
  stub.mode = 'tool';
  stub.pickCall = (body) => {
    const direct = toolToCall(body, LOOKUP);
    return direct ? { name: direct, arguments: { query: '41' } } : codeModeCall(body, MCP_NAME, 'lookup');
  };
  const run = await promptApproving({ client, collector, sessionID, text: `Use the lookup tool for law 41 (${label}).` });
  stub.mode = 'ok';
  stub.pickCall = null;
  const requests = stub.forSession(sessionID);
  const toolResults = requests.flatMap((r) => (r.body?.messages ?? []).filter((m) => m.role === 'tool')).map((m) => textsOf(m).join('') || String(m.content ?? ''));
  return {
    sessionID,
    connectedAfterMs,
    requests: requests.length,
    offered: [...new Set(requests.flatMap((r) => offeredTools(r.body)))].sort(),
    inCodeModeCatalog: requests.some((r) => systemPlainText(r.body).includes(`tools[${JSON.stringify(MCP_NAME)}].lookup(`)),
    calledTool: requests.map((r) => r.calledTool).find(Boolean) ?? null,
    catalogEntry: (() => {
      const text = requests[0] ? systemPlainText(requests[0].body) : '';
      const at = text.indexOf(`- ${MCP_NAME} (`);
      return at === -1 ? null : text.slice(at, text.indexOf('\n- ', at + 2) === -1 ? at + 300 : text.indexOf('\n- ', at + 2));
    })(),
    codeModeHeading: requests[0] ? systemPlainText(requests[0].body).includes('# Code Mode') : null,
    executeArguments: requests.flatMap((r) => (r.body?.messages ?? []).flatMap((m) => m.tool_calls ?? [])).map((c) => c.function?.arguments ?? null).slice(0, 2),
    toolResultHead: toolResults.map((t) => t.slice(0, 200)).slice(0, 2),
    toolResultSeen: toolResults.some((t) => t.includes('stub-law-41')),
    permissions: run.permissions,
    idle: Boolean(run.idleAt),
    promptError: run.promptError,
    events: summarizeEvents(sessionEvents(collector.events, sessionID, run.mark)).slice(0, 20),
  };
};

const toolTurnUntilOffered = async ({ since, ...input }) => {
  const attempts = [];
  for (;;) {
    const turn = await toolTurn({ ...input, awaitConnected: input.awaitConnected && attempts.length === 0 });
    attempts.push({ afterMs: Date.now() - since, inCodeModeCatalog: turn.inCodeModeCatalog, calledTool: turn.calledTool });
    if (turn.calledTool || turn.inCodeModeCatalog || Date.now() - since >= HOT_WINDOW_MS) return { ...turn, attempts };
    await sleep(500);
  }
};

const toolTurnUntilGone = async ({ since, ...input }) => {
  const attempts = [];
  for (;;) {
    const turn = await toolTurn(input);
    const offered = turn.inCodeModeCatalog || (turn.offered ?? []).some((name) => LOOKUP.test(name));
    attempts.push({ afterMs: Date.now() - since, offered, calledTool: turn.calledTool, toolResultHead: turn.toolResultHead ?? [] });
    if (!offered || Date.now() - since >= HOT_WINDOW_MS) return { ...turn, offered, attempts };
    await sleep(500);
  }
};

const underHome = (home) => (value) => (value?.startsWith(home) ? `<home>${value.slice(home.length)}` : value);

const runAsServer = ({ home, directory, managedFile = null }) => {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  };
  if (managedFile) env.OPENCODE_CONFIG = managedFile;
  const mcpUrl = pathToFileURL(path.join(REPO, 'packages/web/server/lib/opencode/mcp.js')).href;
  const sharedUrl = pathToFileURL(path.join(REPO, 'packages/web/server/lib/opencode/shared.js')).href;
  const script = [
    `const { listMcpConfigs } = await import(${JSON.stringify(mcpUrl)});`,
    `const { readConfigLayers, getJsonEntrySource } = await import(${JSON.stringify(sharedUrl)});`,
    `const directory = ${JSON.stringify(directory)};`,
    'const layers = readConfigLayers(directory);',
    "const list = listMcpConfigs(directory).map((e) => ({ name: e.name, type: e.type, scope: e.scope, sectionKey: e.sectionKey, legacy: e.legacy, source: getJsonEntrySource(layers, 'mcp', e.name).path }));",
    'process.stdout.write(JSON.stringify({ paths: layers.paths, list }));',
  ].join('\n');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, cwd: REPO, encoding: 'utf8', timeout: 30_000 });
  const rel = underHome(home);
  try {
    const parsed = JSON.parse(out.stdout);
    return {
      env: { OPENCODE_CONFIG: managedFile ? rel(managedFile) : null },
      paths: Object.fromEntries(Object.entries(parsed.paths).map(([k, v]) => [k, rel(v)])),
      list: parsed.list.map((e) => ({ ...e, source: rel(e.source) })),
    };
  } catch {
    return { error: `${out.status} ${String(out.stderr).slice(0, 600)}` };
  }
};

const probeSkillsMcp = async ({ home, configFile, baseConfig, stub, connect, current, marker, stubLog }) => {
  const configDir = path.join(home, '.config', 'opencode');
  const skillsRoot = path.join(configDir, 'skills');
  const engineEnv = { OPENCODE_CONFIG_DIR: configDir, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const layouts = {
    nested: { dir: path.join(skillsRoot, 'mittr', 'probe-skill'), name: 'probe-skill', description: 'Probe skill' },
    flat: { dir: path.join(skillsRoot, 'mittr-probe-skill'), name: 'mittr-probe-skill', description: 'Probe skill flat' },
    mismatch: { dir: path.join(skillsRoot, 'mittr-probe-mismatch'), name: 'probe-mismatch-name', description: 'Probe skill mismatched name' },
    developerCollide: { dir: path.join(skillsRoot, 'probe-collide'), name: 'probe-collide', description: 'Developer collide' },
    catalogCollide: { dir: path.join(skillsRoot, 'mittr', 'probe-collide'), name: 'probe-collide', description: 'Catalog collide' },
  };
  for (const layout of Object.values(layouts)) writeSkill(layout.dir, layout.name, layout.description);
  writeJsonAtomic(configFile, baseConfig());
  const client = await connect(engineEnv);
  const { engine, collector } = current();
  const work = engine.work;
  const enginePid = engine.pid;
  const engineAlive = () => current().engine === engine && engine.child.exitCode === null && engine.child.signalCode === null && isAlive(enginePid);
  const rel = underHome(home);
  const scenarios = {};

  const listedAt = Date.now();
  let skills = [];
  await waitFor(async () => {
    skills = await listSkills(client, work).catch((error) => `error: ${errorText(error)}`);
    return Array.isArray(skills) && skills.some((s) => String(s.path).startsWith(skillsRoot));
  }, HOT_WINDOW_MS, 250);
  const firstListedAfterMs = Date.now() - listedAt;
  const ours = Array.isArray(skills) ? skills.filter((s) => String(s.path).startsWith(skillsRoot)).map((s) => ({ ...s, path: rel(s.path) })) : skills;
  const skillTurn = await newSession(client, work, 'stub', 'm1');
  let skillRequest = null;
  if (skillTurn.sessionID) {
    await promptApproving({ client, collector, sessionID: skillTurn.sessionID, text: 'Which skills do you have?' });
    skillRequest = stub.forSession(skillTurn.sessionID).at(0) ?? null;
  }
  const requestText = skillRequest ? `${JSON.stringify(skillRequest.body?.tools ?? [])}\n${systemPlainText(skillRequest.body)}` : '';
  const skillTool = (skillRequest?.body?.tools ?? []).find((t) => t?.function?.name === 'skill');
  const found = (layout) => {
    const listed = Array.isArray(ours) ? ours.find((s) => s.path === rel(path.join(layout.dir, 'SKILL.md'))) ?? null : null;
    return {
      folder: rel(layout.dir),
      frontmatterName: layout.name,
      listed: Boolean(listed),
      id: listed?.id ?? null,
      listedName: listed?.name ?? null,
      inRequest: requestText.includes(layout.name),
      inSkillToolDescription: String(skillTool?.function?.description ?? '').includes(layout.name),
      inAvailableSkillsAs: (() => {
        const block = (requestText.match(/<available_skills>[\s\S]*?<\/available_skills>/) ?? [''])[0];
        const entry = [...block.matchAll(/<skill>\s*<id>([^<]*)<\/id>\s*<name>([^<]*)<\/name>/g)].find((m) => m[2] === layout.name);
        return entry ? { id: entry[1], name: entry[2] } : null;
      })(),
    };
  };
  const availableSkills = (requestText.match(/<available_skills>[\s\S]*?<\/available_skills>/) ?? [null])[0];
  const collide = {
    listed: Array.isArray(ours) ? ours.filter((s) => s.id === 'probe-collide' || s.name === 'probe-collide') : ours,
    developerInRequest: requestText.includes('Developer collide'),
    catalogInRequest: requestText.includes('Catalog collide'),
  };
  const nested = found(layouts.nested);
  const flat = found(layouts.flat);
  const mismatch = found(layouts.mismatch);
  const reaches = (f) => f.listed || f.inRequest;
  scenarios.P8 = {
    pass: reaches(nested) || reaches(flat),
    nested: reaches(nested),
    flat: reaches(flat),
    mismatchedNameAccepted: reaches(mismatch),
    idForm: { nested: nested.id ?? nested.inAvailableSkillsAs?.id ?? null, flat: flat.id ?? flat.inAvailableSkillsAs?.id ?? null },
    observed: {
      nested,
      flat,
      mismatch,
      collision: collide,
      firstListedAfterMs,
      availableSkillsOurs: availableSkills ? availableSkills.split('<skill>').filter((part) => /Probe skill|collide/.test(part)).map((part) => part.replace(/\s+/g, ' ').trim()) : null,
      skillsUnderConfigDir: ours,
      skillsListedTotal: Array.isArray(skills) ? skills.length : skills,
      offeredTools: skillRequest ? offeredTools(skillRequest.body) : null,
      skillToolDescriptionHead: skillTool ? String(skillTool.function.description).slice(0, 400) : null,
      requestSeen: Boolean(skillRequest),
      createError: skillTurn.createError,
    },
  };

  const hot = {
    nested: { dir: path.join(skillsRoot, 'mittr', 'probe-hot'), name: 'probe-hot', description: 'Probe skill added hot' },
    flat: { dir: path.join(skillsRoot, 'mittr-probe-hot'), name: 'mittr-probe-hot', description: 'Probe skill flat added hot' },
  };
  const hotAt = Date.now();
  for (const layout of Object.values(hot)) writeSkill(layout.dir, layout.name, layout.description);
  const seenAt = {};
  await waitFor(async () => {
    const now = await listSkills(client, work).catch(() => []);
    for (const [key, layout] of Object.entries(hot)) {
      if (seenAt[key] === undefined && now.some((s) => s.path === path.join(layout.dir, 'SKILL.md'))) seenAt[key] = Date.now() - hotAt;
    }
    return Object.keys(seenAt).length === Object.keys(hot).length;
  }, HOT_WINDOW_MS, 250);
  const layoutsThatWork = ['nested', 'flat'].filter((key) => scenarios.P8[key]);
  scenarios.P9 = {
    pass: layoutsThatWork.length > 0 && layoutsThatWork.every((key) => seenAt[key] !== undefined) && engineAlive(),
    observed: {
      pickedUpAfterMs: { nested: seenAt.nested ?? null, flat: seenAt.flat ?? null },
      windowMs: HOT_WINDOW_MS,
      enginePidBefore: enginePid,
      enginePidAfter: current().engine.pid,
      engineAlive: engineAlive(),
    },
  };

  const raw = { type: 'local', command: ['node', STUB_MCP, '--log', stubLog, '--marker', marker] };
  const entity = mcpEntityFromCatalog(raw);
  const withMcp = () => ({ ...baseConfig(), mcp: { servers: { [MCP_NAME]: entity } } });
  const mcpAt = Date.now();
  writeJsonAtomic(configFile, withMcp());
  let lastStatus = null;
  const connected = await waitFor(async () => {
    lastStatus = await listMcp(client, work).catch((error) => `error: ${errorText(error)}`);
    return Array.isArray(lastStatus) && lastStatus.some((s) => s.name === MCP_NAME && s.status === 'connected');
  }, HOT_WINDOW_MS, 250);
  const connectedAfterMs = connected ? Date.now() - mcpAt : null;
  const callsBefore = readStubLog(stubLog).filter((e) => e.event === 'call').length;
  const turn = await toolTurnUntilOffered({ client, collector, stub, directory: work, label: 'P10', since: mcpAt });
  await sleep(500);
  const callsDuring = readStubLog(stubLog).filter((e) => e.event === 'call').length - callsBefore;
  scenarios.P10 = {
    pass: Boolean(connected) && callsDuring === 1 && turn.toolResultSeen && engineAlive(),
    observed: {
      entity: { type: entity?.type, command: entity?.command?.map((part) => rel(part)), disabled: entity?.disabled ?? null },
      connectedAfterMs,
      status: lastStatus,
      stubCalls: callsDuring,
      turn,
      enginePidUnchanged: current().engine.pid === enginePid,
      engineAlive: engineAlive(),
    },
  };

  const asServer = runAsServer({ home, directory: work });
  const asChild = runAsServer({ home, directory: work, managedFile: configFile });
  const listedAsServer = Array.isArray(asServer.list) && asServer.list.some((e) => e.name === MCP_NAME);
  const listedAsChild = Array.isArray(asChild.list) && asChild.list.some((e) => e.name === MCP_NAME);
  scenarios.P10b = {
    pass: listedAsServer,
    expected: 'not listed (preflight F14)',
    listed: listedAsServer,
    editable: listedAsServer,
    observed: {
      serverEnv: asServer,
      routeMergesEngineStatus: false,
      pageReadOnlyState: false,
      diagnosticWithManagedFileInServerEnv: {
        listed: listedAsChild,
        entry: Array.isArray(asChild.list) ? asChild.list.find((e) => e.name === MCP_NAME) ?? null : null,
        editsWouldWriteTo: Array.isArray(asChild.list) ? asChild.list.find((e) => e.name === MCP_NAME)?.source ?? null : null,
        result: asChild,
      },
    },
  };

  const projects = ['p1', 'p2', 'p3'].map((name) => {
    const dir = path.join(home, 'projects', name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  const stubPids = () => new Set(readStubLog(stubLog).filter((e) => e.event === 'start').map((e) => e.pid));
  const liveStubs = () => [...stubPids()].filter(isAlive);
  const liveBefore = liveStubs();
  const seen = new Set(liveBefore);
  const perProject = [];
  const projectTurns = [];
  for (const dir of projects) {
    const callsBeforeProject = readStubLog(stubLog).filter((e) => e.event === 'call').length;
    const projectTurn = await toolTurnUntilOffered({ client, collector, stub, directory: dir, label: path.basename(dir), awaitConnected: true, since: Date.now() });
    await sleep(500);
    const live = liveStubs();
    const fresh = live.filter((pid) => !seen.has(pid));
    for (const pid of live) seen.add(pid);
    perProject.push(fresh.length);
    const projectCalls = readStubLog(stubLog).filter((e) => e.event === 'call').slice(callsBeforeProject);
    projectTurns.push({ project: rel(dir), newStubProcesses: fresh.length, connectedAfterMs: projectTurn.connectedAfterMs, stubCalls: projectCalls.length, stubCallCwds: projectCalls.map((e) => rel(e.cwd)), turnsUntilOffered: projectTurn.attempts.length, calledTool: projectTurn.calledTool, toolResultSeen: projectTurn.toolResultSeen, permissions: projectTurn.permissions.length, promptError: projectTurn.promptError ?? projectTurn.createError ?? null });
  }
  const liveAfter = liveStubs();
  const n = liveAfter.filter((pid) => !liveBefore.includes(pid)).length;
  const starts = readStubLog(stubLog).filter((e) => e.event === 'start').map((e) => ({ pid: e.pid, cwd: rel(e.cwd), alive: isAlive(e.pid) }));
  scenarios.P11 = {
    pass: n <= 3 && projectTurns.every((t) => t.stubCalls === 1 && t.toolResultSeen),
    n,
    perProject,
    observed: {
      liveBeforeP11: liveBefore.length,
      liveAfterP11: liveAfter.length,
      pgrepMarkerCount: markerProcesses(marker).length,
      pgrepCommands: [...new Set(markerProcesses(marker).map((p) => path.basename(p.command)))],
      projectTurns,
      starts,
    },
  };

  const removeAt = Date.now();
  writeJsonAtomic(configFile, baseConfig());
  const gone = await waitFor(() => markerProcesses(marker).length === 0, HOT_WINDOW_MS, 250);
  const goneAfterMs = gone ? Date.now() - removeAt : null;
  const statusAfter = await listMcp(client, work).catch((error) => `error: ${errorText(error)}`);
  const removedTurn = await toolTurnUntilGone({ client, collector, stub, directory: work, label: 'P12', since: removeAt });
  const stillOffered = removedTurn.offered;
  scenarios.P12 = {
    pass: Boolean(gone) && !stillOffered,
    observed: {
      processesGoneAfterMs: goneAfterMs,
      liveAfterWindow: markerProcesses(marker).length,
      statusAfter,
      toolStillOffered: stillOffered,
      turnsUntilGone: removedTurn.attempts,
      liveAtEnd: markerProcesses(marker).length,
      enginePidUnchanged: current().engine.pid === enginePid,
      engineAlive: engineAlive(),
    },
  };
  scenarios.stubLog = readStubLog(stubLog).map((e) => ({ event: e.event, pid: e.pid, cwd: rel(e.cwd), at: e.at - mcpAt, signal: e.signal ?? null }));
  return scenarios;
};

const main = async () => {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf('--json');
  if (jsonIndex === -1 || !args[jsonIndex + 1]) {
    console.error('usage: node scripts/mittr/probe-engine-v2.mjs --json <out> [--keep]');
    return 2;
  }
  const out = path.resolve(args[jsonIndex + 1]);
  const keep = args.includes('--keep');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex === -1 ? null : args[onlyIndex + 1];
  if (only !== null && !['P7', 'outbound', 'shim', 'skills-mcp'].includes(only)) {
    console.error('--only takes P7, outbound, shim or skills-mcp');
    return 2;
  }
  const scenarios = only === 'skills-mcp' ? SKILLS_MCP_SCENARIOS : (only ? [only] : SCENARIOS);
  if (!fs.existsSync(ENGINE)) throw new Error(`engine binary missing: ${ENGINE} (run prepare:opencode-cli)`);

  const { OpenCode } = await import('@opencode/client');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2.')));
  const configFile = path.join(home, 'opencode.managed.json');
  const logFile = path.join(home, 'engine.out.log');
  const hookLog = path.join(home, 'hooks.jsonl');
  const identityDir = path.join(home, 'engine-plugins', 'mittrcraft-identity');
  const recorderDir = path.join(home, 'engine-plugins', 'probe-hook-recorder');
  const retryDir = path.join(home, 'engine-plugins', 'probe-retry-hook');
  const outbound = { samples: 0, pids: [], remotes: new Set(), loopbackPeers: new Map() };
  const engines = [];
  let engine = null;
  let collector = null;
  let proxy = null;
  let stopSampler = null;
  let platform = null;
  let shim = null;
  const shimLog = [];
  const stubs = {};
  const marker = `mittr-probe-${randomBytes(6).toString('hex')}`;
  const stubLog = path.join(home, 'stub-mcp.jsonl');
  const leftovers = { killed: [], afterCleanup: null };
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await collector?.stop().catch(() => {});
    for (const started of engines) await stopEngine(started).catch(() => {});
    for (const { pid } of markerProcesses(marker)) {
      leftovers.killed.push(pid);
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    if (leftovers.killed.length > 0) await sleep(1000);
    for (const { pid } of markerProcesses(marker)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    leftovers.afterCleanup = markerProcesses(marker).length;
    await stopSampler?.().catch(() => {});
    for (const s of Object.values(stubs)) await s.close?.();
    await shim?.close();
    await platform?.close();
    await proxy?.close();
    if (!keep) fs.rmSync(home, { recursive: true, force: true });
  };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  process.once('uncaughtException', (error) => {
    console.error(error);
    cleanup().finally(() => process.exit(1));
  });

  const result = {
    engine: path.relative(REPO, ENGINE),
    engineVersion: null,
    startedAt: new Date().toISOString(),
    scenarios: {},
    stopConditions: {},
    outbound: null,
  };
  try {
    const versionEnv = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache') };
    result.engineVersion = spawnSync(ENGINE, ['--version'], { encoding: 'utf8', env: versionEnv }).stdout.trim();

    stubs.stub = await startStub('stub');
    stubs.other = await startStub('other');
    proxy = await startProxy();
    writePlugin(recorderDir, 'probe-hook-recorder', HOOK_RECORDER_SOURCE);
    writePlugin(identityDir, 'mittrcraft-identity', identityPluginSource({ productName: 'MittrCraft' }));
    writePlugin(retryDir, 'probe-retry-hook', retryHookSource());

    const config = (models, policies) => ({
      providers: {
        stub: providerEntry('Stub', `http://127.0.0.1:${stubs.stub.port}/v1`, models),
        other: providerEntry('Other', `http://127.0.0.1:${stubs.other.port}/v1`, ['m1']),
        canary: providerEntry('Canary', `https://${CANARY_HOST}/v1`, ['m1']),
      },
      plugins: [recorderDir, identityDir, retryDir],
      ...ENGINE_SHARE_OFF,
      experimental: { policies },
    });
    writeJsonAtomic(configFile, config(['m1'], policiesFor({ showOtherProviders: false, providerId: 'stub' })));

    stopSampler = startOutboundSampler(() => engine?.pid ?? null, outbound);
    const connect = async (extraEnv = {}) => {
      await startEngine({
        home, configFile, logFile, proxyPort: proxy.port, hookLog, extraEnv,
        onSpawn: (spawned) => { engine = spawned; engines.push(spawned); },
      });
      const client = OpenCode.make({ baseUrl: engine.base, headers: engine.headers });
      collector = collectEvents(client);
      await sleep(500);
      return client;
    };
    const userPolicy = () => probeUserPolicy({
      home, stubs, proxy, identityDir,
      startWith: async (extraEnv) => ({ client: await connect(extraEnv), collector, engine }),
    });

    if (only === 'skills-mcp') {
      result.reserved57133Listening = Boolean(listenerOn(57133));
      result.marker = marker;
      const baseConfig = () => ({
        providers: { stub: providerEntry('Stub', `http://127.0.0.1:${stubs.stub.port}/v1`, ['m1']) },
        ...ENGINE_SHARE_OFF,
        experimental: { policies: policiesFor({ showOtherProviders: false, providerId: 'stub' }) },
      });
      const found = await probeSkillsMcp({
        home, configFile, baseConfig, stub: stubs.stub, marker, stubLog,
        connect, current: () => ({ engine, collector }),
      });
      result.stubLog = found.stubLog;
      for (const name of SKILLS_MCP_SCENARIOS) result.scenarios[name] = found[name];
      result.enginePid = engine.pid;
    } else if (only === 'P7') {
      result.scenarios.P7 = await userPolicy();
    } else if (only === 'shim') {
      platform = await startPlatform();
      shim = await startShim({ platform, logLines: shimLog });
      writeJsonAtomic(configFile, {
        providers: { mittr: providerEntry('Mittr', shim.baseURL, ['m1']) },
        plugins: [recorderDir, identityDir, retryDir],
        ...ENGINE_SHARE_OFF,
        experimental: { policies: policiesFor({ showOtherProviders: false, providerId: 'mittr' }) },
      });
      const client = await connect();
      result.scenarios.shim = await probeShim({ client, collector, platform, shim, shimLog, work: engine.work });
      result.scenarios.shim.ports = { platform: platform.port, shim: shim.port, engine: engine.port };
    } else if (only === 'outbound') {
      result.scenarios.outbound = await probeOutbound({
        OpenCode, home, configFile, hookLog, stubs, proxy,
        onSpawn: (spawned, { control = false } = {}) => { engines.push(spawned); if (!control) engine = spawned; },
      });
    } else {

    let client = await connect();
    result.firstStartReadyMs = engine.readyMs;
    result.modelsAtStart = await modelIds(client, engine.work).catch((error) => `error: ${errorText(error)}`);
    const listedAt = Date.now();
    const listed = await waitFor(async () => (await modelIds(client, engine.work).catch(() => [])).length > 0, 10_000, 100);
    result.modelsFirstListedAfterMs = listed ? Date.now() - listedAt : null;

    const first = await probeP1P3({ client, collector, stub: stubs.stub, work: engine.work, hookLog });
    result.scenarios.P1 = first.P1;
    result.scenarios.P3 = first.P3;
    const refusal = { client, collector, stub: stubs.stub, work: engine.work };
    result.scenarios.P2 = await probeRefusal({ ...refusal, mode: 'refuse', label: 'refusal' });
    result.scenarios.P2b = await probeRefusal({ ...refusal, mode: 'midstream', label: 'mid-stream refusal' });
    result.scenarios.P2c = await probeRefusal({ ...refusal, mode: 'ratelimit-no-retry', label: '429 with x-should-retry false' });
    result.scenarios['P2-control'] = await probeRefusal({ ...refusal, mode: 'ratelimit', label: '429 without the header', expectRetry: true });

    let retryFallback = null;
    if (!result.scenarios.P2.pass || !result.scenarios.P2b.pass) {
      writePlugin(retryDir, 'probe-retry-hook', retryHookSource('stub'));
      await sleep(2000);
      const again = {
        P2: await probeRefusal({ ...refusal, mode: 'refuse', label: 'refusal with retry hook' }),
        P2b: await probeRefusal({ ...refusal, mode: 'midstream', label: 'mid-stream refusal with retry hook' }),
      };
      retryFallback = { pass: again.P2.pass && again.P2b.pass, scenarios: again };
      result.retryHookFallback = retryFallback;
      writePlugin(retryDir, 'probe-retry-hook', retryHookSource());
      await sleep(2000);
    }

    const lockedOther = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'other' });
    const lockedStub = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    result.scenarios.P4 = {
      locked: { other: lockedOther, stub: lockedStub, modelsListed: await modelIds(client, engine.work).catch((error) => `error: ${errorText(error)}`) },
    };

    writeJsonAtomic(configFile, config(['m1', 'm2'], policiesFor({ showOtherProviders: false, providerId: 'stub' })));
    const modelWriteAt = Date.now();
    const m2 = await waitFor(async () => (await modelIds(client, engine.work).catch(() => [])).includes('stub/m2'), 10_000, 250);
    const providersReload = { pass: Boolean(m2), afterMs: m2 ? Date.now() - modelWriteAt : null, models: await modelIds(client, engine.work).catch((error) => `error: ${errorText(error)}`) };

    writeJsonAtomic(configFile, config(['m1', 'm2'], []));
    const policyWriteAt = Date.now();
    result.lockLiftedAt = policyWriteAt;
    let unlocked = null;
    let attempts = 0;
    const policyOk = await waitFor(async () => {
      attempts += 1;
      unlocked = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'other' });
      return unlocked.answered;
    }, 10_000, 500);
    const policiesReload = { pass: Boolean(policyOk), afterMs: policyOk ? Date.now() - policyWriteAt : null, attempts, lastAttempt: unlocked };
    result.scenarios.P5 = { pass: providersReload.pass && policiesReload.pass, providers: providersReload, policies: policiesReload };

    let connectError = null;
    try {
      await client.integration.connect.key({ integrationID: 'stub', key: 'k-123', location: { directory: engine.work } });
    } catch (error) {
      connectError = errorText(error);
    }
    let integrations = null;
    try {
      const list = await client.integration.list({ location: { directory: engine.work } });
      const all = list.data ?? list;
      integrations = {
        count: all.length,
        listed: all.filter((i) => ['stub', 'other', 'canary', 'opencode'].includes(i.id)).map((i) => ({ id: i.id, name: i.name, methods: (i.methods ?? []).map((m) => m.type ?? m.id ?? m) })),
      };
    } catch (error) {
      integrations = `error: ${errorText(error)}`;
    }
    const keyed = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    const authAfterKey = keyed.sessionID ? stubs.stub.forSession(keyed.sessionID).at(-1)?.headers.authorization ?? null : null;
    let credentials = null;
    try { credentials = (await client.credential.list()).map((c) => ({ id: c.id, integrationID: c.integrationID })); } catch (error) { credentials = `error: ${errorText(error)}`; }

    const restartAt = Date.now();
    await collector.stop();
    await stopEngine(engine);
    client = await connect();
    result.restart = { readyMs: engine.readyMs, wallMsIncludingStop: Date.now() - restartAt };
    const keyedAfterRestart = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    const authAfterRestart = keyedAfterRestart.sessionID ? stubs.stub.forSession(keyedAfterRestart.sessionID).at(-1)?.headers.authorization ?? null : null;
    const redact = (value) => (value === 'Bearer k-123' ? value : (value ? `${value.split(' ')[0]} <other>` : null));
    result.scenarios.P6 = {
      pass: connectError === null && keyed.answered && keyedAfterRestart.answered && authAfterKey === 'Bearer k-123' && authAfterRestart === 'Bearer k-123',
      observed: {
        connectError,
        integrations,
        credentials,
        authorizationAfterKey: redact(authAfterKey),
        authorizationAfterRestart: redact(authAfterRestart),
        keyedAnswered: keyed.answered,
        keyedAfterRestartAnswered: keyedAfterRestart.answered,
      },
    };

    const openOther = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'other' });
    const openStub = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    result.scenarios.P4.open = { other: openOther, stub: openStub, modelsListed: await modelIds(client, engine.work).catch((error) => `error: ${errorText(error)}`) };
    result.scenarios.P4.pass = !lockedOther.answered && lockedOther.stubRequests.other === 0 && lockedStub.answered && openOther.answered && openStub.answered;

    const canaryMark = Date.now();
    const canary = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'canary' });
    const canaryAttempts = proxy.attempts.filter((a) => a.at >= canaryMark && a.host === CANARY_HOST);
    result.scenarios['proxy-control'] = {
      pass: canaryAttempts.length > 0,
      observed: { attempts: canaryAttempts.map(({ kind, host, port }) => ({ kind, host, port })), canaryAnswered: canary.answered, error: canary.assistantError ?? canary.events.at(-1) ?? null },
    };

    await collector.stop();
    await stopEngine(engine);
    result.scenarios.P7 = await userPolicy();
    }
    await stopSampler();
    const logText = readLogs(home, logFile);
    const peers = [...outbound.loopbackPeers]
      .map(([pair, firstSeen]) => ({ ports: pair.split('->').map(Number), firstSeen }))
      .filter(({ ports: [local, remote] }) => engines.every((e) => e.port !== local && e.port !== remote) && remote !== stubs.stub.port && remote !== stubs.other.port && remote !== proxy.port && remote !== shim?.port);
    result.outbound = {
      lsofSamples: outbound.samples,
      lsofIntervalMs: 250,
      pidsSeen: outbound.pids.length,
      nonLoopbackRemotes: [...outbound.remotes].sort(),
      otherLoopbackPeers: peers.reduce((byPort, { ports: [, remote], firstSeen }) => {
        const entry = byPort.find((e) => e.port === remote) ?? byPort[byPort.push({ port: remote, connections: 0, whileLocked: 0 }) - 1];
        entry.connections += 1;
        if (firstSeen < result.lockLiftedAt) entry.whileLocked += 1;
        return byPort;
      }, []),
      proxyAttempts: proxy.attempts.length,
      proxyLoopbackAttempts: proxy.attempts.filter((a) => a.loopback).length,
      proxyNonLoopback: [...new Set(proxy.attempts.filter((a) => !a.loopback && a.host !== CANARY_HOST).map((a) => `${a.host}:${a.port}`))].sort(),
      nonLoopbackHostsInLog: nonLoopbackFromLog(logText).filter((host) => host !== CANARY_HOST).sort(),
    };
    result.stubTotals = { stub: stubs.stub.posts().length, other: stubs.other.posts().length };
    result.finishedAt = new Date().toISOString();
  } catch (error) {
    result.fatal = String(error?.stack ?? error);
  } finally {
    await cleanup();
  }

  if (only === 'skills-mcp') {
    result.leftoverStubProcesses = leftovers;
    if (SKILLS_MCP_SCENARIOS.every((name) => result.scenarios[name])) result.stopConditions = skillsMcpStopConditions(result.scenarios);
  }
  for (const name of ['P1', 'P2', 'P2b', 'P3', 'P4', 'P5', 'P6', 'P7']) {
    if (!result.scenarios[name]) continue;
    result.stopConditions[name] = stopConditionFor(name, { pass: result.scenarios[name].pass, fallbackPass: result.retryHookFallback?.pass ?? null });
  }
  for (const name of ['P2c', 'P2-control', 'proxy-control']) {
    if (result.scenarios[name]) result.stopConditions[name] = stopConditionFor(name, { pass: result.scenarios[name].pass });
  }
  result.failures = failuresOf(result, scenarios);
  result.blocked = Object.values(result.stopConditions).some((c) => c.stop);
  if (keep) result.keptHome = home;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const verdicts = Object.fromEntries(scenarios.map((name) => [name, result.scenarios[name] ? (result.scenarios[name].pass ? 'PASS' : 'FAIL') : 'MISSING']));
  console.log(JSON.stringify({ verdicts, blocked: result.blocked, failures: result.failures, outbound: result.outbound }, null, 2));
  console.log(`wrote ${out}`);
  return result.failures.length === 0 ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
