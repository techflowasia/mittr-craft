import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { chromeSessionName, createChromeControl } from './chrome-control.js';

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const fakeBinary = async (reply) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-agent-browser-'));
  temporaryDirectories.push(directory);
  const binary = path.join(directory, 'agent-browser');
  const log = path.join(directory, 'argv.json');
  await fs.writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), chrome: process.env.AGENT_BROWSER_EXECUTABLE_PATH, namespace: process.env.AGENT_BROWSER_NAMESPACE }));
process.stdout.write(${JSON.stringify(JSON.stringify(reply))});
`, { mode: 0o755 });
  return { binary, readCall: async () => JSON.parse(await fs.readFile(log, 'utf8')) };
};

const controlFor = (binary) => createChromeControl({
  resolve: () => binary,
  chromePath: '/fake/Chrome',
  exists: () => true,
});

describe('chromeSessionName', () => {
  it('prefixes and keeps only safe characters', () => {
    expect(chromeSessionName('ses_ab12')).toBe('mc-ses_ab12');
    expect(chromeSessionName('ses/../x y')).toBe('mc-sesxy');
  });
});

describe('createChromeControl.run', () => {
  it('always passes session, profile and json, and the Chrome path', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: { url: 'https://example.com/' }, error: null });
    await controlFor(binary).run(['get', 'url'], { sessionName: 'mc-s1', profile: 'Profile 1', headed: false });
    const call = await readCall();
    expect(call.argv.slice(0, 5)).toEqual(['--session', 'mc-s1', '--profile', 'Profile 1', '--json']);
    expect(call.argv.slice(-2)).toEqual(['get', 'url']);
    expect(call.chrome).toBe('/fake/Chrome');
  });

  it('adds --headed only when asked', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: {}, error: null });
    await controlFor(binary).run(['read'], { sessionName: 'mc-s1', profile: 'Default', headed: true });
    expect((await readCall()).argv).toContain('--headed');
  });

  it('returns data without the lifecycle block', async () => {
    const { binary } = await fakeBinary({ success: true, data: { url: 'u', lifecycle: { reused: true } }, error: null });
    await expect(controlFor(binary).run(['get', 'url'], { sessionName: 's', profile: 'Default' })).resolves.toEqual({ url: 'u' });
  });

  it('rejects with agent-browser\'s own message when success is false, even on exit 0', async () => {
    const { binary } = await fakeBinary({ success: false, data: null, error: 'Unknown ref: e99' });
    await expect(controlFor(binary).run(['click', '@e99'], { sessionName: 's', profile: 'Default' })).rejects.toThrow('Unknown ref: e99');
  });

  it('keeps a value with spaces and quotes as one argument', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: {}, error: null });
    await controlFor(binary).run(['fill', '@e3', 'a "quoted" value; rm -rf /'], { sessionName: 's', profile: 'Default' });
    expect((await readCall()).argv.slice(-3)).toEqual(['fill', '@e3', 'a "quoted" value; rm -rf /']);
  });
});

describe('createChromeControl namespace', () => {
  it('keeps MittrCraft\'s sessions in their own namespace so close --all never touches the user\'s', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: {}, error: null });
    await controlFor(binary).closeAll();
    const call = await readCall();
    expect(call.argv).toEqual(['--json', 'close', '--all']);
    expect(call.namespace).toBe('mittrcraft');
  });
});

describe('createChromeControl banner', () => {
  it('marks every page as agent-controlled when the window is shown', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: {}, error: null });
    await controlFor(binary).run(['open', 'https://example.com'], { sessionName: 's', profile: 'Default', headed: true });
    const { argv } = await readCall();
    const index = argv.indexOf('--init-script');
    expect(index).toBeGreaterThan(-1);
    const script = await fs.readFile(argv[index + 1], 'utf8');
    expect(script).toContain('MittrCraft agent');
    expect(script).toContain('pointer-events');
    expect(script).toContain('aria-hidden');
  });

  it('adds nothing to pages nobody is watching', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: {}, error: null });
    await controlFor(binary).run(['open', 'https://example.com'], { sessionName: 's', profile: 'Default', headed: false });
    expect((await readCall()).argv).not.toContain('--init-script');
  });
});

describe('createChromeControl availability', () => {
  it('is unavailable when no binary resolves', () => {
    expect(createChromeControl({ resolve: () => null }).available).toBe(false);
  });

  it('reports Chrome as missing when the executable does not exist', () => {
    const control = createChromeControl({ resolve: () => '/bin/true', chromePath: '/nope', exists: (p) => p !== '/nope' });
    expect(control.chromeInstalled()).toBe(false);
  });
});

describe('createChromeControl.profiles', () => {
  it('lists profiles without a session or profile flag', async () => {
    const { binary, readCall } = await fakeBinary({ success: true, data: [{ directory: 'Default', name: 'Your Chrome' }] });
    await expect(controlFor(binary).profiles()).resolves.toEqual([{ directory: 'Default', name: 'Your Chrome' }]);
    expect((await readCall()).argv).toEqual(['--json', 'profiles']);
  });
});
