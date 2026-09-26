import assert from 'node:assert/strict';
import test from 'node:test';
import { flavorEnvironment, resolveAppFlavor } from './app-flavor.mjs';

test('an unset flavor is the production app, unchanged', () => {
  const flavor = resolveAppFlavor(undefined);
  assert.equal(flavor.appId, 'dev.mittrcraft.desktop');
  assert.equal(flavor.productName, 'MittrCraft');
  assert.equal(flavor.protocol, 'mittrcraft');
  assert.equal(flavor.updates, true);
  assert.equal(flavor.desktopPort, 57123);
  assert.deepEqual(flavorEnvironment(flavor, '/home/u'), {});
});

test('the dev flavor is a separate app that installs beside production', () => {
  const dev = resolveAppFlavor('dev');
  const production = resolveAppFlavor('production');
  assert.notEqual(dev.appId, production.appId);
  assert.notEqual(dev.productName, production.productName);
  assert.notEqual(dev.protocol, production.protocol);
  assert.equal(dev.updates, false);
  assert.notEqual(dev.desktopPort, production.desktopPort);
});

test('the dev flavor keeps its data, engine and sign-in link apart from production', () => {
  assert.deepEqual(flavorEnvironment(resolveAppFlavor('dev'), '/home/u'), {
    MITTRCRAFT_DATA_DIR: '/home/u/.config/mittrcraft-dev',
    MITTRCRAFT_ENGINE_HOME: '/home/u/.config/mittrcraft-dev/engine',
    MITTRCRAFT_DEEP_LINK_SCHEME: 'mittrcraft-dev',
  });
});

test('an unknown flavor fails the build instead of shipping the production identity', () => {
  assert.throws(() => resolveAppFlavor('staging'), /Unknown MittrCraft app flavor "staging"/);
});
