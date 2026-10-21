#!/usr/bin/env node
import { execFile, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AGENT_BROWSER_RESOURCE_DIR, readDriverPins } from './drivers.mjs';
import { nonLoopbackFromLsof } from './probe-engine-v2.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const STAGED_AGENT_BROWSER = path.join(repoRoot, 'packages', 'electron', '.product', AGENT_BROWSER_RESOURCE_DIR, 'agent-browser');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const CHROME_FLAGS = [
  '--use-mock-keychain',
  '--password-store=basic',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--no-first-run',
  '--metrics-recording-only',
  '--disable-features=MediaRouter',
  '--no-default-browser-check',
];
const EVIL_ORIGIN = 'http://evil.example.test';

const SAMPLE_MS = 250;
const SEEDED_PROFILE = { directory: 'Default', name: 'Mittr Probe Throwaway' };
const WATCHED_DIALOGS = ['SecurityAgent', 'UserNotificationCenter'];

export const chromeArgs = (proxyPort) => [...CHROME_FLAGS, `--proxy-server=127.0.0.1:${proxyPort}`];

export const installStopHandlers = ({ cleanup, target = process, exit = (code) => process.exit(code) }) => {
  let stopping = false;
  const handle = (signal) => {
    if (stopping) return;
    stopping = true;
    Promise.resolve().then(() => cleanup(signal)).catch(() => {}).finally(() => exit(signal === 'SIGINT' ? 130 : 143));
  };
  target.on('SIGINT', handle);
  target.on('SIGTERM', handle);
  return () => {
    target.off('SIGINT', handle);
    target.off('SIGTERM', handle);
  };
};

export const pathsUnder = (lsofText, root) => {
  const found = new Set();
  for (const line of String(lsofText).split('\n')) {
    let index = line.indexOf(root);
    while (index !== -1) {
      const rest = line.slice(index + root.length);
      const boundary = line[index - 1];
      if ((boundary === undefined || boundary === ' ') && (rest === '' || rest.startsWith('/'))) {
        found.add(line.slice(index).replace(/ \((deleted|readlink: .*)\)$/, ''));
        break;
      }
      index = line.indexOf(root, index + 1);
    }
  }
  return [...found];
};

export const peersOf = nonLoopbackFromLsof;

const isLoopbackAddress = (host) => {
  const bare = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || bare.startsWith('127.');
};

const listenersOf = (lsofText) => {
  const found = new Set();
  for (const line of String(lsofText).split('\n')) {
    const tcp = line.match(/\bTCP (\S+):(\d+) \(LISTEN\)/);
    const udp = !line.includes('->') && line.match(/\bUDP (\S+):(\d+|\*)\s*$/);
    const match = tcp || udp;
    if (match) found.add(`${match[1]}:${match[2]}`);
  }
  return [...found];
};

export const exposedListeners = (lsofText) => listenersOf(lsofText).filter((listener) => !isLoopbackAddress(listener.slice(0, listener.lastIndexOf(':'))));

export const upgradeRefused = (response) => !/^HTTP\/1\.[01] 101\b/.test(String(response));

const sbString = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const sbRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');

const realRoots = (realHome) => ({
  googleSupport: path.join(realHome, 'Library', 'Application Support', 'Google'),
  chromeProfile: path.join(realHome, 'Library', 'Application Support', 'Google', 'Chrome'),
  googleCaches: path.join(realHome, 'Library', 'Caches', 'Google'),
  googlePreferences: path.join(realHome, 'Library', 'Preferences', 'com.google.'),
  agentBrowser: path.join(realHome, '.agent-browser'),
});

export const sandboxProfile = (realHome) => {
  const roots = realRoots(realHome);
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* (subpath "${sbString(roots.googleSupport)}"))`,
    `(deny file-read* file-write* (regex #"^${sbRegex(roots.googlePreferences)}"))`,
    `(deny file-read* file-write* (subpath "${sbString(roots.googleCaches)}"))`,
    `(deny file-read* file-write* (subpath "${sbString(roots.agentBrowser)}"))`,
    '',
  ].join('\n');
};

const resolvedPath = (target) => {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
};

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execText = (command, args, options = {}) => new Promise((resolve) => {
  execFile(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20_000, ...options }, (error, stdout, stderr) => {
    resolve({ status: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

const mtimeOf = (target) => {
  const result = spawnSync('stat', ['-f', '%m', target], { encoding: 'utf8' });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
};

const watchedRealPaths = (realHome) => {
  const roots = realRoots(realHome);
  const preferencesDir = path.dirname(roots.googlePreferences);
  const preferenceFiles = fs.readdirSync(preferencesDir)
    .filter((name) => name.startsWith(path.basename(roots.googlePreferences)))
    .map((name) => path.join(preferencesDir, name));
  return [
    roots.googleSupport,
    roots.chromeProfile,
    path.join(roots.googleSupport, 'GoogleUpdater'),
    roots.googleCaches,
    roots.agentBrowser,
    ...preferenceFiles,
  ];
};

const mtimes = (paths) => Object.fromEntries(paths.map((target) => [target, mtimeOf(target)]));

const processTable = async () => {
  const { stdout } = await execText('ps', ['-axww', '-o', 'pid=,ppid=,command=']);
  return stdout.split('\n').map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
};

const ourProcesses = (table, markers) => {
  const ours = new Map(table.filter((row) => row.pid !== process.pid && markers.some((marker) => row.command.includes(marker))).map((row) => [row.pid, row]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (!ours.has(row.pid) && ours.has(row.ppid)) {
        ours.set(row.pid, row);
        grew = true;
      }
    }
  }
  return [...ours.values()];
};

const pidsOf = async (name) => {
  const { stdout } = await execText('pgrep', ['-x', name]);
  return stdout.split('\n').map((line) => Number(line.trim())).filter(Boolean);
};

const keychainStatus = (realHome) => spawnSync('security', ['find-generic-password', '-s', 'Chrome Safe Storage', path.join(realHome, 'Library', 'Keychains', 'login.keychain-db')], { stdio: 'ignore' }).status;

const cocoaPaths = (env) => {
  const script = 'ObjC.import("Foundation"); var d = function (k) { return $.NSSearchPathForDirectoriesInDomains(k, $.NSUserDomainMask, true).objectAtIndex(0).js; }; JSON.stringify({ home: $.NSHomeDirectory().js, applicationSupport: d($.NSApplicationSupportDirectory), caches: d($.NSCachesDirectory), preferences: d($.NSLibraryDirectory) + "/Preferences" })';
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { env, encoding: 'utf8', timeout: 20_000 });
  return result.status === 0 ? JSON.parse(result.stdout.trim()) : { error: String(result.stderr).trim() };
};

const formPage = `<!doctype html><html><head><meta charset="utf-8"><title>Probe form</title><link rel="icon" href="data:,"></head>
<body><h1>Probe form</h1><form action="/done" method="get"><label>Name <input name="name" type="text"></label><button type="submit">Send</button></form></body></html>`;
const donePage = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>Probe done</title><link rel="icon" href="data:,"></head>
<body><h1>Probe done</h1><p id="out">Received: ${name.replace(/[<>&"]/g, '')}</p></body></html>`;

const startPageServer = () => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname });
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/') response.end(formPage);
    else if (url.pathname === '/done') response.end(donePage(url.searchParams.get('name') ?? ''));
    else {
      response.statusCode = 404;
      response.end('not found');
    }
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
});

const startRefusingProxy = () => new Promise((resolve) => {
  const attempts = [];
  const server = http.createServer((request, response) => {
    attempts.push({ kind: 'http', target: request.headers.host ?? request.url, at: new Date().toISOString() });
    response.statusCode = 403;
    response.end();
  });
  server.on('connect', (request, socket) => {
    attempts.push({ kind: 'connect', target: request.url, at: new Date().toISOString() });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, attempts }));
});

const websocketUpgrade = (port, origin) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  let text = '';
  const done = (result) => {
    socket.destroy();
    resolve(result);
  };
  socket.setTimeout(5_000, () => done({ response: text, timedOut: true }));
  socket.on('error', (error) => done({ response: text, error: error.code ?? error.message }));
  socket.on('data', (chunk) => {
    text += chunk.toString('latin1');
    if (text.includes('\r\n\r\n')) done({ response: text.split('\r\n')[0] });
  });
  socket.on('close', () => done({ response: text.split('\r\n')[0] }));
  socket.on('connect', () => {
    socket.write([
      'GET / HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      `Origin: ${origin}`,
      '',
      '',
    ].join('\r\n'));
  });
});

const parseJson = (text) => {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
};

const refsFrom = (snapshotText) => {
  const refs = [];
  for (const match of String(snapshotText).matchAll(/(textbox|button)\s+"([^"]*)"[^\n]*?\[ref=(e\d+)\]/g)) {
    refs.push({ role: match[1], name: match[2], ref: match[3] });
  }
  return refs;
};

const helpLines = (helpText) => String(helpText).split('\n').filter((line) => /^\s+--args\b/.test(line) || /^\s+e\.g\., --args\b/.test(line) || /^\s+AGENT_BROWSER_ARGS\b/.test(line)).map((line) => line.trim());

const usage = 'Usage: node scripts/mittr/probe-agent-browser.mjs --json <out> [--keep]';

const parseArgs = (argv) => {
  const index = argv.indexOf('--json');
  if (index === -1 || !argv[index + 1]) throw new Error(usage);
  return { out: path.resolve(argv[index + 1]), keep: argv.includes('--keep') };
};

const assertPreconditions = ({ realHome, pins }) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('the probe runs on macOS arm64 only');
  if (path.resolve(process.env.HOME ?? '') === path.resolve(realHome)) throw new Error('run the probe under iso: HOME is the real home');
  if (!fs.existsSync(STAGED_AGENT_BROWSER)) throw new Error(`no staged agent-browser at ${STAGED_AGENT_BROWSER}; run the build first`);
  if ((fs.statSync(STAGED_AGENT_BROWSER).mode & 0o777) !== 0o755) throw new Error(`the staged agent-browser is not mode 0755: ${STAGED_AGENT_BROWSER}`);
  if (sha256(fs.readFileSync(STAGED_AGENT_BROWSER)) !== pins.agentBrowser.sha256) throw new Error('the staged agent-browser is not the pinned build');
  if (!fs.existsSync(CHROME)) throw new Error(`Google Chrome is not at ${CHROME}`);
};

const seedProfile = (home) => {
  const userData = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  fs.mkdirSync(path.join(userData, SEEDED_PROFILE.directory), { recursive: true });
  fs.writeFileSync(path.join(userData, 'Local State'), `${JSON.stringify({ profile: { info_cache: { [SEEDED_PROFILE.directory]: { name: SEEDED_PROFILE.name } }, last_used: SEEDED_PROFILE.directory } })}\n`);
  return userData;
};

const sandboxDenials = async (since) => {
  const result = await execText('log', ['show', '--start', since, '--style', 'compact', '--predicate', 'sender == "Sandbox" AND eventMessage CONTAINS "agent-browser"'], { timeout: 60_000 });
  return result.stdout.split('\n').filter((line) => /deny\(\d+\)/.test(line)).map((line) => line.slice(line.indexOf('Sandbox:')));
};

const logTime = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
};

const main = async () => {
  const { out, keep } = parseArgs(process.argv.slice(2));
  const realHome = os.userInfo().homedir;
  const pins = readDriverPins();
  assertPreconditions({ realHome, pins });
  const roots = realRoots(realHome);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4ab.')));
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, tmp, path.join(home, '.config'), path.join(home, '.local', 'share'), path.join(home, '.local', 'state'), path.join(home, '.cache')]) fs.mkdirSync(dir, { recursive: true });
  const baseEnv = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: `${tmp}/`,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
  };
  const env = {
    ...baseEnv,
    AGENT_BROWSER_EXECUTABLE_PATH: CHROME,
    AGENT_BROWSER_SESSION: 'p4',
    AGENT_BROWSER_IDLE_TIMEOUT_MS: '300000',
  };
  const seededUserData = seedProfile(home);
  const markers = [STAGED_AGENT_BROWSER, root];

  const result = {
    startedAt: new Date().toISOString(),
    agentBrowser: { binary: STAGED_AGENT_BROWSER, sha256: pins.agentBrowser.sha256, version: pins.agentBrowser.version },
    chrome: { path: CHROME, version: spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(CHROME, '..', '..', 'Info.plist')], { encoding: 'utf8' }).stdout.trim() },
    tempRoot: root,
    flags: CHROME_FLAGS,
    rows: {},
    stopped: null,
    commands: [],
  };

  const watched = watchedRealPaths(realHome);
  const before = mtimes(watched);
  const keychainBefore = keychainStatus(realHome);
  const keychainFileBefore = mtimeOf(path.join(realHome, 'Library', 'Keychains', 'login.keychain-db'));
  const ownerChromeBefore = await pidsOf('Google Chrome');
  const dialogBaseline = Object.fromEntries(await Promise.all(WATCHED_DIALOGS.map(async (name) => [name, await pidsOf(name)])));

  const seen = { processes: new Map(), realPaths: new Set(), peers: new Set(), peerOwners: new Map(), listeners: new Set(), exposed: new Set(), tempPaths: new Set(), dialogs: [], samples: 0 };
  let row = 'setup';
  let sampling = true;
  let busy = false;
  const sample = async () => {
    if (busy || !sampling) return;
    busy = true;
    try {
      for (const name of WATCHED_DIALOGS) {
        for (const pid of await pidsOf(name)) {
          if (!dialogBaseline[name].includes(pid) && !seen.dialogs.some((dialog) => dialog.pid === pid)) seen.dialogs.push({ name, pid, row, at: new Date().toISOString() });
        }
      }
      const ours = ourProcesses(await processTable(), markers);
      for (const proc of ours) if (!seen.processes.has(proc.pid)) seen.processes.set(proc.pid, proc);
      if (ours.length === 0) return;
      const { stdout } = await execText('lsof', ['-nP', '-w', '-p', ours.map((proc) => proc.pid).join(',')]);
      seen.samples += 1;
      for (const target of Object.values(roots)) for (const hit of pathsUnder(stdout, target.endsWith('com.google.') ? path.dirname(target) : target)) {
        if (!target.endsWith('com.google.') || path.basename(hit).startsWith('com.google.')) seen.realPaths.add(hit);
      }
      for (const line of stdout.split('\n')) {
        for (const peer of peersOf(line)) {
          seen.peers.add(peer);
          if (!seen.peerOwners.has(peer)) {
            const pid = Number(line.split(/\s+/)[1]);
            seen.peerOwners.set(peer, { pid, process: (seen.processes.get(pid)?.command ?? '').replaceAll(root, '<temp>').slice(0, 140), row, at: new Date().toISOString() });
          }
        }
      }
      for (const listener of listenersOf(stdout)) seen.listeners.add(listener);
      for (const listener of exposedListeners(stdout)) seen.exposed.add(listener);
      for (const hit of pathsUnder(stdout, tmp)) seen.tempPaths.add(hit.split('/').slice(0, tmp.split('/').length + 1).join('/'));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { sample(); }, SAMPLE_MS);
  const settle = async (ms = 1_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await sample();
      await sleep(SAMPLE_MS);
    }
  };
  const stopFor = (reason) => {
    if (!result.stopped) result.stopped = { row, reason };
  };
  const dialogCheck = () => {
    if (seen.dialogs.length > 0) stopFor(`a ${seen.dialogs[0].name} process appeared during ${seen.dialogs[0].row}`);
    if (seen.realPaths.size > 0) stopFor(`a real Chrome or Google path was opened: ${[...seen.realPaths][0]}`);
    if (seen.exposed.size > 0) stopFor(`a non-loopback listener appeared: ${[...seen.exposed].join(', ')}`);
    return !result.stopped;
  };

  const live = new Set();
  const ab = (args, { sandbox = null, timeout = 60_000 } = {}) => new Promise((resolve) => {
    const command = sandbox ? '/usr/bin/sandbox-exec' : STAGED_AGENT_BROWSER;
    const argv = sandbox ? ['-f', sandbox, STAGED_AGENT_BROWSER, ...args] : args;
    const child = spawn(command, argv, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    live.add(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      live.delete(child.pid);
      const entry = { row, args: args.map((arg) => (arg.length > 120 ? `${arg.slice(0, 117)}...` : arg)), status, signal, stdoutBytes: stdout.length, stderr: stderr.trim().slice(0, 400) };
      result.commands.push(entry);
      resolve({ status, signal, stdout, stderr });
    });
  });

  const closeAll = async () => {
    const closed = await ab(['close', '--all']);
    const deadline = Date.now() + 15_000;
    let left = [];
    while (Date.now() < deadline) {
      await sleep(500);
      left = ourProcesses(await processTable(), markers);
      if (left.length === 0) break;
    }
    return {
      closeStatus: closed.status,
      leftAfterClose: left.map((proc) => ({ pid: proc.pid, command: proc.command.replaceAll(root, '<temp>').slice(0, 160) })),
      pgrepStaged: (await execText('pgrep', ['-f', STAGED_AGENT_BROWSER])).stdout.trim(),
      pgrepTempRoot: (await execText('pgrep', ['-f', root])).stdout.trim(),
    };
  };

  const killSurvivors = async () => {
    const killed = [];
    for (const pid of live) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    for (const proc of ourProcesses(await processTable(), markers)) {
      if (proc.command.includes(root) || proc.command.startsWith(STAGED_AGENT_BROWSER) || proc.command.startsWith(path.dirname(path.dirname(path.dirname(CHROME))))) {
        try {
          process.kill(proc.pid, 'SIGKILL');
          killed.push({ pid: proc.pid, command: proc.command.replaceAll(root, '<temp>').slice(0, 160) });
        } catch {}
      }
    }
    return killed;
  };

  const pageServer = await startPageServer();
  const pageUrl = `http://127.0.0.1:${pageServer.port}/`;
  const proxy = await startRefusingProxy();
  const launchArgs = chromeArgs(proxy.port);
  const proxyFlag = launchArgs[launchArgs.length - 1];
  env.AGENT_BROWSER_ARGS = launchArgs.join('\n');
  let chromeMain = null;

  const removeStopHandlers = installStopHandlers({
    cleanup: async () => {
      sampling = false;
      clearInterval(timer);
      await Promise.race([ab(['close', '--all'], { timeout: 10_000 }), sleep(10_000)]);
      await killSurvivors();
      pageServer.server.close();
      proxy.server.close();
      if (!keep) fs.rmSync(root, { recursive: true, force: true });
    },
  });

  try {
    row = 'AB1';
    const cocoa = cocoaPaths(baseEnv);
    const cocoaWithoutFixedHome = cocoaPaths({ ...baseEnv, CFFIXED_USER_HOME: undefined });
    const insideHome = (value) => resolvedPath(String(value)) === home || resolvedPath(String(value)).startsWith(`${home}/`);
    const moved = !cocoa.error && [cocoa.home, cocoa.applicationSupport, cocoa.caches, cocoa.preferences].every(insideHome);
    const ab1 = { cfFixedUserHome: { withIt: cocoa, homeOnlyHome: cocoaWithoutFixedHome.home, moved } };
    result.rows.AB1 = ab1;
    if (!moved) {
      ab1.pass = false;
      stopFor('CFFIXED_USER_HOME does not move the Cocoa home, Application Support, Caches and Preferences folders');
      throw new Error(result.stopped.reason);
    }

    const sandboxFile = path.join(root, 'deny-real-google.sb');
    fs.writeFileSync(sandboxFile, sandboxProfile(realHome));
    const since = logTime();
    const profiles = await ab(['--json', 'profiles'], { sandbox: sandboxFile });
    await settle(500);
    const parsed = parseJson(profiles.stdout);
    ab1.firstCallUnderSandbox = { status: profiles.status, output: parsed ?? profiles.stdout.slice(0, 2_000), stderr: profiles.stderr.slice(0, 400) };
    ab1.sandboxDenials = await sandboxDenials(since);
    const listed = JSON.stringify(parsed ?? profiles.stdout);
    const profileEntries = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.data?.profiles) ? parsed.data.profiles : Array.isArray(parsed) ? parsed : null;
    ab1.profilesListed = profileEntries;
    ab1.onlySeededProfile = profiles.status === 0 && Array.isArray(profileEntries) && profileEntries.length === 1 && listed.includes(SEEDED_PROFILE.name) && !listed.includes(roots.chromeProfile);
    if (!ab1.onlySeededProfile || ab1.sandboxDenials.length > 0) {
      ab1.pass = false;
      stopFor('agent-browser profiles did not list only the seeded throwaway profile under the sandbox');
      throw new Error(result.stopped.reason);
    }
    if (!dialogCheck()) throw new Error(result.stopped.reason);

    row = 'AB4';
    const ab4 = { pageUrl, steps: {} };
    result.rows.AB4 = ab4;
    env.AGENT_BROWSER_PROFILE = SEEDED_PROFILE.directory;
    const opened = await ab(['open', pageUrl], { timeout: 90_000 });
    ab4.steps.open = opened.status === 0;
    await settle(1_500);
    const table = await processTable();
    const ours = ourProcesses(table, markers);
    chromeMain = ours.find((proc) => proc.command.startsWith(CHROME) && !proc.command.includes('--type=')) ?? null;
    result.chromeCommand = chromeMain ? chromeMain.command.replaceAll(root, '<temp>') : null;
    const userDataArg = chromeMain?.command.match(/--user-data-dir=(\S+)/)?.[1] ?? null;
    result.profileCopy = { userDataDir: userDataArg ? userDataArg.replaceAll(root, '<temp>') : null, underTemp: Boolean(userDataArg?.startsWith(root)), seededUserData: seededUserData.replaceAll(root, '<temp>') };
    const headless = Boolean(chromeMain?.command.includes('--headless'));
    result.headless = headless;
    result.proxyFlagOnChrome = Boolean(chromeMain?.command.includes(proxyFlag));
    if (!chromeMain || !headless) {
      stopFor(chromeMain ? 'Chrome was not started headless' : 'no Chrome process was found for the probe');
      throw new Error(result.stopped.reason);
    }
    if (!result.profileCopy.underTemp) {
      result.rows.AB1.pass = false;
      stopFor('Chrome was started on a user-data-dir outside the temp root');
      throw new Error(result.stopped.reason);
    }
    if (!result.proxyFlagOnChrome) {
      stopFor(`Chrome was started without ${proxyFlag}`);
      throw new Error(result.stopped.reason);
    }
    if (!dialogCheck()) throw new Error(result.stopped.reason);

    const snapshot = await ab(['snapshot', '-i']);
    const refs = refsFrom(snapshot.stdout);
    ab4.steps.snapshot = snapshot.status === 0 && refs.length > 0;
    ab4.refs = refs;
    const textbox = refs.find((ref) => ref.role === 'textbox');
    const button = refs.find((ref) => ref.role === 'button');
    const filled = textbox ? await ab(['fill', `@${textbox.ref}`, 'mittr probe']) : { status: null };
    ab4.steps.fill = filled.status === 0;
    const clicked = button ? await ab(['click', `@${button.ref}`]) : { status: null };
    ab4.steps.click = clicked.status === 0;
    await settle(1_000);
    const url = await ab(['get', 'url']);
    ab4.url = url.stdout.trim();
    ab4.steps.getUrl = url.status === 0 && ab4.url === `${pageUrl}done?name=mittr+probe`;
    const shot = path.join(tmp, 'probe-shot.png');
    const screenshot = await ab(['screenshot', shot]);
    const shotBytes = fs.existsSync(shot) ? fs.readFileSync(shot) : Buffer.alloc(0);
    ab4.screenshot = { bytes: shotBytes.length, png: shotBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) };
    ab4.steps.screenshot = screenshot.status === 0 && ab4.screenshot.png;
    const read = await ab(['read']);
    ab4.readExcerpt = read.stdout.trim().slice(0, 300);
    ab4.steps.read = read.status === 0 && read.stdout.includes('Received: mittr probe');
    ab4.pageRequests = pageServer.requests;
    ab4.pass = Object.values(ab4.steps).every(Boolean) && Object.keys(ab4.steps).length === 7;
    if (!dialogCheck()) throw new Error(result.stopped.reason);

    row = 'AB6';
    if (!dialogCheck()) throw new Error(result.stopped.reason);
    const ab6 = {};
    result.rows.AB6 = ab6;
    const help = spawnSync(STAGED_AGENT_BROWSER, ['--help'], { cwd: home, env, encoding: 'utf8', timeout: 20_000 });
    ab6.streamCommandsInHelp = String(help.stdout).split('\n').map((line) => line.trim()).filter((line) => /^stream (enable|disable|status)\b/.test(line));
    const statusBefore = await ab(['--json', 'stream', 'status']);
    ab6.streamStatusAtStart = parseJson(statusBefore.stdout) ?? statusBefore.stdout.trim().slice(0, 300);
    let streamPort = Number(JSON.stringify(ab6.streamStatusAtStart).match(/"port"\s*:\s*(\d+)/)?.[1] ?? 0) || null;
    ab6.streamOnByDefault = Boolean(streamPort) && /"(enabled|active|running)"\s*:\s*true/.test(JSON.stringify(ab6.streamStatusAtStart));
    if (!streamPort || !ab6.streamOnByDefault) {
      const enabled = await ab(['--json', 'stream', 'enable']);
      ab6.streamEnable = parseJson(enabled.stdout) ?? enabled.stdout.trim().slice(0, 300);
      streamPort = Number(JSON.stringify(ab6.streamEnable).match(/"port"\s*:\s*(\d+)/)?.[1] ?? 0) || null;
    }
    await settle(750);
    ab6.streamPort = streamPort;
    if (streamPort) {
      const { stdout: holder } = await execText('lsof', ['-nP', '-w', `-iTCP:${streamPort}`, '-sTCP:LISTEN', '-t']);
      const holderPids = holder.split('\n').map((line) => Number(line.trim())).filter(Boolean);
      const ourPids = new Set([...seen.processes.keys()]);
      ab6.streamPortHolderIsOurs = holderPids.length > 0 && holderPids.every((pid) => ourPids.has(pid));
      if (ab6.streamPortHolderIsOurs) {
        const sameOrigin = `http://127.0.0.1:${streamPort}`;
        ab6.sameOrigin = { origin: sameOrigin, ...(await websocketUpgrade(streamPort, sameOrigin)) };
        ab6.sameOrigin.accepted = !upgradeRefused(ab6.sameOrigin.response);
        ab6.evilOrigin = { origin: EVIL_ORIGIN, ...(await websocketUpgrade(streamPort, EVIL_ORIGIN)) };
        ab6.evilOrigin.refused = upgradeRefused(ab6.evilOrigin.response);
      }
    }
    const disabled = await ab(['--json', 'stream', 'disable']);
    ab6.perSessionStreamDisable = { exists: ab6.streamCommandsInHelp.some((line) => line.startsWith('stream disable')), status: disabled.status, output: parseJson(disabled.stdout) ?? disabled.stdout.trim().slice(0, 300) };
    await settle(750);
    if (!dialogCheck()) throw new Error(result.stopped.reason);

    row = 'AB5';
    const ab5 = {};
    result.rows.AB5 = ab5;
    const liveChrome = ourProcesses(await processTable(), markers).find((proc) => proc.command.startsWith(CHROME) && !proc.command.includes('--type=')) ?? chromeMain;
    const userDataDir = liveChrome.command.match(/--user-data-dir=(\S+)/)?.[1] ?? null;
    ab5.chromeAtClose = { pid: liveChrome.pid, sameAsFirst: liveChrome.pid === chromeMain.pid, userDataDir: userDataDir ? userDataDir.replaceAll(root, '<temp>') : null };
    ab5.profileCopyExistedBeforeClose = userDataDir ? fs.existsSync(userDataDir) : null;
    Object.assign(ab5, await closeAll());
    ab5.profileCopyRemovedByClose = userDataDir ? !fs.existsSync(userDataDir) : null;
    ab5.pass = ab5.closeStatus === 0 && ab5.leftAfterClose.length === 0 && ab5.pgrepStaged === '' && ab5.pgrepTempRoot === '';
    if (!dialogCheck()) throw new Error(result.stopped.reason);

  } catch (error) {
    if (!result.stopped) stopFor(error.message);
  } finally {
    sampling = false;
    clearInterval(timer);
    while (busy) await sleep(50);
    result.killedAtEnd = await killSurvivors();
    await new Promise((resolve) => pageServer.server.close(resolve));
    await new Promise((resolve) => proxy.server.close(resolve));
  }

  await sleep(1_000);
  const after = mtimes(watched);
  const ownerChromeAfter = await pidsOf('Google Chrome');
  result.realPathMtimes = watched.map((target) => ({ path: target.replace(realHome, '~'), before: before[target], after: after[target], changed: before[target] !== after[target] }));
  result.ownerChromeRunning = { before: ownerChromeBefore.length > 0, after: ownerChromeAfter.length > 0 };
  result.processesSeen = [...seen.processes.values()].map((proc) => ({ pid: proc.pid, ppid: proc.ppid, command: proc.command.replaceAll(root, '<temp>').slice(0, 200) }));
  result.lsofSamples = seen.samples;
  result.chromeMains = result.processesSeen.filter((proc) => proc.command.startsWith(CHROME) && !proc.command.includes('--type=')).map((proc) => ({ pid: proc.pid, ppid: proc.ppid, userDataDir: proc.command.match(/--user-data-dir=(\S+)/)?.[1] ?? null }));
  result.dialogs = seen.dialogs;
  result.tempPathsUnderTmp = [...seen.tempPaths].map((entry) => entry.replaceAll(root, '<temp>'));
  result.home = { createdUnderTempLibrary: fs.existsSync(path.join(home, 'Library')) ? spawnSync('find', [path.join(home, 'Library'), '-maxdepth', '3'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((entry) => entry.replaceAll(root, '<temp>')) : [] };
  result.home.chromePreferencesUnderTemp = fs.existsSync(path.join(home, 'Library', 'Preferences', 'com.google.Chrome.plist'));

  if (result.rows.AB1) {
    const ab1 = result.rows.AB1;
    ab1.realPathsOpened = [...seen.realPaths];
    ab1.realPathInCommandLines = result.processesSeen.some((proc) => proc.command.includes(roots.googleSupport) || proc.command.includes(roots.agentBrowser));
    ab1.realPathMtimeChanges = result.realPathMtimes.filter((entry) => entry.changed).map((entry) => entry.path);
    ab1.profileCopyUnderTemp = result.profileCopy?.underTemp === true;
    if (ab1.pass !== false) {
      ab1.pass = ab1.onlySeededProfile === true && ab1.realPathsOpened.length === 0 && !ab1.realPathInCommandLines && ab1.sandboxDenials.length === 0
        && ab1.realPathMtimeChanges.length === 0 && ab1.profileCopyUnderTemp;
    }
    if (ab1.pass === false && !result.stopped) stopFor('a real Chrome or Google path was opened, named, denied or changed, or the profile copy was outside the temp root');
  }

  const keychainAfter = keychainStatus(realHome);
  const chromeFlagsPassed = chromeMain ? Object.fromEntries(launchArgs.map((flag) => [flag, chromeMain.command.includes(flag)])) : null;
  const help = spawnSync(STAGED_AGENT_BROWSER, ['--help'], { cwd: home, env, encoding: 'utf8', timeout: 20_000 });
  result.rows.AB2 = {
    argumentChannel: helpLines(help.stdout),
    passedVia: 'AGENT_BROWSER_ARGS, one flag per line',
    chromeFlagsPassed,
    keychainItemStatus: { before: keychainBefore, after: keychainAfter },
    loginKeychainMtime: { before: keychainFileBefore, after: mtimeOf(path.join(realHome, 'Library', 'Keychains', 'login.keychain-db')) },
    securityAgentSeen: seen.dialogs.filter((dialog) => dialog.name === 'SecurityAgent'),
  };
  result.rows.AB2.pass = Boolean(chromeFlagsPassed?.['--use-mock-keychain'] && chromeFlagsPassed?.['--password-store=basic']) && keychainBefore === keychainAfter && result.rows.AB2.securityAgentSeen.length === 0;

  result.rows.AB3 = {
    peers: [...seen.peers],
    peerOwners: Object.fromEntries(seen.peerOwners),
    flagsOnChrome: chromeFlagsPassed,
    proxy: proxyFlag,
    refusedThroughProxy: [...new Set(proxy.attempts.map((attempt) => `${attempt.kind} ${attempt.target}`))],
    refusedAttempts: proxy.attempts.length,
    loopbackPageServedDirectly: pageServer.requests.length > 0,
    lsofSamples: seen.samples,
  };
  result.rows.AB3.pass = Boolean(chromeFlagsPassed) && Object.values(chromeFlagsPassed).every(Boolean) && seen.peers.size === 0 && seen.samples > 0 && result.rows.AB3.loopbackPageServedDirectly;

  if (result.rows.AB6) {
    const ab6 = result.rows.AB6;
    ab6.listeners = [...seen.listeners];
    ab6.exposed = [...seen.exposed];
    ab6.pass = ab6.exposed.length === 0 && ab6.listeners.length > 0 && ab6.sameOrigin?.accepted === true && ab6.evilOrigin?.refused === true;
    if (ab6.exposed.length > 0) stopFor(`non-loopback listeners: ${ab6.exposed.join(', ')}`);
  }
  for (const name of ['AB1', 'AB2', 'AB3', 'AB4', 'AB5', 'AB6']) {
    if (!result.rows[name]) result.rows[name] = { pass: null, notRun: true };
    if (result.rows[name].pass === undefined) result.rows[name].pass = false;
  }
  if (seen.dialogs.length > 0) stopFor(`${seen.dialogs.map((dialog) => dialog.name).join(', ')} appeared`);

  const leftover = (await execText('pgrep', ['-f', root])).stdout.trim();
  result.pgrepAfterCleanup = { tempRoot: leftover, staged: (await execText('pgrep', ['-f', STAGED_AGENT_BROWSER])).stdout.trim() };
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
  result.tempRootRemoved = !fs.existsSync(root);
  result.finishedAt = new Date().toISOString();
  removeStopHandlers();

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  const verdicts = Object.fromEntries(Object.entries(result.rows).map(([name, entry]) => [name, entry.pass === true ? 'PASS' : entry.pass === null ? 'NOT RUN' : 'FAIL']));
  console.log(JSON.stringify({ verdicts, stopped: result.stopped, peers: result.rows.AB3.peers, dialogs: result.dialogs }, null, 2));
  console.log(`wrote ${out}`);
  return Object.values(verdicts).every((verdict) => verdict === 'PASS') && !result.stopped ? 0 : 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
