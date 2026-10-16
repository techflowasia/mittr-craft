#!/usr/bin/env node
/**
 * Proves what the bundled OpenCode 2.x engine does with a Mittr-style
 * provider, the provider lock policies, an identity plugin and a quota
 * refusal, by running the real engine against two loopback stub providers.
 *
 * Everything runs under a fresh temporary HOME with all four XDG bases,
 * TMPDIR and OPENCODE_CONFIG inside it, on a random port with a random
 * password. The stubs listen on 127.0.0.1 only; no real provider or key is
 * used. The engine and the stubs are stopped and the temp HOME is deleted
 * on exit.
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

export const identityPluginSource = ({ productName = 'MittrCraft' } = {}) => `const PRODUCT = ${JSON.stringify(productName)}
const IDENTITY = \`You are \${PRODUCT}. When asked who you are or which product this is, answer \${PRODUCT}. Never call yourself OpenCode or OpenChamber.\`

const introduce = (o) => {
  if (!Array.isArray(o.system)) return
  const first = o.system[0]
  if (first && typeof first.text === 'string') {
    first.text = first.text
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
    await ctx.session.hook('compaction', introduce)
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

const RESERVED_PORTS = new Set([57123, 57133]);
const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/electron/resources/opencode-cli/opencode');
const RESETS_AT = '2026-10-20T00:00:00+07:00';
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
      const model = body?.model ?? 'm1';
      if (stub.mode === 'refuse') {
        const refusal = quotaRefusal({ kind: 'weekly', resetsAt: RESETS_AT });
        res.writeHead(refusal.status, { 'content-type': 'application/json', ...refusal.headers });
        res.end(JSON.stringify(refusal.body));
        record.answeredAt = Date.now();
        return;
      }
      if (stub.mode === 'midstream') {
        const refusal = quotaRefusal({ kind: 'weekly', resetsAt: RESETS_AT });
        sse(res, [chunk(model, { role: 'assistant', content: 'partial ' }), JSON.stringify(refusal.body), '[DONE]']);
        record.answeredAt = Date.now();
        return;
      }
      if (body?.stream) {
        sse(res, [
          chunk(model, { role: 'assistant', content: stub.reply }),
          chunk(model, {}, 'stop', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }),
          '[DONE]',
        ]);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-probe', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: stub.reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }));
      }
      record.answeredAt = Date.now();
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  stub.close = () => new Promise((resolve) => server.close(resolve));
  stub.since = (mark) => stub.requests.filter((r) => r.at >= mark && r.method === 'POST');
  return stub;
};

const providerEntry = (name, port, models) => ({
  name,
  package: 'aisdk:@ai-sdk/openai-compatible',
  settings: { baseURL: `http://127.0.0.1:${port}/v1` },
  models: Object.fromEntries(models.map((id) => [id, { modelID: id, name: id, capabilities: { tools: true } }])),
});

const writeJsonAtomic = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
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
      await sleep(500);
    }
  };
  const done = loop();
  return async () => { stopped = true; await done; };
};

const startEngine = async ({ home, configFile, logFile }) => {
  const port = await freePort();
  const password = randomBytes(24).toString('hex');
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
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
  };
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const log = fs.openSync(logFile, 'a');
  const startedAt = Date.now();
  const child = spawn(ENGINE, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--log-level', 'debug'], {
    cwd: work, env, detached: true, stdio: ['ignore', log, log],
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'x-opencode-directory': encodeURIComponent(work),
  };
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`engine exited early (${child.exitCode}); see ${logFile}`);
    try {
      const res = await fetch(`${base}/api/session?limit=1`, { headers });
      if (res.ok) break;
      lastError = new Error(`health ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`engine not ready: ${lastError?.message}`);
  return { child, exited, port, headers, base, work, readyMs: Date.now() - startedAt };
};

const stopEngine = async (engine) => {
  if (!engine || engine.child.exitCode !== null || engine.child.signalCode !== null) return;
  try { process.kill(-engine.child.pid, 'SIGTERM'); } catch { /* already gone */ }
  const result = await Promise.race([engine.exited, sleep(5000).then(() => null)]);
  if (result === null) {
    try { process.kill(-engine.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await engine.exited;
  }
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

const summarizeEvents = (events) => events.map((e) => ({
  type: e.type,
  status: e.data.status?.type,
  attempt: e.data.attempt,
  error: e.data.error ? { type: e.data.error.type, status: e.data.error.status, message: String(e.data.error.message ?? '').slice(0, 200) } : undefined,
}));

const probeP1P3 = async ({ client, collector, stub, work }) => {
  stub.mode = 'ok';
  const { sessionID, createError } = await newSession(client, work, 'stub', 'm1');
  if (!sessionID) return { P1: { pass: false, observed: { createError } }, P3: { pass: false, observed: { createError } } };
  const run = await promptAndSettle({ client, collector, sessionID, text: 'Who are you? Answer in one word.' });
  const requests = stub.since(run.mark);
  const main = requests.find((r) => r.headers['x-opencode-session-id'] === sessionID) ?? requests[0];
  const headers = main?.headers ?? {};
  const P1 = {
    pass: Boolean(main) && headers['x-opencode-session-id'] === sessionID && Boolean(headers['x-session-id']),
    observed: {
      sessionID,
      stubRequests: requests.length,
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
  const P3 = {
    pass: system.includes('You are MittrCraft') && !system.includes('You are opencode') && !system.includes('You are OpenCode'),
    observed: {
      systemMessages: (main?.body?.messages ?? []).filter((m) => m.role === 'system').length,
      systemContentIsPartList: Array.isArray(main?.body?.messages?.[0]?.content),
      hasMittrCraft: system.includes('You are MittrCraft'),
      hasYouAreopencode: system.includes('You are opencode'),
      hasYouAreOpenCode: system.includes('You are OpenCode'),
      systemHead: system.slice(0, 300),
      identityLinePresent: system.includes('answer MittrCraft'),
      dotOpencodeMentions: (system.match(/\.opencode\//g) ?? []).length,
      openCodeNameMentions: (system.match(/(?<![.\w/-])opencode\b/gi) ?? []).length,
      openCodeNameLines: system.split('\n').filter((line) => /(?<![.\w/-])opencode\b/i.test(line)).slice(0, 8).map((line) => line.slice(0, 200)),
      requestKeys: Object.keys(main?.body ?? {}).sort(),
      stream: main?.body?.stream ?? null,
    },
  };
  return { P1, P3, sessionID };
};

const probeRefusal = async ({ client, collector, stub, work, mode, label }) => {
  stub.mode = mode;
  const { sessionID, createError } = await newSession(client, work, 'stub', 'm1');
  if (!sessionID) return { pass: false, observed: { createError } };
  const run = await promptAndSettle({ client, collector, sessionID, text: `probe ${label}`, timeoutMs: 20_000 });
  const windowEnd = run.mark + 20_000;
  await sleep(Math.max(0, windowEnd - Date.now()));
  const requests = stub.since(run.mark);
  const firstAnsweredAt = requests[0]?.answeredAt ?? null;
  const events = sessionEvents(collector.events, sessionID, run.mark);
  const retrySeen = events.some((e) => (e.type === 'session.status' && e.data.status?.type === 'retry') || e.type === 'session.retry.scheduled');
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
    events: summarizeEvents(events),
    assistantError: error ? { type: error.type, status: error.status ?? null, message: String(error.message ?? '').slice(0, 300), responseBody: error.response?.body ?? null } : null,
    assistantFinish: assistant?.finish ?? null,
    messageError,
    promptError: run.promptError,
  };
  let pass = requests.length === 1 && idleAfterMs !== null && idleAfterMs <= 2000 && !retrySeen;
  if (mode === 'refuse') pass = pass && error?.status === 402 && String(error?.response?.body ?? '').includes('llm_quota_exhausted');
  stub.mode = 'ok';
  return { pass, observed };
};

const tryPrompt = async ({ client, collector, stubs, work, providerID }) => {
  for (const s of Object.values(stubs)) s.mode = 'ok';
  const marks = Object.fromEntries(Object.entries(stubs).map(([k]) => [k, Date.now()]));
  const { sessionID, createError } = await newSession(client, work, providerID, 'm1');
  if (!sessionID) {
    return { providerID, answered: false, createError, stubRequests: Object.fromEntries(Object.entries(stubs).map(([k, s]) => [k, s.since(marks[k]).length])) };
  }
  const run = await promptAndSettle({ client, collector, sessionID, text: `probe via ${providerID}`, timeoutMs: 20_000 });
  await sleep(500);
  let assistant = null;
  let messageError = null;
  try { assistant = await lastAssistant(client, sessionID); } catch (error) { messageError = errorText(error); }
  const stubRequests = Object.fromEntries(Object.entries(stubs).map(([k, s]) => [k, s.since(marks[k]).length]));
  const answered = stubRequests[providerID] > 0 && Boolean(assistant) && !assistant.error;
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

const main = async () => {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf('--json');
  if (jsonIndex === -1 || !args[jsonIndex + 1]) {
    console.error('usage: node scripts/mittr/probe-engine-v2.mjs --json <out> [--keep]');
    process.exit(2);
  }
  const out = path.resolve(args[jsonIndex + 1]);
  const keep = args.includes('--keep');
  if (!fs.existsSync(ENGINE)) throw new Error(`engine binary missing: ${ENGINE} (run prepare:opencode-cli)`);

  const { OpenCode } = await import('@opencode/client');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'p2.'));
  const configFile = path.join(home, 'opencode.managed.json');
  const logFile = path.join(home, 'engine.out.log');
  const pluginDir = path.join(home, 'engine-plugins', 'mittrcraft-identity');
  const outbound = { samples: 0, pids: [], remotes: new Set(), loopbackPeers: new Map() };
  const enginePorts = [];
  let engine = null;
  let collector = null;
  const stubs = {};
  const cleanup = async () => {
    await collector?.stop().catch(() => {});
    await stopEngine(engine);
    for (const s of Object.values(stubs)) await s.close?.();
    if (!keep) fs.rmSync(home, { recursive: true, force: true });
  };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const result = {
    engine: ENGINE,
    engineVersion: null,
    startedAt: new Date().toISOString(),
    scenarios: {},
    outbound: null,
  };
  try {
    const versionEnv = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache') };
    result.engineVersion = spawnSync(ENGINE, ['--version'], { encoding: 'utf8', env: versionEnv }).stdout.trim();

    stubs.stub = await startStub('stub');
    stubs.other = await startStub('other');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: 'mittrcraft-identity', version: '0.0.0', private: true, type: 'module', exports: { '.': './index.js' } }, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(pluginDir, 'index.js'), identityPluginSource({ productName: 'MittrCraft' }), { mode: 0o600 });

    const config = (models, policies) => ({
      providers: { stub: providerEntry('Stub', stubs.stub.port, models), other: providerEntry('Other', stubs.other.port, ['m1']) },
      plugins: [pluginDir],
      experimental: { policies },
    });
    writeJsonAtomic(configFile, config(['m1'], policiesFor({ showOtherProviders: false, providerId: 'stub' })));

    let pid = null;
    const stopSampler = startOutboundSampler(() => pid, outbound);
    const connect = async () => {
      engine = await startEngine({ home, configFile, logFile });
      pid = engine.child.pid;
      enginePorts.push(engine.port);
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

    const first = await probeP1P3({ client, collector, stub: stubs.stub, work: engine.work });
    result.scenarios.P1 = first.P1;
    result.scenarios.P3 = first.P3;
    result.scenarios.P2 = await probeRefusal({ client, collector, stub: stubs.stub, work: engine.work, mode: 'refuse', label: 'refusal' });
    result.scenarios.P2b = await probeRefusal({ client, collector, stub: stubs.stub, work: engine.work, mode: 'midstream', label: 'mid-stream refusal' });

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
    const policyOk = await waitFor(async () => {
      unlocked = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'other' });
      return unlocked.answered;
    }, 10_000, 500);
    const policiesReload = { pass: Boolean(policyOk), afterMs: policyOk ? Date.now() - policyWriteAt : null, lastAttempt: unlocked };
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
      integrations = (list.data ?? list).map((i) => ({ id: i.id, name: i.name, methods: (i.methods ?? []).map((m) => m.type ?? m.id ?? m) }));
    } catch (error) {
      integrations = `error: ${errorText(error)}`;
    }
    const keyed = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    const authAfterKey = stubs.stub.requests.at(-1)?.headers.authorization ?? null;
    let credentials = null;
    try { credentials = (await client.credential.list()).map((c) => ({ id: c.id, integrationID: c.integrationID, type: c.type ?? c.method })); } catch (error) { credentials = `error: ${errorText(error)}`; }

    await collector.stop();
    await stopEngine(engine);
    const restartAt = Date.now();
    client = await connect();
    const restartReadyMs = engine.readyMs;
    const keyedAfterRestart = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    const authAfterRestart = stubs.stub.requests.at(-1)?.headers.authorization ?? null;
    result.scenarios.P6 = {
      pass: connectError === null && authAfterKey === 'Bearer k-123' && authAfterRestart === 'Bearer k-123',
      observed: {
        connectError,
        integrations,
        credentials,
        authorizationAfterKey: authAfterKey === 'Bearer k-123' ? 'Bearer k-123' : (authAfterKey ? `${authAfterKey.split(' ')[0]} <other>` : null),
        authorizationAfterRestart: authAfterRestart === 'Bearer k-123' ? 'Bearer k-123' : (authAfterRestart ? `${authAfterRestart.split(' ')[0]} <other>` : null),
        keyedAnswered: keyed.answered,
        keyedAfterRestartAnswered: keyedAfterRestart.answered,
      },
    };
    result.restart = { readyMs: restartReadyMs, wallMs: Date.now() - restartAt };

    const openOther = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'other' });
    const openStub = await tryPrompt({ client, collector, stubs, work: engine.work, providerID: 'stub' });
    result.scenarios.P4.open = { other: openOther, stub: openStub, modelsListed: await modelIds(client, engine.work).catch((error) => `error: ${errorText(error)}`) };
    result.scenarios.P4.pass = !lockedOther.answered && lockedOther.stubRequests.other === 0 && lockedStub.answered && openOther.answered && openStub.answered;

    await collector.stop();
    await stopEngine(engine);
    await stopSampler();
    const logs = [logFile, ...fs.readdirSync(path.join(home, '.local/share/opencode/log'), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(home, '.local/share/opencode/log', d.name))]
      .filter((f) => fs.existsSync(f));
    const logText = logs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    result.outbound = {
      lsofSamples: outbound.samples,
      pidsSeen: outbound.pids.length,
      nonLoopbackRemotes: [...outbound.remotes].sort(),
      otherLoopbackPeers: [...outbound.loopbackPeers]
        .map(([pair, firstSeen]) => ({ ports: pair.split('->').map(Number), firstSeen }))
        .filter(({ ports: [local, remote] }) => !enginePorts.includes(local) && !enginePorts.includes(remote) && remote !== stubs.stub.port && remote !== stubs.other.port)
        .reduce((byPort, { ports: [, remote], firstSeen }) => {
          const entry = byPort.find((e) => e.port === remote) ?? byPort[byPort.push({ port: remote, connections: 0, whileLocked: 0 }) - 1];
          entry.connections += 1;
          if (firstSeen < result.lockLiftedAt) entry.whileLocked += 1;
          return byPort;
        }, []),
      nonLoopbackHostsInLog: nonLoopbackFromLog(logText).sort(),
      logBytes: logText.length,
    };
    result.stubTotals = { stub: stubs.stub.requests.length, other: stubs.other.requests.length };
    result.finishedAt = new Date().toISOString();
  } catch (error) {
    result.fatal = String(error?.stack ?? error);
  } finally {
    if (keep) result.keptHome = home;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    await cleanup();
  }
  const verdicts = Object.fromEntries(Object.entries(result.scenarios).map(([k, v]) => [k, v.pass ? 'PASS' : 'FAIL']));
  console.log(JSON.stringify({ verdicts, outbound: result.outbound, fatal: result.fatal ?? null }, null, 2));
  console.log(`wrote ${out}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
