#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STUB_VERSION = 'cua-driver 0.28.2-stub';
export const STUB_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const SCREEN_RECORDING_REFUSAL = 'Screen Recording is NOT granted for this process. Run `cua-driver permissions grant` to request it.';

const APPS = [
  { name: 'Finder', pid: 4101, running: true, bundle_id: 'com.apple.finder' },
  { name: 'MittrCraft Dev', pid: 4243, running: true, bundle_id: 'dev.mittrcraft.desktop.dev' },
  { name: 'MittrCraft Gate', pid: 4244, running: true, bundle_id: 'dev.mittrcraft.desktop.dev.gate' },
  { name: 'Calculator', pid: 0, running: false, bundle_id: 'com.apple.calculator' },
];

export const SEVERAL_WINDOWS = [
  { window_id: 3965, title: 'Calculator' },
  { window_id: 3964, title: '' },
  { window_id: 3963, title: '' },
  { window_id: 3962, title: '' },
  { window_id: 3961, title: '' },
];

export const answer = (tool, args, { mode }) => {
  if (tool === 'list_apps') return { apps: APPS };
  if (tool === 'bring_to_front' && mode === 'several-windows' && args.window_id === undefined) {
    return { code: 'ambiguous_window_target', candidates: SEVERAL_WINDOWS };
  }
  if (tool === 'bring_to_front') return { process_activated: true, exact_window_effect: { verified: true } };
  if (tool === 'get_desktop_state') {
    if (mode === 'screen-recording-error') throw new Error(SCREEN_RECORDING_REFUSAL);
    return { screenshot_png_b64: STUB_PNG.toString('base64'), screenshot_mime_type: 'image/png', screen_width: 1, screen_height: 1 };
  }
  throw new Error(`stub cua-driver has no tool ${tool}`);
};

const modeOf = (stateDir) => {
  try {
    return fs.readFileSync(path.join(stateDir, 'mode'), 'utf8').trim() || 'normal';
  } catch {
    return 'normal';
  }
};

const QUIET_KEYS = ['CUA_DRIVER_RS_TELEMETRY_ENABLED', 'CUA_TELEMETRY_ENABLED', 'CUA_DRIVER_RS_UPDATE_CHECK', 'CUA_DRIVER_TELEMETRY_HOME', 'HOME'];

const without = (argv, flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? { value: null, rest: argv } : { value: argv[at + 1], rest: argv.filter((_, index) => index !== at && index !== at + 1) };
};

const parsed = (raw) => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { unparsed: String(raw) };
  }
};

const record = (stateDir, entry) => fs.appendFileSync(path.join(stateDir, 'calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

const reply = (tool, args, stateDir) => {
  const mode = modeOf(stateDir);
  record(stateDir, { tool, args, mode });
  try {
    return { ok: true, result: answer(tool, args, { mode }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

const ask = (socketPath, request, answered) => {
  const socket = net.connect({ path: socketPath });
  let buffer = '';
  socket.on('error', () => {
    process.stderr.write(`Cua Driver daemon is not running on ${socketPath}.\nStart it first with: cua-driver serve --socket ${socketPath}\n`);
    process.exitCode = 1;
  });
  socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('data', (chunk) => {
    buffer += chunk;
  });
  socket.on('end', () => answered(JSON.parse(buffer)));
};

const serve = (socketPath, stateDir) => {
  record(stateDir, {
    daemon: 'serve',
    socketPath,
    env: Object.fromEntries(QUIET_KEYS.map((key) => [key, process.env[key] ?? null])),
  });
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const request = JSON.parse(buffer.slice(0, end));
      if (request.method === 'shutdown') {
        socket.end(JSON.stringify({ ok: true }));
        server.close();
        fs.rmSync(socketPath, { force: true });
        setImmediate(() => process.exit(0));
        return;
      }
      socket.end(JSON.stringify(reply(request.name, request.args ?? {}, stateDir)));
    });
  });
  server.listen(socketPath);
};

const main = () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version') {
    process.stdout.write(`${STUB_VERSION}\n`);
    return;
  }
  const state = without(argv, '--state');
  const stateDir = state.value ?? process.cwd();
  const socket = without(state.rest, '--socket');
  const [command, ...rest] = socket.rest;
  if (socket.value && command === 'serve') {
    serve(socket.value, stateDir);
    return;
  }
  if (socket.value && command === 'stop') {
    ask(socket.value, { method: 'shutdown' }, () => {});
    return;
  }
  if (socket.value && command === 'call') {
    ask(socket.value, { method: 'call', name: rest[0], args: parsed(rest[1]) }, (response) => {
      if (response.ok) process.stdout.write(`${JSON.stringify(response.result)}\n`);
      else {
        process.stderr.write(`${response.error}\n`);
        process.exitCode = 1;
      }
    });
    return;
  }
  const [tool, raw] = socket.rest;
  const { ok, result, error } = reply(tool, parsed(raw), stateDir);
  if (ok) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
