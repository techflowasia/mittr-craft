import assert from 'node:assert/strict';
import test from 'node:test';

import { readProduct, UPSTREAM_PRODUCT } from './product.mjs';
import {
  CANARY_MIRROR_UPDATER_FEED,
  CANARY_UPDATER_FEED,
  MIRROR_FAILURE_BACKOFF_MS,
  PRODUCTION_UPDATER_FEED,
  STABLE_MIRROR_UPDATER_FEED,
  pickUpdaterSource,
  isCanaryVersion,
  isUpdateChannel,
  normalizeUpdateChannel,
  parseLoopbackUpdaterUrl,
  resolveUpdaterFeed,
} from './updater-feed.mjs';

const overrideEnvironment = {
  OPENCHAMBER_E2E: '1',
  OPENCHAMBER_UPDATER_E2E_URL: 'http://127.0.0.1:49152/updates/',
};

test('production updater feed is immutable GitHub configuration', () => {
  assert.equal(Object.isFrozen(PRODUCTION_UPDATER_FEED), true);
  assert.deepEqual(PRODUCTION_UPDATER_FEED, {
    provider: 'github',
    owner: 'openchamber',
    repo: 'openchamber',
  });
});

test('the Canary channel reads the canary pre-release; on a release build every other stored value is Stable', () => {
  assert.equal(resolveUpdaterFeed({ channel: 'canary' }), CANARY_UPDATER_FEED);
  assert.equal(CANARY_UPDATER_FEED.url, 'https://github.com/openchamber/openchamber/releases/download/canary/');
  assert.equal(resolveUpdaterFeed({ channel: 'stable' }), PRODUCTION_UPDATER_FEED);
  assert.equal(normalizeUpdateChannel('canary', '2.6.1'), 'canary');
  for (const value of ['stable', undefined, null, 'beta', 'Canary', 1]) assert.equal(normalizeUpdateChannel(value, '2.6.1'), 'stable');
  assert.deepEqual(['stable', 'canary', 'beta', undefined].map(isUpdateChannel), [true, true, false, false]);
  // The loopback feed wins on either channel.
  assert.equal(resolveUpdaterFeed({ environment: overrideEnvironment, testBuild: true, channel: 'canary' }).url, overrideEnvironment.OPENCHAMBER_UPDATER_E2E_URL);
});

test('a Canary build nobody picked a channel for stays on Canary; a stored pick wins', () => {
  const canaryBuild = '2.6.2-canary.20261105.7';
  for (const value of [undefined, null, 'beta']) assert.equal(normalizeUpdateChannel(value, canaryBuild), 'canary');
  assert.equal(normalizeUpdateChannel('stable', canaryBuild), 'stable');
});

test('a Canary build is told by the canary pre-release part of its version', () => {
  assert.equal(isCanaryVersion('2.5.4-canary.20261030.123'), true);
  for (const version of ['2.5.4', '2.5.4-beta.1', 'canary', undefined]) assert.equal(isCanaryVersion(version), false);
});

test('requires the complete E2E environment and embedded build-marker conjunction', () => {
  const cases = [
    {},
    { environment: overrideEnvironment },
    { environment: { OPENCHAMBER_E2E: '1' }, testBuild: true },
    {
      environment: { OPENCHAMBER_UPDATER_E2E_URL: overrideEnvironment.OPENCHAMBER_UPDATER_E2E_URL },
      testBuild: true,
    },
    { environment: overrideEnvironment, testBuild: false },
  ];
  for (const input of cases) assert.equal(resolveUpdaterFeed(input), PRODUCTION_UPDATER_FEED);
});

test('accepts only credential-free loopback HTTP(S) URLs', () => {
  assert.equal(parseLoopbackUpdaterUrl('http://127.0.0.1:8080/feed'), 'http://127.0.0.1:8080/feed');
  assert.equal(parseLoopbackUpdaterUrl('https://127.255.0.1/feed/'), 'https://127.255.0.1/feed/');
  assert.equal(parseLoopbackUpdaterUrl('http://[::1]:8080/feed'), 'http://[::1]:8080/feed');

  for (const value of [
    'http://localhost:8080/feed',
    'http://0.0.0.0:8080/feed',
    'http://192.168.1.5:8080/feed',
    'https://example.com/feed',
    'file:///tmp/feed',
    'ftp://127.0.0.1/feed',
    'http://user:secret@127.0.0.1/feed',
    'http://127.0.0.1/feed?token=secret',
    'http://127.0.0.1/feed#fragment',
    'not-a-url',
  ]) assert.equal(parseLoopbackUpdaterUrl(value), null, value);
});

test('uses a generic feed only when every test-only gate is valid', () => {
  assert.deepEqual(resolveUpdaterFeed({
    environment: overrideEnvironment,
    testBuild: true,
  }), {
    provider: 'generic',
    url: 'http://127.0.0.1:49152/updates/',
  });
});

test('invalid URLs fall back to the production feed even with both test gates', () => {
  for (const url of ['https://example.com/feed', 'http://localhost/feed', '']) {
    assert.equal(resolveUpdaterFeed({
      environment: { ...overrideEnvironment, OPENCHAMBER_UPDATER_E2E_URL: url },
      testBuild: true,
    }), PRODUCTION_UPDATER_FEED);
  }
});

test('both channels read the mirror, and GitHub for an hour after the mirror failed', () => {
  const now = 10 * MIRROR_FAILURE_BACKOFF_MS;
  assert.equal(pickUpdaterSource({ now }), 'mirror');
  assert.equal(pickUpdaterSource({ mirrorFailedAt: now - 1000, now }), 'github');
  assert.equal(pickUpdaterSource({ mirrorFailedAt: now - MIRROR_FAILURE_BACKOFF_MS, now }), 'mirror');
  assert.equal(resolveUpdaterFeed({ channel: 'stable', source: 'mirror' }), STABLE_MIRROR_UPDATER_FEED);
  assert.equal(resolveUpdaterFeed({ channel: 'canary', source: 'mirror' }), CANARY_MIRROR_UPDATER_FEED);
  assert.equal(resolveUpdaterFeed({ channel: 'stable', source: 'github' }), PRODUCTION_UPDATER_FEED);
  assert.equal(resolveUpdaterFeed({ channel: 'canary', source: 'github' }), CANARY_UPDATER_FEED);
  assert.equal(STABLE_MIRROR_UPDATER_FEED.url, 'https://downloads.openchamber.dev/desktop/stable/');
  assert.equal(CANARY_MIRROR_UPDATER_FEED.url, 'https://downloads.openchamber.dev/desktop/canary/');
  assert.equal(resolveUpdaterFeed({ environment: overrideEnvironment, testBuild: true, channel: 'stable', source: 'mirror' }).url, overrideEnvironment.OPENCHAMBER_UPDATER_E2E_URL);
});

test('a product without an updater feed resolves to no feed', () => {
  assert.equal(resolveUpdaterFeed({ productionFeed: null }), null);
  assert.equal(
    resolveUpdaterFeed({ productionFeed: null, environment: overrideEnvironment }),
    null,
  );
  assert.equal(resolveUpdaterFeed({ productionFeed: null, channel: 'canary', source: 'mirror' }), null);
});

test('a product feed replaces the default production feed on every channel and source', () => {
  const productionFeed = { provider: 'generic', url: 'https://updates.example.test/' };
  assert.equal(resolveUpdaterFeed({ productionFeed }), productionFeed);
  assert.equal(resolveUpdaterFeed({ productionFeed, channel: 'canary', source: 'mirror' }), productionFeed);
});

const missingProductFile = { readFileSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };

test('without a product.json the feeds follow the channel and source as upstream picks them', () => {
  const { updaterFeed: productionFeed } = readProduct({ appPath: '/app', fs: missingProductFile, homeDir: '/home/acme' });
  assert.notEqual(productionFeed, UPSTREAM_PRODUCT.updaterFeed);
  for (const channel of ['stable', 'canary']) {
    for (const source of ['github', 'mirror']) {
      assert.equal(resolveUpdaterFeed({ productionFeed, channel, source }), resolveUpdaterFeed({ channel, source }));
    }
  }
});

test('a product that turns updates off or brings its own feed replaces every channel', () => {
  const feed = { provider: 'generic', url: 'https://updates.example.test/' };
  const from = (updaterFeed) => readProduct({
    appPath: '/app',
    fs: { readFileSync: () => JSON.stringify({ updaterFeed }) },
    homeDir: '/home/acme',
  }).updaterFeed;
  for (const channel of ['stable', 'canary']) {
    for (const source of ['github', 'mirror']) {
      assert.equal(resolveUpdaterFeed({ productionFeed: from(null), channel, source }), null);
      const own = resolveUpdaterFeed({ productionFeed: from({ ...feed, owner: null, repo: null }), channel, source });
      assert.equal(own.url, feed.url);
    }
  }
});
