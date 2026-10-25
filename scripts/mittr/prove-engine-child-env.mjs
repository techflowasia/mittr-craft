#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENGINE_OUTBOUND_OFF } from '../../packages/mittr-server/src/engine-outbound.js';
import { ENGINE_CHILD_SECRETS, materializeEngineEnvPlugin } from '../../packages/mittr-server/src/mittr/engine-env-plugin.js';
import { materializeToolsPlugin, toolsPluginSource } from '../../packages/mittr-server/src/mittr/tools/plugin-source.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = path.join(REPO, 'packages/electron/resources/opencode-cli/opencode');
const RESERVED_PORTS = new Set([57123, 57133]);
const TOOLS_ROUTE = '/mittr-tools/v1/call';
const AGENT_TOOL_ROUTE = '/api/openchamber/agent-tool';
const PROBE_TOOL = {
  name: 'acme_probe',
  description: 'Answers a ping.',
  parameters: {},
  definitions: [{ action: 'probe.ping', title: 'Ping', description: 'Answers a ping.' }],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const leakReport = (text, { names, values }) => ({
  leakedNames: names.filter((name) => new RegExp(`(^|\\n)${name}=`).test(text)),
  leakedValues: Object.entries(values).filter(([, value]) => text.includes(value)).map(([name]) => name),
});

export const passed = (report) => report.shell.ran
  && report.shell.leakedNames.length === 0
  && report.shell.leakedValues.length === 0
  && report.shell.engineStatus === '401'
  && report.shell.toolsCallbackStatus === '401'
  && report.terminal.leakedNames.length === 0
  && report.terminal.leakedValues.length === 0
  && report.agentTool.reachedWithToken
  && report.mittrTool.reachedWithToken
  && report.guard.refused === 0;

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => (RESERVED_PORTS.has(port) ? freePort().then(resolve, reject) : resolve(port)));
  });
});

const listenerPids = (port) => (spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').map((line) => Number(line.trim())).filter(Boolean);

const processGroupOf = (pid) => Number((spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim()) || null;

const guardedFetchFor = (engine, guard) => async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (Number(url.port) === engine.port) {
    const pids = listenerPids(engine.port);
    if (pids.length === 0) throw new Error(`nothing listens on ${engine.port} yet`);
    if (!pids.every((pid) => processGroupOf(pid) === engine.pid)) {
      guard.refused += 1;
      throw new Error(`port guard: the listener on ${engine.port} is not the probe engine`);
    }
    guard.checked += 1;
  }
  return fetch(input, init);
};

const readJson = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', () => {
    try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
  });
});

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const frame of frames) res.write(`data: ${frame}\n\n`);
  res.end();
};

const chunk = (model, delta, finish = null) => JSON.stringify({
  id: 'chatcmpl-probe',
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } : {}),
});

const toolResults = (body) => (Array.isArray(body?.messages) ? body.messages : []).filter((message) => message?.role === 'tool').length;
const offered = (body) => (Array.isArray(body?.tools) ? body.tools : []).map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean);

const startStubModel = async (plan) => {
  const port = await freePort();
  const seen = { requests: 0, offered: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }));
      return;
    }
    seen.requests += 1;
    seen.offered = offered(body);
    const model = body?.model ?? 'm1';
    const call = plan[toolResults(body)];
    if (call && seen.offered.includes(call.name)) {
      sse(res, [
        chunk(model, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${seen.requests}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }),
        chunk(model, {}, 'tool_calls'),
        '[DONE]',
      ]);
      return;
    }
    sse(res, [chunk(model, { role: 'assistant', content: 'done' }), chunk(model, {}, 'stop'), '[DONE]']);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
};

const startCallbacks = async ({ toolsToken, agentToolToken }) => {
  const port = await freePort();
  const calls = { tools: [], agentTool: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    const authorization = req.headers.authorization ?? '';
    const answer = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.url === TOOLS_ROUTE) {
      const ok = authorization === `Bearer ${toolsToken}`;
      calls.tools.push({ ok, fromShell: body?.tool === undefined });
      return ok ? answer(200, { schemaVersion: 1, ok: true, action: 'probe.ping', data: {} }) : answer(401, { error: 'Unauthorized' });
    }
    if (req.url === AGENT_TOOL_ROUTE) {
      const ok = authorization === `Bearer ${agentToolToken}`;
      calls.agentTool.push({ ok });
      return ok ? answer(200, { schemaVersion: 1, ok: true, action: body?.input?.action ?? 'unknown', data: { projects: [] } }) : answer(401, { error: 'Unauthorized' });
    }
    return answer(404, {});
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, calls, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
};

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopEngine = async (engine) => {
  if (!engine) return;
  try { process.kill(-engine.pid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && groupAlive(engine.pid)) await sleep(100);
  if (groupAlive(engine.pid)) {
    try { process.kill(-engine.pid, 'SIGKILL'); } catch {}
  }
};

const waitFor = async (predicate, timeoutMs, stepMs = 200) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
};

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const run = async ({ withEnvPlugin }) => {
  if (!fs.existsSync(ENGINE)) throw new Error(`no bundled engine at ${ENGINE}`);
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/p4.'));
  const dataDir = path.join(home, 'data');
  const work = path.join(home, 'work');
  const out = path.join(home, 'out');
  for (const dir of [dataDir, work, out, path.join(home, 'tmp'), path.join(home, '.config'), path.join(home, '.local/share'), path.join(home, '.local/state'), path.join(home, '.cache')]) fs.mkdirSync(dir, { recursive: true });
  const secrets = Object.fromEntries(ENGINE_CHILD_SECRETS.map((name) => [name, `probe${randomBytes(18).toString('hex')}`]));
  secrets.OPENCODE_PASSWORD = secrets.OPENCODE_SERVER_PASSWORD;
  const callbacks = await startCallbacks({ toolsToken: secrets.MITTRCRAFT_TOOLS_TOKEN, agentToolToken: secrets.OPENCHAMBER_AGENT_TOOL_TOKEN });
  const files = { shellEnv: path.join(out, 'shell.env'), engineStatus: path.join(out, 'engine.status'), toolsStatus: path.join(out, 'tools.status'), terminalEnv: path.join(out, 'terminal.env') };
  const enginePort = await freePort();
  const toolsUrl = `http://127.0.0.1:${callbacks.port}${TOOLS_ROUTE}`;
  const curl = (target, headerArg) => `/usr/bin/curl -s -o /dev/null -w '%{http_code}' ${headerArg} '${target}'`;
  const command = [
    `env > '${files.shellEnv}'`,
    `${curl(`http://127.0.0.1:${enginePort}/api/session?limit=1`, '-u "opencode:$OPENCODE_SERVER_PASSWORD"')} > '${files.engineStatus}'`,
    `${curl(toolsUrl, '-X POST -H "content-type: application/json" -H "authorization: Bearer $MITTRCRAFT_TOOLS_TOKEN" -d "{}"')} > '${files.toolsStatus}'`,
  ].join('; ');
  const model = await startStubModel([
    { name: 'shell', arguments: { command, description: 'Write the environment to a file' } },
    { name: 'openchamber', arguments: { action: 'projects.list', parameters: {} } },
    { name: PROBE_TOOL.name, arguments: { action: 'probe.ping', parameters: {} } },
  ]);

  const { createAgentToolRuntime } = await import(pathToFileURL(path.join(REPO, 'packages/web/server/lib/agent-tool/runtime.js')).href);
  const agentTool = createAgentToolRuntime({ crypto, fsPromises: fs.promises, path, dataDir, getActivePort: () => callbacks.port, getActiveHost: () => '127.0.0.1', executeAction: async () => ({}) });
  const agentToolDir = await agentTool.materializePlugin({ includeControl: true, includeWeb: false });
  const toolsDir = await materializeToolsPlugin({ dataDir, source: toolsPluginSource({ tools: [PROBE_TOOL], codeMode: false }) });
  const plugins = [...(withEnvPlugin ? [await materializeEngineEnvPlugin({ dataDir })] : []), agentToolDir, toolsDir];
  const configFile = path.join(home, 'opencode.managed.json');
  fs.writeFileSync(configFile, `${JSON.stringify({
    providers: { stub: { name: 'stub', package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.port}/v1` }, models: { m1: { modelID: 'm1', name: 'm1', capabilities: { tools: true } } } } },
    plugins,
    share: 'disabled',
  }, null, 2)}\n`, { mode: 0o600 });

  const proxy = 'http://127.0.0.1:9';
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: path.join(home, 'tmp'),
    LANG: 'en_US.UTF-8',
    USER: process.env.USER ?? 'user',
    SHELL: '/bin/sh',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_CONFIG: configFile,
    ...ENGINE_OUTBOUND_OFF,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    MITTRCRAFT_TOOLS_URL: toolsUrl,
    OPENCHAMBER_AGENT_TOOL_URL: `http://127.0.0.1:${callbacks.port}${AGENT_TOOL_ROUTE}`,
    PROBE_VISIBLE_MARKER: 'visible',
    ...secrets,
  };
  const reservedHolders = Object.fromEntries([...RESERVED_PORTS].map((port) => [port, listenerPids(port).length > 0 ? 'held by another process' : 'free']));
  const log = fs.openSync(path.join(home, 'engine.log'), 'a');
  const child = spawn(ENGINE, ['serve', '--hostname', '127.0.0.1', '--port', String(enginePort)], { cwd: work, env, detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  const engine = { pid: child.pid, port: enginePort, base: `http://127.0.0.1:${enginePort}` };
  const guard = { checked: 0, refused: 0 };
  const guarded = guardedFetchFor(engine, guard);
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${secrets.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`, 'x-opencode-directory': encodeURIComponent(work) };
  const report = { withEnvPlugin, reservedPorts: reservedHolders, shell: { ran: false }, terminal: {}, agentTool: {}, mittrTool: {}, guard, errors: [] };
  try {
    const ready = await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`engine exited early (${child.exitCode})`);
      try {
        return (await guarded(`${engine.base}/api/session?limit=1`, { headers })).ok;
      } catch (error) {
        if (String(error.message).startsWith('port guard')) throw error;
        return false;
      }
    }, 60_000, 250);
    if (!ready) throw new Error('engine not ready');
    const { OpenCode } = await import('@opencode/client');
    const client = OpenCode.make({ baseUrl: engine.base, headers, fetch: guarded });
    await waitFor(async () => (await client.model.list({ location: { directory: work } }).catch(() => ({ data: [] }))).data.some((m) => m.providerID === 'stub'), 20_000);
    const session = await client.session.create({ title: 'child env probe', model: { id: 'm1', providerID: 'stub' }, location: { directory: work } });
    const answered = new Set();
    const prompt = client.session.prompt({ sessionID: session.id, text: 'run the probe' }).catch((error) => report.errors.push(`prompt: ${error?.message ?? error}`));
    await waitFor(async () => {
      const pending = await client.permission.list({ sessionID: session.id }).catch(() => []);
      for (const request of (Array.isArray(pending) ? pending : pending?.data ?? [])) {
        if (answered.has(request.id)) continue;
        answered.add(request.id);
        await client.permission.reply({ sessionID: session.id, requestID: request.id, decision: 'once' }).catch(() => {});
      }
      return callbacks.calls.tools.some((call) => call.ok) && readText(files.toolsStatus) !== null;
    }, 60_000, 250);
    await Promise.race([prompt, sleep(2000)]);

    const shellEnv = readText(files.shellEnv);
    report.shell = {
      ran: shellEnv !== null && /(^|\n)PROBE_VISIBLE_MARKER=visible(\n|$)/.test(shellEnv),
      ...leakReport(shellEnv ?? '', { names: ENGINE_CHILD_SECRETS, values: secrets }),
      engineStatus: (readText(files.engineStatus) ?? '').trim(),
      toolsCallbackStatus: (readText(files.toolsStatus) ?? '').trim(),
      permissionsAnswered: answered.size,
      toolsOffered: model.seen.offered.filter((name) => ['shell', 'openchamber', PROBE_TOOL.name].includes(name)),
    };

    try {
      await client.pty.create({ location: { directory: work }, command: '/bin/sh', args: ['-c', `env > '${files.terminalEnv}'`], cwd: work });
      const terminalEnv = await waitFor(() => readText(files.terminalEnv), 10_000);
      report.terminal = { ran: terminalEnv !== null && terminalEnv.includes('PROBE_VISIBLE_MARKER=visible'), ...leakReport(terminalEnv ?? '', { names: ENGINE_CHILD_SECRETS, values: secrets }) };
    } catch (error) {
      report.terminal = { ran: false, error: String(error?.message ?? error).slice(0, 200), leakedNames: [], leakedValues: [] };
    }
    report.agentTool = { calls: callbacks.calls.agentTool.length, reachedWithToken: callbacks.calls.agentTool.some((call) => call.ok) };
    report.mittrTool = { calls: callbacks.calls.tools.filter((call) => !call.fromShell).length, reachedWithToken: callbacks.calls.tools.some((call) => call.ok && !call.fromShell) };
    report.engineAnswersAfterPluginsLoaded = (await guarded(`${engine.base}/api/session?limit=1`, { headers })).status;
  } catch (error) {
    report.errors.push(String(error?.message ?? error).slice(0, 300));
  } finally {
    await stopEngine(engine);
    await model.close();
    await callbacks.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  report.pass = passed(report);
  return report;
};

const main = async () => {
  const args = process.argv.slice(2);
  const at = args.indexOf('--json');
  const report = await run({ withEnvPlugin: !args.includes('--without-env-plugin') });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (at !== -1 && args[at + 1]) fs.writeFileSync(args[at + 1], text);
  process.stdout.write(text);
  process.exitCode = report.pass ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
