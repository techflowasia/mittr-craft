import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopHostsForSender, resolveSavedDesktopHost, probeSavedDesktopHost, savedDesktopHostNavigationUrl } from './desktop-host-access.mjs';

const host = { id: 'remote', label: 'Remote', url: 'https://user:password@example.test/app?opaque=secret#secret', apiUrl: 'https://example.test?custom=secret', clientToken: 'saved-token', requestHeaders: { Cookie: 'saved-cookie' }, relay: { serverId: 'server', grant: 'secret' }, futureSecret: 'secret' };
const config = { hosts: [host], defaultHostId: 'remote', initialHostChoiceCompleted: true, futureSecret: 'secret' };

test('remote reads are allowlisted metadata, including URL and unknown-field disclosure', () => {
  const result = desktopHostsForSender(config, 'http://127.0.0.1:3901', false);
  assert.deepEqual(result, {
    access: 'metadata',
    hosts: [{ id: 'remote', label: 'Remote', url: 'https://example.test/app', apiUrl: 'https://example.test/', access: 'metadata', hasRelay: true }],
    defaultHostId: 'remote', initialHostChoiceCompleted: true, localOrigin: 'http://127.0.0.1:3901/',
  });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(host.clientToken, 'saved-token');
});

test('local reads retain the complete configuration', () => {
  assert.deepEqual(desktopHostsForSender(config, null, true), { ...config, localOrigin: null, access: 'full' });
});

test('saved probes resolve credentials and target together, ignoring renderer extras', async () => {
  const selected = resolveSavedDesktopHost(config, 'remote', 'http://localhost:3901', 'local-token');
  const calls = [];
  const result = await probeSavedDesktopHost(selected, async (...args) => { calls.push(args); return { status: 'ok', latencyMs: 4 }; });
  assert.deepEqual(result, { status: 'ok', latencyMs: 4 });
  assert.deepEqual(calls, [[host.apiUrl, 2000, 'saved-token', host.requestHeaders, 'server']]);
  assert.throws(() => resolveSavedDesktopHost(config, 'missing', '', ''), /Host not found/);
  assert.throws(() => resolveSavedDesktopHost(config, {}, '', ''), /Host id/);
});

test('local saved probe uses local credentials', async () => {
  const selected = resolveSavedDesktopHost(config, 'local', 'http://localhost:3901', 'local-token');
  await probeSavedDesktopHost(selected, async (url, timeout, token, headers) => {
    assert.equal(url, 'http://localhost:3901');
    assert.equal(token, 'local-token');
    assert.deepEqual(headers, {});
    return { status: 'auth', latencyMs: 1 };
  });
});

test('relay status is explicitly unavailable natively, never fabricated auth failure', async () => {
  assert.deepEqual(await probeSavedDesktopHost({ ...host, apiUrl: undefined }, () => { throw new Error('must not probe display URL'); }), { status: 'relay-unavailable', latencyMs: 0 });
  assert.deepEqual(await probeSavedDesktopHost(host, async () => ({ status: 'unreachable', latencyMs: 5 })), { status: 'relay-unavailable', latencyMs: 5 });
});

test('switch navigation always loads trusted local UI and contains only the host id', () => {
  for (const ui of ['mittrcraft-ui://app/index.html', 'http://127.0.0.1:5173/']) {
    const target = new URL(savedDesktopHostNavigationUrl(ui, 'remote&target=evil'));
    assert.equal(target.origin, new URL(ui).origin);
    assert.equal(target.searchParams.get('desktopHostId'), 'remote&target=evil');
    assert.equal(target.searchParams.size, 1);
    assert.equal(target.toString().includes('saved-token'), false);
  }
  assert.throws(() => savedDesktopHostNavigationUrl('', 'remote'), /Local UI/);
});
