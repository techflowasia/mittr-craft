import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeepLinkRegistry } from './deep-link-registry.mjs';

const authLink = { type: 'auth', value: 'callback', raw: 'acme-dev://auth/callback?code=c' };

test('a registered host handles its link and asks for an event', async () => {
  const emitted = [];
  const registry = createDeepLinkRegistry({ onEmit: (event) => emitted.push(event) });
  const seen = [];
  registry.register({
    host: 'auth',
    handle: async (link) => {
      seen.push(link.raw);
      return { emit: 'plugin:auth-changed' };
    },
  });
  assert.equal(await registry.dispatch(authLink), true);
  assert.deepEqual(seen, [authLink.raw]);
  assert.deepEqual(emitted, ['plugin:auth-changed']);
});

test('a handler that returns nothing is handled and emits nothing', async () => {
  const emitted = [];
  const registry = createDeepLinkRegistry({ onEmit: (event) => emitted.push(event) });
  registry.register({ host: 'auth', handle: () => {} });
  assert.equal(await registry.dispatch(authLink), true);
  assert.deepEqual(emitted, []);
});

test('an emit name that is not a non-empty string is ignored', async () => {
  const emitted = [];
  const registry = createDeepLinkRegistry({ onEmit: (event) => emitted.push(event) });
  registry.register({ host: 'auth', handle: () => ({ emit: 42 }) });
  assert.equal(await registry.dispatch(authLink), true);
  assert.deepEqual(emitted, []);
});

test('an unregistered host falls through to upstream dispatch', async () => {
  const registry = createDeepLinkRegistry();
  registry.register({ host: 'auth', handle: () => {} });
  assert.equal(await registry.dispatch({ type: 'other', value: '', raw: 'x://other' }), false);
});

test('connect, focus, session and host links are never offered to registered handlers', () => {
  const registry = createDeepLinkRegistry();
  for (const host of ['connect', 'focus', 'session', 'host', 'Connect']) {
    assert.throws(() => registry.register({ host, handle: () => {} }), new RegExp(`deep-link host "${host}" belongs to the app`));
  }
});

test('unregister removes the handler', async () => {
  const registry = createDeepLinkRegistry();
  const unregister = registry.register({ host: 'auth', handle: () => ({ emit: 'e' }) });
  unregister();
  assert.equal(await registry.dispatch(authLink), false);
  registry.register({ host: 'auth', handle: () => {} });
  assert.equal(await registry.dispatch(authLink), true);
});

test('a stale unregister does not remove a handler registered after it', async () => {
  const emitted = [];
  const registry = createDeepLinkRegistry({ onEmit: (event) => emitted.push(event) });
  const stale = registry.register({ host: 'auth', handle: () => {} });
  stale();
  registry.register({ host: 'auth', handle: () => ({ emit: 'second' }) });
  stale();
  assert.equal(await registry.dispatch(authLink), true);
  assert.deepEqual(emitted, ['second']);
});

test('registering a host again replaces its handler, as when the server restarts in the same process', async () => {
  const emitted = [];
  const registry = createDeepLinkRegistry({ onEmit: (event) => emitted.push(event) });
  const first = registry.register({ host: 'auth', handle: () => ({ emit: 'first' }) });
  registry.register({ host: 'auth', handle: () => ({ emit: 'second' }) });
  await registry.dispatch(authLink);
  first();
  await registry.dispatch(authLink);
  assert.deepEqual(emitted, ['second', 'second']);
});

test('a registration needs a host and a handler', () => {
  const registry = createDeepLinkRegistry();
  assert.throws(() => registry.register({ host: '', handle: () => {} }), /host/);
  assert.throws(() => registry.register({ host: 'auth' }), /handle/);
  assert.throws(() => registry.register(), /host/);
});

test('a handler that throws still owns its link, and the failure goes to onError', async () => {
  const errors = [];
  const registry = createDeepLinkRegistry({ onError: (error, link) => errors.push([error.message, link.type]) });
  registry.register({ host: 'auth', handle: () => { throw new Error('boom'); } });
  assert.equal(await registry.dispatch(authLink), true);
  assert.deepEqual(errors, [['boom', 'auth']]);
});

test('host names match the way a URL hostname does, ignoring case', async () => {
  const registry = createDeepLinkRegistry();
  registry.register({ host: 'Auth', handle: () => {} });
  assert.equal(await registry.dispatch(authLink), true);
});
