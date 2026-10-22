#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GATE_BUNDLE_ID = 'dev.mittrcraft.desktop.dev.gate';
const RESERVED_PORTS = new Set([57123, 57133]);
const VAD_FILES = ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'bundle.min.js'];
const SPEECH_END_WAIT_MS = 10_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const fakeAudioInputsOnly = (devices) => {
  const audioInputs = (Array.isArray(devices) ? devices : []).filter((device) => device?.kind === 'audioinput').map((device) => String(device.label ?? ''));
  return { ok: audioInputs.length > 0 && audioInputs.every((label) => label.startsWith('Fake')), audioInputs };
};

export const launchArgsFor = ({ fixture, devtoolsPort }) => {
  if (!path.isAbsolute(String(fixture)) || /[,\s]/.test(String(fixture))) throw new Error('the fixture path must be absolute, with no comma or space');
  if (!Number.isInteger(devtoolsPort) || devtoolsPort <= 0) throw new Error('a DevTools port is required');
  return [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${fixture}`,
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--use-mock-keychain',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${devtoolsPort}`,
  ];
};

export const tccLinesFor = (text, bundleId) => String(text ?? '').split('\n').filter((line) => line.includes(bundleId));

export const tccSummaryOf = (lines) => {
  const services = [...new Set(lines.flatMap((line) => line.match(/kTCCService[A-Za-z]+/g) ?? []))].sort();
  const preflight = lines.filter((line) => /preflight=(yes|no)/.test(line));
  return {
    lines: lines.length,
    services,
    microphone: services.includes('kTCCServiceMicrophone'),
    preflightOnly: preflight.length > 0 && preflight.every((line) => line.includes('preflight=yes')),
  };
};

export const cspOf = ({ headers, html }) => {
  const header = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-security-policy')?.[1] ?? null;
  const meta = [...String(html ?? '').matchAll(/<meta\b[^>]*http-equiv=["']content-security-policy["'][^>]*>/gi)]
    .map((match) => /content=(["'])([\s\S]*?)\1/i.exec(match[0])?.[2] ?? null)
    .filter((value) => value !== null);
  return { header, meta };
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

const descendants = (pid) => {
  const all = [pid];
  for (let i = 0; i < all.length; i += 1) {
    const out = spawnSync('pgrep', ['-P', String(all[i])], { encoding: 'utf8' }).stdout ?? '';
    for (const child of out.split('\n').map((s) => Number(s.trim())).filter(Boolean)) all.push(child);
  }
  return all;
};

const processesNaming = (text) => (spawnSync('pgrep', ['-f', text], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').map((line) => Number(line.trim())).filter((pid) => pid && pid !== process.pid);

const processesNamed = (name) => (spawnSync('pgrep', ['-x', name], { encoding: 'utf8' }).stdout ?? '')
  .split('\n').map((line) => Number(line.trim())).filter(Boolean);

const plistValue = (plist, key) => {
  const run = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
};

const tccLog = (minutes) => spawnSync('log', ['show', '--style', 'syslog', '--last', `${minutes}m`, '--predicate', 'subsystem == "com.apple.TCC"'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout ?? '';

const statOf = (target) => {
  try {
    return { exists: true, mtimeMs: fs.statSync(target).mtimeMs };
  } catch {
    return { exists: false, mtimeMs: null };
  }
};

const REAL_DIRS = (realHome) => [
  '.config/mittrcraft', '.config/mittrcraft-dev', '.config/mittrcraft-gate', '.config/openchamber', '.config/opencode',
  '.local/share/opencode', '.local/state/opencode', '.cache/opencode',
  'Library/Application Support/MittrCraft', 'Library/Application Support/MittrCraft Dev', 'Library/Application Support/MittrCraft Gate',
  'Library/Application Support/OpenChamber', 'Library/Logs/MittrCraft Gate',
].map((relative) => path.join(realHome, relative));

const launchServicesPlist = (realHome) => path.join(realHome, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');

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

const createCdp = async (wsUrl) => {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) {
      events.push({ at: Date.now(), method: message.method, params: message.params });
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DevTools socket did not open within 10 s')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools socket failed')); }, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, timeoutMs = 30_000) => {
    const answer = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }),
      sleep(timeoutMs).then(() => ({ timedOut: true })),
    ]);
    if (answer.timedOut) return { error: `timed out after ${timeoutMs} ms` };
    if (answer.result?.exceptionDetails) return { error: String(answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text).slice(0, 400) };
    return { value: answer.result?.result?.value };
  };
  return { send, evaluate, events, close: () => socket.close() };
};

const PAGE_PRECHECK = `(async () => {
  const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const out = { location: location.href, crossOriginIsolated: self.crossOriginIsolated === true, sharedArrayBuffer: typeof SharedArrayBuffer };
  window.__probeCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__probeCsp.push({ directive: e.violatedDirective, effective: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile }));
  out.liveMeta = [...document.querySelectorAll('meta[http-equiv]')].filter((m) => /content-security-policy/i.test(m.httpEquiv)).map((m) => m.content);
  const doc = await fetch(location.origin + '/', { cache: 'no-store' });
  out.document = { status: doc.status, headers: Object.fromEntries(doc.headers.entries()), html: await doc.text() };
  try { out.micPermission = (await navigator.permissions.query({ name: 'microphone' })).state; } catch (error) { out.micPermission = 'error: ' + error.message; }
  out.devices = (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label }));
  out.vadFiles = {};
  for (const file of ${JSON.stringify(VAD_FILES)}) {
    try {
      const r = await fetch('/vad/' + file, { cache: 'no-store' });
      const b = await r.arrayBuffer();
      out.vadFiles[file] = { status: r.status, contentType: r.headers.get('content-type'), bytes: b.byteLength, sha256: hex(await crypto.subtle.digest('SHA-256', b)) };
    } catch (error) { out.vadFiles[file] = { error: String(error) }; }
  }
  return out;
})()`;

const PAGE_GET_USER_MEDIA = `(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } });
  window.__probeStream = stream;
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  return { label: track.label, readyState: track.readyState, tracks: stream.getTracks().length, sampleRate: settings.sampleRate ?? null, channelCount: settings.channelCount ?? null, echoCancellation: settings.echoCancellation ?? null, autoGainControl: settings.autoGainControl ?? null, noiseSuppression: settings.noiseSuppression ?? null };
})()`;

const PAGE_ORT = `(async () => {
  const out = {};
  try {
    const module = await WebAssembly.compileStreaming(fetch('/vad/ort-wasm-simd-threaded.wasm'));
    out.wasmCompiled = true;
    out.wasmImports = WebAssembly.Module.imports(module).length;
  } catch (error) { out.wasmCompiled = false; out.wasmError = String(error).slice(0, 300); }
  try {
    const glue = await import('/vad/ort-wasm-simd-threaded.mjs');
    out.mjsImported = true;
    out.mjsExports = Object.keys(glue);
    try {
      const instance = await glue.default({ locateFile: (file) => '/vad/' + file, numThreads: 1 });
      out.instantiated = true;
      out.instanceHasMalloc = typeof instance._malloc === 'function' || typeof instance._OrtInit === 'function';
    } catch (error) { out.instantiated = false; out.instantiateError = String(error).slice(0, 300); }
  } catch (error) { out.mjsImported = false; out.mjsError = String(error).slice(0, 300); }
  try {
    const bundle = await import('/vad/bundle.min.js');
    out.bundleAsModule = { imported: true, exports: Object.keys(bundle), vadBinding: Boolean(bundle.vad || bundle.default?.MicVAD) };
  } catch (error) { out.bundleAsModule = { imported: false, error: String(error).slice(0, 300) }; }
  return out;
})()`;

const PAGE_VAD_START = (fromPage) => `(async () => {
  const out = { bundleLoadedFrom: ${JSON.stringify(fromPage ? '/vad/bundle.min.js as a classic script' : 'the cached bundle.min.js evaluated through DevTools')} };
  if (${fromPage ? 'true' : 'false'}) await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vad/bundle.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('the classic script did not load'));
    document.head.appendChild(script);
  });
  out.vadGlobal = typeof window.vad;
  out.micVadType = typeof window.vad?.MicVAD?.new;
  window.__probeSpeech = [];
  const started = performance.now();
  const micVad = await window.vad.MicVAD.new({
    model: 'v5',
    baseAssetPath: '/vad/',
    onnxWASMBasePath: '/vad/',
    getStream: async () => window.__probeStream,
    pauseStream: async () => {},
    resumeStream: async () => window.__probeStream,
    onSpeechStart: () => window.__probeSpeech.push({ type: 'start', atMs: performance.now() - started }),
    onSpeechRealStart: () => window.__probeSpeech.push({ type: 'real-start', atMs: performance.now() - started }),
    onVADMisfire: () => window.__probeSpeech.push({ type: 'misfire', atMs: performance.now() - started }),
    onSpeechEnd: (audio) => window.__probeSpeech.push({ type: 'end', atMs: performance.now() - started, samples: audio.length }),
  });
  window.__probeVad = micVad;
  await micVad.start();
  out.loadedMs = performance.now() - started;
  out.listening = micVad.listening === true;
  out.errored = micVad.errored ?? null;
  return out;
})()`;

const PAGE_VAD_EVENTS = '(() => ({ speech: window.__probeSpeech ?? [], csp: window.__probeCsp ?? [] }))()';

const PAGE_TEARDOWN = `(async () => {
  const out = {};
  try { await window.__probeVad?.destroy(); out.destroyed = Boolean(window.__probeVad); } catch (error) { out.destroyError = String(error).slice(0, 200); }
  const stream = window.__probeStream;
  if (stream) for (const track of stream.getTracks()) track.stop();
  out.readyStates = stream ? stream.getTracks().map((track) => track.readyState) : [];
  out.csp = window.__probeCsp ?? [];
  return out;
})()`;

const consoleOf = (events) => events
  .filter((event) => event.method === 'Runtime.consoleAPICalled' || event.method === 'Log.entryAdded' || event.method === 'Runtime.exceptionThrown')
  .map((event) => {
    if (event.method === 'Log.entryAdded') return { kind: 'log', level: event.params.entry.level, source: event.params.entry.source, text: String(event.params.entry.text).slice(0, 300) };
    if (event.method === 'Runtime.exceptionThrown') return { kind: 'exception', text: String(event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text).slice(0, 300) };
    return { kind: 'console', level: event.params.type, text: (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 300) };
  });

export const windowStopConditions = ({ S5 }) => {
  const none = { action: 'none', stop: false };
  const conditions = {};
  if (S5?.tcc?.newLines > 0 || S5?.dialogs?.newProcesses > 0) conditions.tcc = { action: 'stop every launch and report: a TCC log entry or a dialog appeared', stop: true };
  else conditions.tcc = none;
  if (S5?.flagsTook === false) conditions.fakeMedia = { action: "the gate's Part A VAD rows are NOT RUN; unit tests and Part B cover them", stop: false };
  else conditions.fakeMedia = none;
  if (S5?.getUserMedia?.refused) conditions.getUserMedia = { action: 'stop Tasks 6, 8 and 9 Talk half: getUserMedia refused in the main window (fix in packages/electron/main.mjs, 0)', stop: true };
  else conditions.getUserMedia = none;
  if (S5?.cspBlocksVad) conditions.csp = { action: 'stop Tasks 6, 8 and 9 Talk half: the CSP blocks the ONNX wasm or the VAD worklet (fix where the CSP is set)', stop: true };
  else conditions.csp = none;
  conditions.microphoneText = S5?.infoPlist?.NSMicrophoneUsageDescription ? none : { action: 'Task 6 adds NSMicrophoneUsageDescription through brand/electron-builder.*.json mac.extendInfo', stop: false };
  return conditions;
};

const main = async () => {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? null : args[index + 1] ?? null;
  };
  const out = valueOf('--json');
  const app = valueOf('--app');
  const fixtureSource = valueOf('--fixture');
  if (!out || !app || !fixtureSource) {
    console.error('usage: node scripts/mittr/probe-voice-window.mjs --json <out> --app <MittrCraft Gate.app> --fixture <speech.wav> [--vad-bundle <bundle.min.js>] [--keep]');
    return 2;
  }
  const keep = args.includes('--keep');
  const vadBundle = valueOf('--vad-bundle');
  const appPath = path.resolve(app);
  const infoPlistPath = path.join(appPath, 'Contents/Info.plist');
  const bundleId = plistValue(infoPlistPath, 'CFBundleIdentifier');
  if (bundleId !== GATE_BUNDLE_ID) throw new Error(`refusing to launch ${bundleId ?? 'an unknown app'}: only the gate build (${GATE_BUNDLE_ID}) is launched`);
  const executableName = plistValue(infoPlistPath, 'CFBundleExecutable');
  const executable = path.join(appPath, 'Contents/MacOS', executableName);
  const realHome = os.userInfo().homedir;

  const home = fs.realpathSync(fs.mkdtempSync('/tmp/p4t.'));
  for (const relative of ['.config', '.local/share', '.local/state', '.cache', 'tmp', 'userData']) fs.mkdirSync(path.join(home, relative), { recursive: true });
  const fixture = path.join(home, 'fixture.wav');
  fs.copyFileSync(fixtureSource, fixture);
  const dataDir = path.join(home, '.config', 'mittrcraft-gate');
  fs.mkdirSync(dataDir, { recursive: true });
  const desktopPort = await freePort();
  fs.writeFileSync(path.join(dataDir, 'settings.json'), `${JSON.stringify({ desktopLocalPort: desktopPort }, null, 2)}\n`);

  const result = {
    startedAt: new Date().toISOString(),
    app: { path: path.relative(REPO, appPath), bundleId, executable: executableName, version: plistValue(infoPlistPath, 'CFBundleShortVersionString') },
    infoPlist: { NSMicrophoneUsageDescription: plistValue(infoPlistPath, 'NSMicrophoneUsageDescription') },
    fixture: { sha256: sha256File(fixture), bytes: fs.statSync(fixture).size },
    scenarios: {},
  };
  const children = [];
  let appChild = null;
  let cdp = null;
  let stopSampler = null;
  const outbound = { samples: 0, remotes: new Set(), pids: new Set() };
  const guard = { checked: 0, refused: 0 };
  const cleanup = async () => {
    cdp?.close();
    if (appChild && !appChild.killed) {
      const command = (spawnSync('ps', ['-o', 'command=', '-p', String(appChild.pid)], { encoding: 'utf8' }).stdout ?? '').trim();
      if (command.startsWith(executable)) {
        try { process.kill(-appChild.pid, 'SIGTERM'); } catch {}
        for (let i = 0; i < 50 && processesNaming(home).length > 0; i += 1) await sleep(200);
      }
    }
    for (const pid of processesNaming(home)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await sleep(500);
    for (const pid of processesNaming(home)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    await stopSampler?.();
  };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    result.reserved57133 = { listeningBefore: listenerPids(57133).length > 0 };
    const realBefore = Object.fromEntries(REAL_DIRS(realHome).map((dir) => [dir.replace(realHome, '~'), statOf(dir)]));
    const lsBefore = fs.existsSync(launchServicesPlist(realHome)) ? sha256File(launchServicesPlist(realHome)) : null;
    const dialogsBefore = new Set([...processesNamed('SecurityAgent'), ...processesNamed('UserNotificationCenter')]);
    const tccBefore = tccLinesFor(tccLog(10), GATE_BUNDLE_ID);
    result.tccBefore = { lines: tccBefore.length, window: '10m' };

    const platform = spawn(process.execPath, [path.join(REPO, 'scripts/mittr/stub-platform.mjs'), '--port', '0', '--mcp-log', path.join(home, 'stub-mcp.jsonl')], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(platform);
    const platformPort = await new Promise((resolve, reject) => {
      let text = '';
      platform.stdout.on('data', (chunk) => {
        text += chunk;
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(text);
        if (match) resolve(Number(match[1]));
      });
      platform.once('exit', () => reject(new Error('the stub platform exited')));
    });

    const devtoolsPort = await freePort();
    if (listenerPids(devtoolsPort).length > 0 || listenerPids(desktopPort).length > 0) throw new Error('a chosen port already has a listener');
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: path.join(home, 'tmp'),
      USER: os.userInfo().username,
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'),
      XDG_STATE_HOME: path.join(home, '.local/state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      OPENCHAMBER_DESKTOP_USER_DATA_DIR: path.join(home, 'userData'),
      MITTRCRAFT_BROKER_URL: `http://127.0.0.1:${platformPort}`,
    };
    const launchArgs = launchArgsFor({ fixture, devtoolsPort });
    result.launch = { args: launchArgs.map((arg) => arg.split(home).join('<home>')), envNames: Object.keys(env).sort(), desktopPort, devtoolsPort, platformPort };
    const launchedAt = Date.now();
    appChild = spawn(executable, launchArgs, { cwd: home, env, detached: true, stdio: ['ignore', fs.openSync(path.join(home, 'app.log'), 'a'), fs.openSync(path.join(home, 'app.log'), 'a')] });
    let sampling = true;
    stopSampler = async () => { sampling = false; await sleep(300); };
    (async () => {
      while (sampling) {
        const pids = appChild?.pid ? descendants(appChild.pid) : [];
        if (pids.length > 0) {
          for (const pid of pids) outbound.pids.add(pid);
          const text = spawnSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-i'], { encoding: 'utf8' }).stdout ?? '';
          outbound.samples += 1;
          for (const remote of nonLoopbackFromLsof(text)) outbound.remotes.add(remote);
        }
        await sleep(300);
      }
    })();

    const guardedJson = async (url) => {
      const port = Number(new URL(url).port);
      const owners = listenerPids(port);
      const tree = new Set(descendants(appChild.pid));
      if (owners.length === 0 || !owners.every((pid) => tree.has(pid))) {
        guard.refused += 1;
        throw new Error(`port guard: the listener on ${port} is not the launched app`);
      }
      guard.checked += 1;
      return (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
    };
    let target = null;
    const deadline = Date.now() + 60_000;
    while (!target && Date.now() < deadline) {
      await sleep(500);
      if (listenerPids(devtoolsPort).length === 0) continue;
      const targets = await guardedJson(`http://127.0.0.1:${devtoolsPort}/json/list`).catch(() => []);
      target = targets.find((t) => t.type === 'page' && /^openchamber-ui:\/\/app/.test(t.url)) ?? null;
      result.targetsSeen = targets.map((t) => ({ type: t.type, url: String(t.url).replace(/\?.*$/, '').slice(0, 80) }));
    }
    if (!target) throw new Error('no main window target on the DevTools port within 60 s');
    result.mainWindow = { url: target.url.replace(/\?.*$/, ''), readyAfterMs: Date.now() - launchedAt };
    guard.checked += 1;
    cdp = await createCdp(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await sleep(3000);

    const pre = await cdp.evaluate(PAGE_PRECHECK);
    if (pre.error) throw new Error(`precheck failed: ${pre.error}`);
    const precheck = fakeAudioInputsOnly(pre.value.devices);
    const S5 = {
      location: pre.value.location.replace(/\?.*$/, ''),
      csp: { ...cspOf({ headers: pre.value.document.headers, html: pre.value.document.html }), liveMeta: pre.value.liveMeta, documentStatus: pre.value.document.status, documentHeaders: Object.keys(pre.value.document.headers).sort(), method: 'fetch(location.origin + "/") from the main window, plus the live meta tags' },
      crossOriginIsolated: pre.value.crossOriginIsolated,
      sharedArrayBuffer: pre.value.sharedArrayBuffer,
      micPermissionBefore: pre.value.micPermission,
      devices: pre.value.devices,
      precheck,
      flagsTook: precheck.ok,
      vadFiles: pre.value.vadFiles,
    };
    result.scenarios.S5 = S5;
    if (precheck.ok) {
      const gum = await cdp.evaluate(PAGE_GET_USER_MEDIA);
      S5.getUserMedia = gum.error ? { refused: true, error: gum.error } : { refused: false, ...gum.value };
      const permissionAfter = await cdp.evaluate("navigator.permissions.query({ name: 'microphone' }).then((s) => s.state)");
      S5.micPermissionAfter = permissionAfter.value ?? permissionAfter.error;
      const ort = await cdp.evaluate(PAGE_ORT);
      S5.ort = ort.error ? { error: ort.error } : ort.value;
      if (!gum.error) {
        const servedBundle = S5.vadFiles['bundle.min.js']?.status === 200;
        if (!servedBundle && vadBundle) {
          const loaded = await cdp.evaluate(`${fs.readFileSync(vadBundle, 'utf8')}\n;typeof window.vad`, 30_000);
          S5.vadBundleInjected = { sha256: sha256File(vadBundle), result: loaded.value ?? loaded.error };
        }
        const vadStart = await cdp.evaluate(PAGE_VAD_START(servedBundle), 60_000);
        S5.vadProxy = vadStart.error ? { loaded: false, error: vadStart.error } : { loaded: true, ...vadStart.value };
        const waitStarted = Date.now();
        let speech = { speech: [], csp: [] };
        while (Date.now() - waitStarted < SPEECH_END_WAIT_MS) {
          speech = (await cdp.evaluate(PAGE_VAD_EVENTS)).value ?? speech;
          if (speech.speech.some((event) => event.type === 'end')) break;
          await sleep(250);
        }
        const end = speech.speech.find((event) => event.type === 'end') ?? null;
        S5.vadProxy.speechEvents = speech.speech;
        S5.vadProxy.speechEndWithin10s = Boolean(end);
        S5.vadProxy.speechEndSamples = end?.samples ?? null;
        S5.vadProxy.note = "proxy only (F4): vad-web's UMD bundle with its own ONNX Runtime 1.22.0; Talk's shipped path is re-proved in Task 9 and gate P4-V5";
      }
      const teardown = await cdp.evaluate(PAGE_TEARDOWN);
      S5.teardown = teardown.value ?? { error: teardown.error };
    } else {
      S5.getUserMedia = { notRun: 'flags did not take: an audio input that is not a Chromium fake device, or no label' };
    }
    const events = consoleOf(cdp.events);
    S5.console = events.slice(0, 40);
    const cspText = events.filter((entry) => /content security policy|refused to (load|execute|compile|create)|wasm-unsafe-eval|unsafe-eval/i.test(entry.text));
    S5.cspViolations = { console: cspText, events: S5.teardown?.csp ?? [] };
    S5.cspBlocksVad = cspText.some((entry) => /wasm|worklet|vad|onnx/i.test(entry.text)) || (S5.teardown?.csp ?? []).length > 0;

    await sleep(500);
    cdp.close();
    cdp = null;
    const command = (spawnSync('ps', ['-o', 'command=', '-p', String(appChild.pid)], { encoding: 'utf8' }).stdout ?? '').trim();
    S5.quit = { binaryMatched: command.startsWith(executable) };
    if (S5.quit.binaryMatched) {
      try { process.kill(-appChild.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 50 && processesNaming(home).length > 0; i += 1) await sleep(200);
    }
    S5.quit.leftAfterTerm = processesNaming(home).length;
    await stopSampler();

    const minutes = Math.max(2, Math.ceil((Date.now() - launchedAt) / 60_000) + 1);
    const tccLines = tccLog(minutes).split('\n');
    const tccAfter = tccLinesFor(tccLines.join('\n'), GATE_BUNDLE_ID);
    const messageIds = new Set(tccAfter.flatMap((line) => line.match(/msgID=[0-9.]+/g) ?? []));
    const related = tccLines.filter((line) => [...messageIds].some((id) => line.includes(`${id},`) || line.endsWith(id)));
    S5.tcc = { windowMinutes: minutes, newLines: tccAfter.length, ...tccSummaryOf(related) };
    const dialogsAfter = [...processesNamed('SecurityAgent'), ...processesNamed('UserNotificationCenter')].filter((pid) => !dialogsBefore.has(pid));
    S5.dialogs = { newProcesses: dialogsAfter.length };
    const realAfter = Object.fromEntries(REAL_DIRS(realHome).map((dir) => [dir.replace(realHome, '~'), statOf(dir)]));
    S5.realDirs = Object.fromEntries(Object.keys(realBefore).map((dir) => [dir, { ...realAfter[dir], changed: realBefore[dir].exists !== realAfter[dir].exists || realBefore[dir].mtimeMs !== realAfter[dir].mtimeMs }]));
    S5.launchServicesPlistChanged = lsBefore !== (fs.existsSync(launchServicesPlist(realHome)) ? sha256File(launchServicesPlist(realHome)) : null);
    const logs = [path.join(home, 'app.log'), ...fs.readdirSync(path.join(home), { recursive: true }).filter((entry) => /Logs\/.*\.log$/.test(String(entry))).map((entry) => path.join(home, String(entry)))];
    S5.appLogPermissionLines = logs.filter((file) => fs.existsSync(file)).flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => /permission/i.test(line)).map((line) => line.slice(0, 200)));
    S5.upstreamTempDirs = ['.config/opencode', '.local/share/opencode', '.config/openchamber', 'Library/Application Support/OpenChamber'].filter((relative) => fs.existsSync(path.join(home, relative)));
    result.reserved57133.listeningAfter = listenerPids(57133).length > 0;
  } catch (error) {
    result.fatal = String(error?.stack ?? error);
  } finally {
    await cleanup();
  }
  result.outbound = { lsofSamples: outbound.samples, pidsSeen: outbound.pids.size, nonLoopbackRemotes: [...outbound.remotes].sort() };
  result.portGuard = guard;
  result.leftAfterCleanup = processesNaming(home).length;
  result.stopConditions = windowStopConditions(result.scenarios);
  result.finishedAt = new Date().toISOString();
  if (keep) result.keptHome = home;
  else fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ stopConditions: result.stopConditions, fatal: result.fatal ?? null, outbound: result.outbound }, null, 2));
  console.log(`wrote ${path.resolve(out)}`);
  return result.fatal ? 1 : 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
