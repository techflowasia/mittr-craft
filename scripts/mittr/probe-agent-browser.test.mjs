import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { CHROME_FLAGS, chromeArgs, exposedListeners, installStopHandlers, pathsUnder, peersOf, sandboxProfile, sweepTargets, upgradeRefused } from './probe-agent-browser.mjs';

const lsof = [
  'COMMAND     PID     USER   FD     TYPE DEVICE SIZE/OFF     NODE NAME',
  'Google    41001 techflow  txt      REG   1,17   123456 99 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'Google    41001 techflow   12r     REG   1,17     2048 77 /Users/someone/Library/Application Support/Google/Chrome/Local State',
  'Google    41001 techflow   13u     REG   1,17     4096 78 /Users/someone/Library/Application Support/Google/Chrome',
  'Google    41001 techflow   14u     REG   1,17     4096 79 /Users/someone/Library/Application Support/Google/Chrome Canary/Local State',
  'Google    41001 techflow   15u     REG   1,17     4096 80 /private/tmp/p4.abcd/Library/Application Support/Google/Chrome/Default/Cookies',
  'agent-br  41000 techflow   16u    IPv4 0x1      0t0  TCP 127.0.0.1:53111->127.0.0.1:9222 (ESTABLISHED)',
  'agent-br  41000 techflow   17u    IPv4 0x2      0t0  TCP 127.0.0.1:53999 (LISTEN)',
  'Google    41001 techflow   18u    IPv4 0x3      0t0  TCP 192.168.1.5:50000->142.250.1.1:443 (ESTABLISHED)',
  'Google    41001 techflow   19u    IPv6 0x4      0t0  TCP [::1]:9222 (LISTEN)',
  'Google    41001 techflow   20u    IPv4 0x5      0t0  TCP *:7000 (LISTEN)',
  'Google    41001 techflow   21u    IPv4 0x6      0t0  UDP *:5353',
].join('\n');

test('pathsUnder keeps only lines under the root', () => {
  assert.deepEqual(pathsUnder(lsof, '/Users/someone/Library/Application Support/Google/Chrome'), [
    '/Users/someone/Library/Application Support/Google/Chrome/Local State',
    '/Users/someone/Library/Application Support/Google/Chrome',
  ]);
  assert.deepEqual(pathsUnder(lsof, '/Users/nobody/Library'), []);
});

test('peersOf drops loopback', () => {
  assert.deepEqual(peersOf(lsof), ['142.250.1.1:443']);
});

test('a listener on every interface or a non-loopback address is exposed, a loopback one is not', () => {
  assert.deepEqual(exposedListeners(lsof), ['*:7000', '*:5353']);
  assert.deepEqual(exposedListeners('x 1 u 3u IPv4 0x1 0t0 TCP 10.0.0.2:8080 (LISTEN)'), ['10.0.0.2:8080']);
  assert.deepEqual(exposedListeners('x 1 u 3u IPv4 0x1 0t0 TCP 127.0.0.1:8080 (LISTEN)\nx 1 u 4u IPv6 0x1 0t0 TCP [::1]:8081 (LISTEN)'), []);
});

test('a WebSocket upgrade counts as refused unless the server switches protocols', () => {
  assert.equal(upgradeRefused('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'), false);
  assert.equal(upgradeRefused('HTTP/1.1 403 Forbidden\r\n\r\n'), true);
  assert.equal(upgradeRefused(''), true);
});

test('the sandbox denies the real Chrome, Google preference and cache folders and the real agent-browser folder', () => {
  const profile = sandboxProfile('/Users/someone');
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n/);
  for (const denied of [
    '(deny file-read* file-write* (subpath "/Users/someone/Library/Application Support/Google"))',
    '(deny file-read* file-write* (regex #"^/Users/someone/Library/Preferences/com\\.google\\."))',
    '(deny file-read* file-write* (subpath "/Users/someone/Library/Caches/Google"))',
    '(deny file-read* file-write* (subpath "/Users/someone/.agent-browser"))',
  ]) assert.ok(profile.includes(denied), denied);
});

test('Chrome gets the keychain-free and quiet-network flags, one per line and with no comma inside one', () => {
  assert.deepEqual(CHROME_FLAGS, [
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-first-run',
    '--metrics-recording-only',
    '--disable-features=MediaRouter',
    '--no-default-browser-check',
  ]);
  assert.equal(CHROME_FLAGS.some((flag) => flag.includes(',')), false);
});

test('every Chrome launch goes through the refusing loopback proxy, as a flag with no comma', () => {
  const args = chromeArgs(51234);
  assert.deepEqual(args.slice(0, CHROME_FLAGS.length), CHROME_FLAGS);
  assert.equal(args.at(-1), '--proxy-server=127.0.0.1:51234');
  assert.equal(args.some((flag) => flag.includes(',')), false);
});

test('SIGINT and SIGTERM run the clean-up once, then exit with the signal code', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const target = new EventEmitter();
    const calls = [];
    const exited = new Promise((resolve) => {
      installStopHandlers({ target, cleanup: async (received) => { calls.push(received); }, exit: resolve });
    });
    target.emit(signal, signal);
    target.emit(signal, signal);
    assert.equal(await exited, code);
    assert.deepEqual(calls, [signal]);
  }
});

test('a clean-up that fails still exits, and the handlers can be removed', async () => {
  const target = new EventEmitter();
  const exited = new Promise((resolve) => {
    installStopHandlers({ target, cleanup: async () => { throw new Error('close failed'); }, exit: resolve });
  });
  target.emit('SIGTERM', 'SIGTERM');
  assert.equal(await exited, 143);
  const other = new EventEmitter();
  const remove = installStopHandlers({ target: other, cleanup: async () => {}, exit: () => {} });
  assert.equal(other.listenerCount('SIGINT'), 1);
  remove();
  assert.equal(other.listenerCount('SIGINT') + other.listenerCount('SIGTERM'), 0);
});

test('the survivor sweep targets only this run\'s live groups, their descendants and its own temp root', () => {
  const root = '/private/var/folders/xy/T/p4ab.MINE';
  const staged = '/repo/packages/electron/.product/agent-browser/agent-browser';
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const table = [
    { pid: 10, ppid: 1, command: 'node probe-agent-browser.mjs' },
    { pid: 20, ppid: 10, command: `${staged} open http://127.0.0.1:5000/` },
    { pid: 21, ppid: 20, command: `${staged}` },
    { pid: 30, ppid: 1, command: `${chrome} --user-data-dir=${root}/tmp/agent-browser-profile-1` },
    { pid: 31, ppid: 30, command: `${chrome} Helper --type=renderer` },
    { pid: 40, ppid: 1, command: `${staged}` },
    { pid: 50, ppid: 1, command: `${chrome} --user-data-dir=/private/var/folders/xy/T/p4ab.OTHER/tmp/agent-browser-profile-2` },
    { pid: 51, ppid: 50, command: `${chrome} Helper --type=renderer` },
    { pid: 60, ppid: 1, command: chrome },
    { pid: 61, ppid: 60, command: `${chrome} Helper --type=gpu-process` },
  ];
  const targets = sweepTargets(table, { liveGroups: new Set([20]), root, self: 10 }).map((row) => row.pid).sort((a, b) => a - b);
  assert.deepEqual(targets, [20, 21, 30, 31]);
  assert.deepEqual(sweepTargets(table, { liveGroups: new Set(), root: '/private/var/folders/xy/T/p4ab.NONE', self: 10 }), []);
});
