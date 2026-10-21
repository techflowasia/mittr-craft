#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STUB_VERSION = 'cua-driver 0.28.2-stub';
export const STUB_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const SCREEN_RECORDING_REFUSAL = 'Screen Recording is NOT granted for this process. Run `cua-driver permissions grant` to request it.';

const APPS = [
  { name: 'Finder', pid: 4101, running: true, bundle_id: 'com.apple.finder' },
  { name: 'MittrCraft Dev', pid: 4243, running: true, bundle_id: 'dev.mittrcraft.desktop.dev' },
  { name: 'Calculator', pid: 0, running: false, bundle_id: 'com.apple.calculator' },
];

export const answer = (tool, args, { mode }) => {
  if (tool === 'list_apps') return { apps: APPS };
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

const main = () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version') {
    process.stdout.write(`${STUB_VERSION}\n`);
    return;
  }
  const stateAt = argv.indexOf('--state');
  const stateDir = stateAt === -1 ? process.cwd() : argv[stateAt + 1];
  const rest = stateAt === -1 ? argv : argv.filter((_, index) => index !== stateAt && index !== stateAt + 1);
  const [tool, raw] = rest;
  let args = {};
  try {
    args = raw ? JSON.parse(raw) : {};
  } catch {
    args = { unparsed: String(raw) };
  }
  const mode = modeOf(stateDir);
  fs.appendFileSync(path.join(stateDir, 'calls.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), tool, args, mode })}\n`);
  try {
    process.stdout.write(`${JSON.stringify(answer(tool, args, { mode }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
