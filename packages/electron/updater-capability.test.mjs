import assert from 'node:assert/strict';
import test from 'node:test';

import { assertUpdaterCapability, updateCheckWithoutFeed } from './updater-capability.mjs';

test('preserves updater behavior outside packaged Linux', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'darwin', packaged: true }));
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'win32', packaged: true }));
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'linux', packaged: false }));
});

test('rejects packaged Linux execution outside an AppImage', () => {
  assert.throws(
    () => assertUpdaterCapability({ platform: 'linux', packaged: true, appImagePath: '' }),
    /Start OpenChamber from its \.AppImage file/,
  );
});

test('rejects missing and non-writable AppImages with actionable errors', () => {
  assert.throws(
    () => assertUpdaterCapability({
      platform: 'linux',
      packaged: true,
      appImagePath: '/opt/OpenChamber.AppImage',
      stat: () => { throw new Error('missing'); },
    }),
    /cannot be found.*valid \.AppImage file/,
  );
  assert.throws(
    () => assertUpdaterCapability({
      platform: 'linux',
      packaged: true,
      appImagePath: '/opt/OpenChamber.AppImage',
      stat: () => ({ isFile: () => true }),
      access: () => { throw new Error('read-only'); },
    }),
    /not writable.*grant write permission/,
  );
});

test('accepts a writable packaged AppImage', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({
    platform: 'linux',
    packaged: true,
    appImagePath: '/home/user/OpenChamber.AppImage',
    stat: () => ({ isFile: () => true }),
    access: () => {},
  }));
});

test('updater is unavailable when product.updaterFeed is null', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.throws(
      () => assertUpdaterCapability({ platform, packaged: true, updaterFeed: null }),
      /not available in this build/,
    );
  }
});

test('updater stays available for a product that declares a feed', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({
    platform: 'darwin',
    packaged: true,
    updaterFeed: { provider: 'generic', url: 'https://updates.example.test/' },
  }));
});

test('a check without a feed answers that updates are off, not that the app is up to date', () => {
  assert.deepEqual(updateCheckWithoutFeed({ updaterFeed: null, currentVersion: '2.1.1+acme.1' }), {
    available: false,
    updatesDisabled: true,
    currentVersion: '2.1.1+acme.1',
    version: null,
    body: null,
    date: null,
  });
});

test('a check with a feed runs as before', () => {
  assert.equal(updateCheckWithoutFeed({ currentVersion: '2.1.1' }), null);
  assert.equal(updateCheckWithoutFeed({ updaterFeed: { provider: 'generic', url: 'https://updates.example.test/' }, currentVersion: '2.1.1' }), null);
});
