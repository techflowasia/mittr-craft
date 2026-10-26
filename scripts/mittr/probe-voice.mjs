#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER_TRANSCRIPT = 'probe heard you';
export const QUOTA_BODY = {
  error: {
    type: 'insufficient_quota',
    code: 'llm_quota_exhausted',
    message: 'Voice input is out of quota until Tue 27 Oct, 00:00',
    resets_at: '2026-10-26T17:00:00Z',
  },
};
export const NOT_CONFIGURED_BODY = { error: { code: 'not_configured', message: 'Your Mittr admin has not set up speech models yet' } };
export const READ_ALOUD_TEXT = 'สวัสดี hello';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESERVED_PORTS = new Set([57123, 57133]);
const SPEECH_PREFIX = '/mittr-speech/v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const pcm16Tone = ({ rate, seconds, frequency = 440, amplitude = 8000 }) => {
  const samples = Math.round(rate * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * frequency * i) / rate)), i * 2);
  return pcm;
};

export const wavOf = (pcm16, rate, channels = 1, bits = 16) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
};

export const wavHeaderOf = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= buffer.length) {
      return { rate: buffer.readUInt32LE(offset + 12), channels: buffer.readUInt16LE(offset + 10), bits: buffer.readUInt16LE(offset + 22) };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
};

const boundaryOf = (contentType) => {
  const match = /^multipart\/form-data\s*;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ''));
  return match ? match[1] ?? match[2] : null;
};

export const multipartPartsOf = (body, contentType) => {
  const boundary = boundaryOf(contentType);
  if (!boundary || !Buffer.isBuffer(body)) return [];
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const afterDelimiter = start + delimiter.length;
    if (body.toString('ascii', afterDelimiter, afterDelimiter + 2) === '--') break;
    const next = body.indexOf(delimiter, afterDelimiter);
    if (next === -1) break;
    const raw = body.subarray(afterDelimiter + 2, next - 2);
    const split = raw.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = raw.subarray(0, split).toString('utf8');
      const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
      const type = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim();
      if (name !== undefined) {
        const part = { name };
        if (filename !== undefined) part.filename = filename;
        if (type) part.type = type;
        part.data = raw.subarray(split + 4);
        parts.push(part);
      }
    }
    start = next;
  }
  return parts;
};

export const multipartFieldsOf = (body, contentType) => multipartPartsOf(body, contentType).map(({ data: _data, ...field }) => field);

export const maxGapOf = (schedule) => {
  const ordered = [...(Array.isArray(schedule) ? schedule : [])].sort((a, b) => a.startsAt - b.startsAt);
  let gap = 0;
  for (let i = 1; i < ordered.length; i += 1) gap = Math.max(gap, ordered[i].startsAt - ordered[i - 1].endsAt);
  return gap;
};

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

const guardedFetchFor = (ports, guard) => async (input, init) => {
  const url = new URL(String(input));
  if (ports.includes(Number(url.port))) {
    const pids = listenerPids(Number(url.port));
    if (pids.length === 0 || !pids.every((pid) => pid === process.pid)) {
      guard.refused += 1;
      throw new Error(`port guard: the listener on ${url.port} is not this probe`);
    }
    guard.checked += 1;
  }
  return fetch(input, init);
};

const nonLoopbackFromLsof = (text) => {
  const found = [];
  for (const line of String(text).split('\n')) {
    const match = /->(\[?[^\]\s]+?\]?):(\d+)\s/.exec(`${line} `);
    if (!match) continue;
    const host = match[1].replace(/^\[|\]$/g, '');
    if (host === '127.0.0.1' || host === '::1' || host === 'localhost') continue;
    found.push(`${host}:${match[2]}`);
  }
  return found;
};

const startSampler = (sink) => {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const out = spawnSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-i'], { encoding: 'utf8' }).stdout ?? '';
      sink.samples += 1;
      for (const remote of nonLoopbackFromLsof(out)) sink.remotes.add(remote);
      await sleep(250);
    }
  })();
  return async () => { stopped = true; await loop; };
};

const startSpeechStub = async ({ markers }) => {
  const port = await freePort();
  const stub = { port, mode: 'ok', requests: [], audio: wavOf(pcm16Tone({ rate: 24000, seconds: 0.5, frequency: 330 }), 24000) };
  const keyKind = (authorization) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(String(authorization ?? ''))?.[1];
    if (!bearer) return null;
    const digest = sha256(bearer);
    return Object.entries(markers).find(([, marker]) => sha256(marker) === digest)?.[0] ?? 'other';
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] ?? '';
      const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
      const record = {
        at: Date.now(),
        mode: stub.mode,
        method: req.method,
        path: req.url,
        headerNames: Object.keys(req.headers).sort(),
        authorizationSha256: bearer ? sha256(bearer) : null,
        keyKind: keyKind(req.headers.authorization),
        contentType: String(contentType).split(';')[0].trim() || null,
        shouldRetryHeaderSent: null,
      };
      if (/^multipart\/form-data/i.test(contentType)) {
        const parts = multipartPartsOf(body, contentType);
        record.fields = parts.map(({ data: _data, ...field }) => field);
        const value = (name) => parts.find((part) => part.name === name && part.filename === undefined)?.data.toString('utf8') ?? null;
        record.values = { model: value('model'), response_format: value('response_format') };
        record.languageSent = parts.some((part) => part.name === 'language');
        const file = parts.find((part) => part.filename !== undefined);
        record.file = file ? { name: file.filename, mime: file.type ?? null, bytes: file.data.length, wav: wavHeaderOf(file.data) } : null;
      } else if (/json/i.test(contentType)) {
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch { json = null; }
        const isObject = json !== null && Object(json) === json && !Array.isArray(json);
        record.bodyKeys = isObject ? Object.keys(json).sort() : null;
        record.values = isObject ? { model: json.model ?? null, voice: json.voice ?? null, response_format: json.response_format ?? null, speed: json.speed ?? null } : null;
        const input = isObject && json.input !== undefined && json.input !== null ? String(json.input) : null;
        record.input = input === null ? null : { length: input.length, equalsPosted: input === READ_ALOUD_TEXT, sha256: sha256(input) };
      }
      stub.requests.push(record);
      const refuse = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
        res.end(JSON.stringify(payload));
      };
      if (stub.mode === 'quota') return refuse(429, QUOTA_BODY);
      if (stub.mode === 'not_configured') return refuse(503, NOT_CONFIGURED_BODY);
      if (req.method === 'POST' && req.url === `${SPEECH_PREFIX}/audio/transcriptions`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: MARKER_TRANSCRIPT }));
        return;
      }
      if (req.method === 'POST' && req.url === `${SPEECH_PREFIX}/audio/speech`) {
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': stub.audio.length });
        res.end(stub.audio);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found', message: 'probe stub has no such route' } }));
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  stub.close = () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  stub.since = (mark) => stub.requests.filter((r) => r.at >= mark);
  return stub;
};

const DICTATION_OPTIONS = (stubPort) => ({
  provider: 'openai-compatible',
  openaiCompatible: { baseUrl: `http://127.0.0.1:${stubPort}${SPEECH_PREFIX}`, model: 'mittr' },
});

const dictate = async ({ wsUrl, stubPort, dictationId, seconds = 3, timeoutMs = 15_000 }) => {
  const events = [];
  const socket = new WebSocket(wsUrl);
  const waitFor = (predicate, ms) => new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > ms) return resolve(null);
      setTimeout(tick, 20);
    };
    tick();
  });
  socket.addEventListener('message', (event) => {
    let message = null;
    try { message = JSON.parse(String(event.data)); } catch { message = null; }
    if (message) events.push({ at: Date.now(), ...message });
  });
  const opened = await new Promise((resolve) => {
    socket.addEventListener('open', () => resolve(true), { once: true });
    socket.addEventListener('error', () => resolve(false), { once: true });
  });
  if (!opened) return { opened, events: [] };
  await waitFor((e) => e.type === 'ready', 5000);
  socket.send(JSON.stringify({ type: 'start', dictationId, format: 'audio/pcm;rate=16000;bits=16', options: DICTATION_OPTIONS(stubPort) }));
  await waitFor((e) => e.type === 'ack' || e.type === 'error', 5000);
  for (let seq = 0; seq < seconds; seq += 1) {
    socket.send(JSON.stringify({ type: 'chunk', dictationId, seq, audio: pcm16Tone({ rate: 16000, seconds: 1, frequency: 300 + seq * 120 }).toString('base64') }));
  }
  socket.send(JSON.stringify({ type: 'finish', dictationId, finalSeq: seconds - 1 }));
  const end = await waitFor((e) => e.type === 'final' || e.type === 'error', timeoutMs);
  socket.close();
  return { opened, end, events };
};

const summarizeEvents = (events) => events.map((e) => {
  const out = { type: e.type };
  if (e.type === 'ack') out.ackSeq = e.ackSeq;
  if (e.type === 'final') out.textIsMarker = e.text === MARKER_TRANSCRIPT;
  if (e.type === 'partial') out.textIsMarker = e.text === MARKER_TRANSCRIPT;
  if (e.type === 'finish_accepted') out.timeoutMs = e.timeoutMs;
  if (e.type === 'error') Object.assign(out, { error: e.error, retryable: e.retryable, reasonCode: e.reasonCode ?? null });
  return out;
});

const brief = (record) => {
  if (!record) return null;
  const summary = { method: record.method, path: record.path, keyKind: record.keyKind, contentType: record.contentType, headerNames: record.headerNames };
  if (record.fields) Object.assign(summary, { fields: record.fields, values: record.values, languageSent: record.languageSent, file: record.file });
  if (record.bodyKeys) Object.assign(summary, { bodyKeys: record.bodyKeys, values: record.values, input: record.input && { length: record.input.length, equalsPosted: record.input.equalsPosted } });
  return summary;
};

const probeDictation = async ({ wsUrl, stub }) => {
  stub.mode = 'ok';
  let mark = Date.now();
  const ok = await dictate({ wsUrl, stubPort: stub.port, dictationId: 'probe-ok' });
  const okRequests = stub.since(mark);
  const request = okRequests.find((r) => r.path === `${SPEECH_PREFIX}/audio/transcriptions`) ?? null;
  const finalEvent = ok.events.find((e) => e.type === 'final') ?? null;
  const refusal = async (mode, dictationId) => {
    stub.mode = mode;
    const startedAt = Date.now();
    const run = await dictate({ wsUrl, stubPort: stub.port, dictationId });
    await sleep(1500);
    const attempts = stub.since(startedAt);
    stub.mode = 'ok';
    const error = run.events.find((e) => e.type === 'error') ?? null;
    const expected = mode === 'quota' ? QUOTA_BODY.error.message : NOT_CONFIGURED_BODY.error.message;
    return {
      httpAttempts: attempts.length,
      attemptPaths: attempts.map((r) => r.path),
      clientError: error ? { error: error.error, retryable: error.retryable, reasonCode: error.reasonCode ?? null } : null,
      ourTextKept: Boolean(error && String(error.error).includes(expected)),
      errorTextExactlyOurs: Boolean(error && error.error === expected),
      events: summarizeEvents(run.events),
    };
  };
  const quota = await refusal('quota', 'probe-quota');
  const notConfigured = await refusal('not_configured', 'probe-not-configured');
  mark = Date.now();
  const pass = Boolean(request)
    && request.keyKind === 'stt'
    && request.values?.model === 'mittr'
    && request.file?.mime === 'audio/wav'
    && request.file?.wav?.rate === 16000 && request.file?.wav?.channels === 1 && request.file?.wav?.bits === 16
    && finalEvent?.text === MARKER_TRANSCRIPT;
  return {
    pass,
    optionsSent: { provider: 'openai-compatible', openaiCompatible: { baseUrl: `http://127.0.0.1:<stub>${SPEECH_PREFIX}`, model: 'mittr' }, apiKeyInOptions: false },
    audio: { seconds: 3, chunkSeconds: 1, rate: 16000, format: 'audio/pcm;rate=16000;bits=16', kind: 'sine tone made in code' },
    stubRequests: okRequests.length,
    request: brief(request),
    events: summarizeEvents(ok.events),
    finalIsMarker: finalEvent?.text === MARKER_TRANSCRIPT,
    quota,
    notConfigured,
  };
};

const probeReadAloud = async ({ base, stub, guardedFetch }) => {
  const speak = async () => guardedFetch(`${base}/api/tts/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: READ_ALOUD_TEXT, baseURL: `http://127.0.0.1:${stub.port}${SPEECH_PREFIX}`, model: 'mittr', voice: 'mittr' }),
  });
  stub.mode = 'ok';
  let mark = Date.now();
  const res = await speak();
  const bytes = Buffer.from(await res.arrayBuffer());
  const okRequests = stub.since(mark);
  const request = okRequests.find((r) => r.path === `${SPEECH_PREFIX}/audio/speech`) ?? null;
  const refusal = async (mode) => {
    stub.mode = mode;
    const startedAt = Date.now();
    const answer = await speak();
    const text = await answer.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    await sleep(500);
    const attempts = stub.since(startedAt);
    stub.mode = 'ok';
    const expected = mode === 'quota' ? QUOTA_BODY.error.message : NOT_CONFIGURED_BODY.error.message;
    return {
      routeStatus: answer.status,
      routeContentType: answer.headers.get('content-type'),
      routeJson: json,
      ourTextKept: text.includes(expected),
      httpAttempts: attempts.length,
    };
  };
  const quota = await refusal('quota');
  const notConfigured = await refusal('not_configured');
  mark = Date.now();
  const bytesEqual = bytes.equals(stub.audio);
  const pass = Boolean(request)
    && request.keyKind === 'openaiCompatible'
    && res.status === 200
    && String(res.headers.get('content-type')).startsWith('audio/wav')
    && bytesEqual;
  return {
    pass,
    posted: { textLength: READ_ALOUD_TEXT.length, baseURL: `http://127.0.0.1:<stub>${SPEECH_PREFIX}`, model: 'mittr', voice: 'mittr', apiKeyInBody: false },
    stubRequests: okRequests.length,
    request: brief(request),
    route: { status: res.status, contentType: res.headers.get('content-type'), bytes: bytes.length, bytesEqualStub: bytesEqual, stubWav: wavHeaderOf(stub.audio) },
    quota,
    notConfigured,
  };
};

export const voiceStopConditions = ({ S1 = {}, S2 = {} }) => {
  const none = { action: 'none', stop: false };
  const conditions = {};
  conditions.S1 = S1.pass ? none : { action: "stop Task 3's dictation half and report; fallback: a Mittr provider in packages/web/server/lib/dictation/service.js (+1, owner decision 1)", stop: true };
  const quota = S1.quota ?? {};
  const decision5 = [];
  if (!quota.ourTextKept) decision5.push('the client error loses our quota text');
  if (quota.clientError?.retryable !== false) decision5.push('the client error is retryable, and the failed overlay offers Retry');
  conditions['S1-quota'] = decision5.length === 0 ? none : { action: `owner decision 5 (accept the Retry, or +2 for ComposerDictation.tsx and stream-manager.js): ${decision5.join('; ')}`, stop: false };
  conditions['S1-attempts'] = (quota.httpAttempts ?? 0) > 1 || (S1.notConfigured?.httpAttempts ?? 0) > 1
    ? { action: 'owner note: more than one HTTP attempt despite x-should-retry: false', stop: false }
    : none;
  conditions.S2 = S2.pass ? none : { action: "stop Task 3's read-aloud half and report; fallback: a Mittr branch in packages/web/server/lib/tts/routes.js (+1)", stop: true };
  return conditions;
};

const main = async () => {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf('--json');
  if (jsonIndex === -1 || !args[jsonIndex + 1]) {
    console.error('usage: node scripts/mittr/probe-voice.mjs --json <out> [--keep]');
    return 2;
  }
  const out = path.resolve(args[jsonIndex + 1]);
  const keep = args.includes('--keep');
  const { assertIsolatedEnv } = await import('./isolated-env.mjs');
  assertIsolatedEnv(process.env);
  for (const name of ['OPENAI_API_KEY', 'OPENCHAMBER_ENTERPRISE_MODE', 'OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS', 'OPENCHAMBER_RUNTIME']) delete process.env[name];

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4v.')));
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  const markers = { stt: `mc_speech_probe_stt_${randomBytes(16).toString('hex')}`, openaiCompatible: `mc_speech_probe_oc_${randomBytes(16).toString('hex')}` };
  fs.writeFileSync(path.join(dataDir, 'voice-keys.json'), JSON.stringify(markers, null, 2), { mode: 0o600 });

  const outbound = { samples: 0, remotes: new Set() };
  const guard = { checked: 0, refused: 0 };
  const closers = [];
  let stopSampler = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const close of closers.reverse()) await close().catch(() => {});
    await stopSampler?.().catch(() => {});
    if (!keep) fs.rmSync(home, { recursive: true, force: true });
  };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const result = { startedAt: new Date().toISOString(), node: process.version, scenarios: {}, stopConditions: {}, outbound: null };
  try {
    const webRequire = createRequire(path.join(REPO, 'packages/web/package.json'));
    const express = webRequire('express');
    result.openaiSdk = JSON.parse(fs.readFileSync(path.join(REPO, 'packages/web/node_modules/openai/package.json'), 'utf8')).version;
    const lib = (file) => pathToFileURL(path.join(REPO, 'packages/web/server/lib', file)).href;
    const { registerTtsRoutes } = await import(lib('tts/routes.js'));
    const { createDictationRuntime } = await import(lib('dictation/runtime.js'));
    const { describeVoiceKeys } = await import(lib('tts/voice-keys.js'));
    result.voiceKeysSeenByUpstream = describeVoiceKeys();
    result.markerSha256 = { stt: sha256(markers.stt).slice(0, 12), openaiCompatible: sha256(markers.openaiCompatible).slice(0, 12) };

    stopSampler = startSampler(outbound);
    const stub = await startSpeechStub({ markers });
    closers.push(stub.close);

    const app = express();
    app.use(express.json({ limit: '50mb' }));
    registerTtsRoutes(app, { sayTTSCapability: Promise.resolve({ available: false, voices: [] }) });
    const server = http.createServer(app);
    const dictation = createDictationRuntime({
      app,
      server,
      express,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: (socket, status, message) => { socket.end(`HTTP/1.1 ${status} ${message}\r\n\r\n`); },
      modelsDir: path.join(home, 'models'),
    });
    const appPort = await freePort();
    await new Promise((resolve) => server.listen(appPort, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => { dictation.stop(); server.closeAllConnections?.(); server.close(resolve); }));
    const guardedFetch = guardedFetchFor([appPort, stub.port], guard);
    result.ports = { app: appPort, stub: stub.port };
    result.reserved57133Listening = listenerPids(57133).length > 0;
    const appListener = listenerPids(appPort);
    if (appListener.length === 0 || !appListener.every((pid) => pid === process.pid)) throw new Error('port guard: the app port is not this probe');
    guard.checked += 1;

    result.scenarios.S1 = await probeDictation({ wsUrl: `ws://127.0.0.1:${appPort}/api/dictation/ws`, stub });
    result.scenarios.S2 = await probeReadAloud({ base: `http://127.0.0.1:${appPort}`, stub, guardedFetch });
    result.stopConditions = voiceStopConditions(result.scenarios);
    result.stubTotals = { requests: stub.requests.length, paths: [...new Set(stub.requests.map((r) => r.path))].sort() };
  } catch (error) {
    result.fatal = String(error?.stack ?? error);
  } finally {
    await cleanup();
  }
  result.outbound = { lsofSamples: outbound.samples, lsofIntervalMs: 250, nonLoopbackRemotes: [...outbound.remotes].sort() };
  result.portGuard = guard;
  result.finishedAt = new Date().toISOString();
  if (keep) result.keptHome = home;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const verdicts = Object.fromEntries(['S1', 'S2'].map((name) => [name, result.scenarios[name] ? (result.scenarios[name].pass ? 'PASS' : 'FAIL') : 'MISSING']));
  console.log(JSON.stringify({ verdicts, stopConditions: result.stopConditions, outbound: result.outbound, fatal: result.fatal ?? null }, null, 2));
  console.log(`wrote ${out}`);
  const ok = !result.fatal && Object.values(verdicts).every((v) => v === 'PASS') && result.outbound.nonLoopbackRemotes.length === 0;
  return ok ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
