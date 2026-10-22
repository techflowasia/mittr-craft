import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { listen, tempDataDir } from '../test-helpers.js';
import {
  COMMAND_TIMEOUT_MS,
  OUTPUT_MAX_BYTES,
  URL_TIMEOUT_MS,
  commandEnv,
  createUrlSource,
  extractValue,
  isRefusedAddress,
  runCommand,
} from './widget-sources.js';

const SHELL_OWN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

const envOf = (text) => Object.fromEntries(text.split('\n').filter(Boolean).map((line) => {
  const at = line.indexOf('=');
  return [line.slice(0, at), line.slice(at + 1)];
}));

test('a command gets 20 seconds and 64 KB of output', () => {
  assert.equal(COMMAND_TIMEOUT_MS, 20_000);
  assert.equal(URL_TIMEOUT_MS, 20_000);
  assert.equal(OUTPUT_MAX_BYTES, 64 * 1024);
});

test('a command runs with PATH, HOME and LANG only, so no token reaches it', async (t) => {
  const cwd = tempDataDir(t);
  const env = { PATH: process.env.PATH, HOME: '/Users/acme', LANG: 'en_US.UTF-8', MITTRCRAFT_TOOLS_TOKEN: 'secret-token', OPENAI_API_KEY: 'sk-acme', USER: 'acme' };
  assert.deepEqual(commandEnv(env), { PATH: process.env.PATH, HOME: '/Users/acme', LANG: 'en_US.UTF-8' });

  const { text } = await runCommand({ command: '/usr/bin/env', cwd }, { env });
  const seen = envOf(text);
  assert.deepEqual(Object.keys(seen).filter((name) => !SHELL_OWN.has(name)).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(seen.HOME, '/Users/acme');
  assert.ok(!text.includes('secret-token') && !text.includes('sk-acme'));
});

test('a command runs in its folder', async (t) => {
  const cwd = fs.realpathSync(tempDataDir(t));
  const { text } = await runCommand({ command: 'pwd -P', cwd });
  assert.equal(text.trim(), cwd);
});

test('a command that runs too long is stopped, with its children', async (t) => {
  const cwd = tempDataDir(t);
  const started = Date.now();
  await assert.rejects(runCommand({ command: 'sleep 30 | cat', cwd }, { timeoutMs: 200 }), /took longer than/);
  assert.ok(Date.now() - started < 5_000);
});

test('output past 64 KB is cut there and the command stopped', async (t) => {
  const cwd = tempDataDir(t);
  const { text, truncated } = await runCommand({ command: 'yes 0123456789', cwd });
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text) <= OUTPUT_MAX_BYTES);
  assert.ok(Buffer.byteLength(text) > OUTPUT_MAX_BYTES - 32);
});

test('a command that fails says its exit code and the first line it wrote to stderr', async (t) => {
  const cwd = tempDataDir(t);
  await assert.rejects(runCommand({ command: 'echo nope >&2; exit 3', cwd }), /ended with code 3: nope/);
  await assert.rejects(runCommand({ command: 'true', cwd: `${cwd}/missing` }), /folder .* is not there/);
});

test('a cancelled command stops', async (t) => {
  const cwd = tempDataDir(t);
  const controller = new AbortController();
  const running = runCommand({ command: 'sleep 30', cwd }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, /stopped/);
});

test('loopback, private, link-local and unspecified addresses are refused', () => {
  for (const address of ['127.0.0.1', '127.9.9.9', '::1', '::', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'localhost', 'api.localhost', '224.0.0.1']) {
    assert.equal(isRefusedAddress(address), true, address);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '172.32.0.1']) {
    assert.equal(isRefusedAddress(address), false, address);
  }
});

const refusedUrl = async (source, url) => {
  await assert.rejects(source({ url }), (error) => /not fetched/.test(error.message), url);
};

test('a URL to this Mac, a private network or the server\'s own port is refused before anything is sent', async () => {
  const asked = [];
  const answers = {
    'own.example.test': [{ address: '127.0.0.1', family: 4 }],
    'lan.example.test': [{ address: '10.0.0.5', family: 4 }],
    'mixed.example.test': [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.2', family: 4 }],
    'rebind.example.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
  };
  const lookup = async (host) => {
    asked.push(host);
    return answers[host] ?? [];
  };
  const source = createUrlSource({ ownPorts: () => [4100], lookup });

  for (const url of [
    'http://127.0.0.1:4100/api/mittr/widgets',
    'http://localhost:8080/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0/',
    'http://192.168.1.10/status',
    'http://169.254.169.254/latest/meta-data/',
    'http://own.example.test:4100/',
    'http://own.example.test/',
    'http://lan.example.test/',
    'http://mixed.example.test/',
    'http://rebind.example.test/',
    'http://nothing.example.test/',
  ]) {
    await refusedUrl(source, url);
  }
  await assert.rejects(source({ url: 'file:///etc/passwd' }), /http/);
  await assert.rejects(source({ url: 'http://user:pw@status.example.test/' }), /sign-in/);
});

test('a URL is fetched with no cookie and no credentials, and the answer is capped', async (t) => {
  const seen = [];
  const base = await listen(t, (req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/big') {
      res.end('x'.repeat(OUTPUT_MAX_BYTES * 2));
      return;
    }
    res.setHeader('set-cookie', 'session=abc');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ build: { status: 'SUCCESS' } }));
  });
  const source = createUrlSource({ ownPorts: () => [], refused: () => false });

  const first = await source({ url: `${base}/job` });
  assert.equal(JSON.parse(first.text).build.status, 'SUCCESS');
  await source({ url: `${base}/job` });
  const big = await source({ url: `${base}/big` });

  assert.equal(big.truncated, true);
  assert.equal(Buffer.byteLength(big.text), OUTPUT_MAX_BYTES);
  assert.equal(seen.length, 3);
  for (const { headers } of seen) {
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.deepEqual(Object.keys(headers).sort(), ['accept', 'connection', 'host', 'user-agent']);
  }
});

test('a redirect goes through the same fence', async (t) => {
  const base = await listen(t, (req, res) => {
    res.statusCode = 302;
    res.setHeader('location', req.url === '/out' ? 'http://10.0.0.7/admin' : '/out');
    res.end();
  });
  const source = createUrlSource({ ownPorts: () => [], refused: (address) => address !== '127.0.0.1' });
  await assert.rejects(source({ url: `${base}/start` }), /not fetched/);
});

test('an answer that is not 2xx is an error with its status', async (t) => {
  const base = await listen(t, (_req, res) => {
    res.statusCode = 503;
    res.end('busy');
  });
  const source = createUrlSource({ ownPorts: () => [], refused: () => false });
  await assert.rejects(source({ url: `${base}/` }), /answered 503/);
});

test('a JSON path picks the value, a pattern takes its group, and a missing match is an error', () => {
  const body = JSON.stringify({ build: { status: 'SUCCESS', runs: [{ ms: 1200 }, { ms: 900 }] }, price: '11,320.50', items: ['a', 'b', 'c', 'd', 'e', 'f'] });

  assert.deepEqual(extractValue(body, { json: 'build.runs[1].ms' }, 'number'), { value: 900 });
  assert.deepEqual(extractValue(body, { json: '$.price' }, 'number'), { value: 11320.5 });
  assert.deepEqual(extractValue(body, { json: 'items' }, 'list'), { value: ['a', 'b', 'c', 'd', 'e'] });
  assert.deepEqual(extractValue(body, { json: 'build.status', status: { ok: ['SUCCESS'], fail: ['FAILURE'] } }, 'status'), { value: 'ok' });
  assert.deepEqual(extractValue('Price: THB 11,480 today', { regex: 'THB ([0-9,]+)' }, 'number'), { value: 11480 });
  assert.deepEqual(extractValue('state=warn', { regex: 'state=(\\w+)' }, 'status'), { value: 'warn' });
  assert.deepEqual(extractValue(' 42 \n', {}, 'number'), { value: 42 });
  assert.deepEqual(extractValue('one\n\n two\nthree\n', {}, 'list'), { value: ['one', 'two', 'three'] });

  assert.match(extractValue(body, { json: 'build.missing' }, 'number').error, /Nothing at build.missing/);
  assert.match(extractValue('not json', { json: 'a' }, 'number').error, /not JSON/);
  assert.match(extractValue('Price: soon', { regex: 'THB ([0-9,]+)' }, 'number').error, /found nothing/);
  assert.match(extractValue('hello', {}, 'number').error, /not a number/);
  assert.match(extractValue('UNSTABLE', {}, 'status').error, /not a status/);
});

test('a pattern that takes too long is stopped and reads as an error', () => {
  const started = Date.now();
  assert.match(extractValue(`${'a'.repeat(40)}b`, { regex: '^(a+)+$' }, 'number').error, /took too long/);
  assert.ok(Date.now() - started < 2_000);
});
