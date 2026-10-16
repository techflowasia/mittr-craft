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
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const policiesFor = ({ showOtherProviders, providerId }) =>
  showOtherProviders
    ? []
    : [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: providerId, effect: 'allow' },
      ];

export const quotaRefusal = ({ kind, resetsAt }) => ({
  status: 402,
  headers: { 'x-should-retry': 'false' },
  body: {
    error: {
      type: 'insufficient_quota',
      code: 'llm_quota_exhausted',
      message: 'Weekly model quota used up',
      kind,
      resets_at: new Date(resetsAt).toISOString(),
    },
  },
});

const IDENTITY_PLUGIN_ID = 'mittrcraft.identity';
export const HARNESS_SENTENCE = 'You are an AI agent running in OpenCode, a coding agent harness.';
export const harnessReplacement = (productName) => `You are ${productName}, an AI coding agent.`;

export const identityPluginSource = ({ productName = 'MittrCraft', retryProviderID = null } = {}) => {
  const retryHook = retryProviderID
    ? `
    await ctx.session.hook('retry', (e) => {
      if (String(e.error?.response?.body ?? '').includes('llm_quota_exhausted')) e.decision = { retry: false }
    }, { providerID: ${JSON.stringify(retryProviderID)} })`
    : '';
  return `const PRODUCT = ${JSON.stringify(productName)}
const IDENTITY = \`You are \${PRODUCT}. When asked who you are or which product this is, answer \${PRODUCT}. Never call yourself OpenCode or OpenChamber.\`

const introduce = (o) => {
  if (!Array.isArray(o.system)) return
  const first = o.system[0]
  if (first && typeof first.text === 'string') {
    first.text = first.text
      .replace(${JSON.stringify(HARNESS_SENTENCE)}, ${JSON.stringify(harnessReplacement(productName))})
      .replace('You are opencode, an interactive CLI tool', \`You are \${PRODUCT}, an interactive tool\`)
      .replace('You are OpenCode, a coding agent', \`You are \${PRODUCT}, a coding agent\`)
  }
  o.system.push({ type: 'text', text: IDENTITY })
}

export default {
  id: ${JSON.stringify(IDENTITY_PLUGIN_ID)},
  setup: async (ctx) => {
    await ctx.session.hook('context', introduce)
    await ctx.session.hook('generate', introduce)
    await ctx.session.hook('compaction', introduce)${retryHook}
  },
}
`;
};

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
const SCENARIOS = ['P1', 'P2', 'P2b', 'P2c', 'P2-control', 'P3', 'P4', 'P5', 'P6', 'proxy-control'];
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
    const refusal = quotaRefusal({ kind: 'weekly', resetsAt: RESETS_AT });
    res.writeHead(refusal.status, { 'content-type': 'application/json', ...refusal.headers });
    res.end(JSON.stringify(refusal.body));
    return;
  }
  if (stub.mode === 'midstream') {
    const refusal = quotaRefusal({ kind: 'weekly', resetsAt: RESETS_AT });
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
  const stub = { name, port, requests: [], mode: 'ok', reply: `hello from ${name}` };
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

const startEngine = async ({ home, configFile, logFile, proxyPort, hookLog, onSpawn }) => {
  const port = await freePort();
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
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
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
  const identityLine = 'You are MittrCraft. When asked who you are or which product this is, answer MittrCraft. Never call yourself OpenCode or OpenChamber.';
  const hooks = readHookLog(hookLog).slice(hooksBefore);
  const hookCounts = Object.fromEntries(['context', 'generate', 'compaction'].map((name) => [name, hooks.filter((h) => h.hook === name).length]));
  const replacement = harnessReplacement('MittrCraft');
  const harnessRewritten = system.includes(replacement) && !system.includes(HARNESS_SENTENCE);
  const P3 = {
    pass: hookCounts.context > 0
      && harnessRewritten
      && system.includes(identityLine)
      && !system.includes('You are opencode')
      && !system.includes('You are OpenCode'),
    observed: {
      hookCounts,
      openingSeenByHook: hooks[0]?.opening ?? null,
      hookSawOriginalHarnessSentence: hooks.some((h) => h.opening.startsWith(HARNESS_SENTENCE.slice(0, 60))),
      harnessSentenceSent: system.includes(HARNESS_SENTENCE),
      harnessReplacementSent: system.includes(replacement),
      harnessRewritten,
      identityLinePresent: system.includes(identityLine),
      hasYouAreopencode: system.includes('You are opencode'),
      hasYouAreOpenCode: system.includes('You are OpenCode'),
      openCodeMentions: openCodeMentions(system),
      openCodeMentionsWithoutIdentityLine: openCodeMentions(system.replace(identityLine, '')),
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

const tryPrompt = async ({ client, collector, stubs, work, providerID }) => {
  for (const s of Object.values(stubs)) s.mode = 'ok';
  const mark = Date.now();
  const { sessionID, createError } = await newSession(client, work, providerID, 'm1');
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

export const failuresOf = (result) => {
  const failures = [];
  if (result.fatal) failures.push('fatal');
  for (const name of SCENARIOS) {
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

const main = async () => {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf('--json');
  if (jsonIndex === -1 || !args[jsonIndex + 1]) {
    console.error('usage: node scripts/mittr/probe-engine-v2.mjs --json <out> [--keep]');
    return 2;
  }
  const out = path.resolve(args[jsonIndex + 1]);
  const keep = args.includes('--keep');
  if (!fs.existsSync(ENGINE)) throw new Error(`engine binary missing: ${ENGINE} (run prepare:opencode-cli)`);

  const { OpenCode } = await import('@opencode/client');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p2.'));
  const configFile = path.join(home, 'opencode.managed.json');
  const logFile = path.join(home, 'engine.out.log');
  const hookLog = path.join(home, 'hooks.jsonl');
  const identityDir = path.join(home, 'engine-plugins', 'mittrcraft-identity');
  const recorderDir = path.join(home, 'engine-plugins', 'probe-hook-recorder');
  const outbound = { samples: 0, pids: [], remotes: new Set(), loopbackPeers: new Map() };
  const engines = [];
  let engine = null;
  let collector = null;
  let proxy = null;
  let stopSampler = null;
  const stubs = {};
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await collector?.stop().catch(() => {});
    for (const started of engines) await stopEngine(started).catch(() => {});
    await stopSampler?.().catch(() => {});
    for (const s of Object.values(stubs)) await s.close?.();
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

    const config = (models, policies) => ({
      providers: {
        stub: providerEntry('Stub', `http://127.0.0.1:${stubs.stub.port}/v1`, models),
        other: providerEntry('Other', `http://127.0.0.1:${stubs.other.port}/v1`, ['m1']),
        canary: providerEntry('Canary', `https://${CANARY_HOST}/v1`, ['m1']),
      },
      plugins: [recorderDir, identityDir],
      experimental: { policies },
    });
    writeJsonAtomic(configFile, config(['m1'], policiesFor({ showOtherProviders: false, providerId: 'stub' })));

    stopSampler = startOutboundSampler(() => engine?.pid ?? null, outbound);
    const connect = async () => {
      await startEngine({
        home, configFile, logFile, proxyPort: proxy.port, hookLog,
        onSpawn: (spawned) => { engine = spawned; engines.push(spawned); },
      });
      const client = OpenCode.make({ baseUrl: engine.base, headers: engine.headers });
      collector = collectEvents(client);
      await sleep(500);
      return client;
    };

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
      writePlugin(identityDir, 'mittrcraft-identity', identityPluginSource({ productName: 'MittrCraft', retryProviderID: 'stub' }));
      await sleep(2000);
      const again = {
        P2: await probeRefusal({ ...refusal, mode: 'refuse', label: 'refusal with retry hook' }),
        P2b: await probeRefusal({ ...refusal, mode: 'midstream', label: 'mid-stream refusal with retry hook' }),
      };
      retryFallback = { pass: again.P2.pass && again.P2b.pass, scenarios: again };
      result.retryHookFallback = retryFallback;
      writePlugin(identityDir, 'mittrcraft-identity', identityPluginSource({ productName: 'MittrCraft' }));
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
    await stopSampler();
    const logText = readLogs(home, logFile);
    const peers = [...outbound.loopbackPeers]
      .map(([pair, firstSeen]) => ({ ports: pair.split('->').map(Number), firstSeen }))
      .filter(({ ports: [local, remote] }) => engines.every((e) => e.port !== local && e.port !== remote) && remote !== stubs.stub.port && remote !== stubs.other.port && remote !== proxy.port);
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

  for (const name of ['P1', 'P2', 'P2b', 'P3', 'P4', 'P5', 'P6']) {
    if (!result.scenarios[name]) continue;
    result.stopConditions[name] = stopConditionFor(name, { pass: result.scenarios[name].pass, fallbackPass: result.retryHookFallback?.pass ?? null });
  }
  for (const name of ['P2c', 'P2-control', 'proxy-control']) {
    if (result.scenarios[name]) result.stopConditions[name] = stopConditionFor(name, { pass: result.scenarios[name].pass });
  }
  result.failures = failuresOf(result);
  result.blocked = Object.values(result.stopConditions).some((c) => c.stop);
  if (keep) result.keptHome = home;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const verdicts = Object.fromEntries(SCENARIOS.map((name) => [name, result.scenarios[name] ? (result.scenarios[name].pass ? 'PASS' : 'FAIL') : 'MISSING']));
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
