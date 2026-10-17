import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAccountStore } from './account-store.js';
import { ACCOUNTS_DAMAGED, REFRESH_MARGIN_MS, registerMittrAuthRoutes } from './auth-routes.js';
import { decrypt, deferred, encrypt, fakeFetch, json, serve, tempDataDir } from './test-helpers.js';

const NOW = 1_800_000_000_000;
const BROKER = { baseUrl: 'https://api-dev.mittr.asia', upstreamV1: 'https://api-dev.mittr.asia/v1', fixed: false };
const DEV_CALLBACK = 'mittrcraft-dev://auth/callback';

const sessionFor = (userId, displayName, over = {}) => ({
  accessToken: `at-${userId}`,
  refreshToken: 'r1',
  expiresAt: NOW + 3_600_000,
  subject: { userId, displayName },
  ...over,
});

const harness = async (t, { fetchImpl = fakeFetch(), sessions = [], signInRefusal, onSignIn, onAccountChange, storeOptions = {} } = {}) => {
  const dataDir = tempDataDir(t);
  const store = createAccountStore({ dataDir, encrypt, decrypt, sharedHistoryExists: () => false, ...storeOptions });
  for (const session of sessions) store.write(session);
  const clock = { now: NOW };
  const app = express();
  const auth = registerMittrAuthRoutes(app, {
    express,
    broker: BROKER,
    store,
    scheme: 'mittrcraft-dev',
    fetchImpl,
    now: () => clock.now,
    signInRefusal: typeof signInRefusal === 'string' ? () => signInRefusal : signInRefusal,
    onSignIn,
    onAccountChange,
  });
  return { auth, store, clock, fetchImpl, dataDir, call: await serve(t, app) };
};

const startSignIn = async (call) => {
  const { status, body } = await call('POST', '/api/mittr/auth/start');
  assert.equal(status, 200);
  return new URL(body.authorizeUrl);
};

test('start returns the platform authorize URL', async (t) => {
  const { call } = await harness(t);
  const { body } = await call('POST', '/api/mittr/auth/start');
  assert.ok(body.authorizeUrl.startsWith('https://api-dev.mittr.asia/auth/desktop/start?code_challenge='), body.authorizeUrl);
  assert.ok(body.authorizeUrl.includes('redirect_uri=mittrcraft-dev%3A%2F%2Fauth%2Fcallback'), body.authorizeUrl);
  assert.equal(new URL(body.authorizeUrl).searchParams.get('state'), null);
});

test('callback exchanges once and stores the session', async (t) => {
  const fetchImpl = fakeFetch(() => json(sessionFor('u-a', 'A')));
  const signIns = [];
  const { call } = await harness(t, { fetchImpl, onSignIn: () => signIns.push('sync') });
  const authorize = await startSignIn(call);

  const { status, body } = await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });

  assert.equal(status, 200);
  assert.deepEqual(body, { signedIn: true, userId: 'u-a', displayName: 'A' });
  assert.equal(fetchImpl.calls.length, 1);
  const [exchange] = fetchImpl.calls;
  assert.equal(exchange.url, 'https://api-dev.mittr.asia/auth/desktop/exchange');
  assert.equal(exchange.method, 'POST');
  assert.equal(
    crypto.createHash('sha256').update(exchange.body.code_verifier).digest('base64url'),
    authorize.searchParams.get('code_challenge'),
  );
  assert.deepEqual(exchange.body, { code: 'c1', code_verifier: exchange.body.code_verifier, redirect_uri: DEV_CALLBACK });
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
});

test('callback with no pending transaction is refused and nothing is exchanged', async (t) => {
  const { call, fetchImpl } = await harness(t);
  const { status, body } = await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'No sign-in is in progress' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('a second callback for a spent transaction is refused', async (t) => {
  const fetchImpl = fakeFetch(() => json(sessionFor('u-a', 'A')));
  const { call } = await harness(t, { fetchImpl });
  await startSignIn(call);
  assert.equal((await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` })).status, 200);
  const again = await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
  assert.equal(again.status, 400);
  assert.deepEqual(again.body, { error: 'No sign-in is in progress' });
  assert.equal(fetchImpl.calls.length, 1);
});

test('a rejected exchange still spends the transaction', async (t) => {
  const fetchImpl = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
  const { call } = await harness(t, { fetchImpl });
  await startSignIn(call);
  assert.deepEqual(await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` }), {
    status: 400,
    body: { error: 'Mittr rejected the sign-in' },
  });
  assert.equal((await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` })).body.error, 'No sign-in is in progress');
});

test('callback on the wrong scheme is refused', async (t) => {
  const { call, fetchImpl } = await harness(t);
  await startSignIn(call);
  const { status, body } = await call('POST', '/api/mittr/auth/callback', { url: 'mittrcraft://auth/callback?code=c' });
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'Sign-in callback did not arrive on the auth deep link' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('expired transaction is refused', async (t) => {
  const { call, clock, fetchImpl } = await harness(t);
  await startSignIn(call);
  clock.now = NOW + 600_001;
  const { status, body } = await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
  assert.equal(status, 400);
  assert.deepEqual(body, { error: 'Sign-in transaction expired' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('an unreachable platform and an unusable answer are told apart', async (t) => {
  const down = await harness(t, { fetchImpl: fakeFetch(() => { throw new Error('ECONNREFUSED'); }) });
  await startSignIn(down.call);
  assert.deepEqual(await down.call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` }), {
    status: 502,
    body: { error: 'Cannot reach Mittr' },
  });

  const odd = await harness(t, { fetchImpl: fakeFetch(() => json({ accessToken: 'x' })) });
  await startSignIn(odd.call);
  assert.deepEqual(await odd.call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` }), {
    status: 502,
    body: { error: 'Mittr returned an unusable session' },
  });
  assert.deepEqual((await odd.call('GET', '/api/mittr/auth/status')).body, { signedIn: false, signInFailed: 'failed' });
});

test('a sign-in that did not finish is in the status until the next attempt', async (t) => {
  let reachable = false;
  const fetchImpl = fakeFetch(() => {
    if (!reachable) throw new Error('ECONNREFUSED');
    return json(sessionFor('u-a', 'A'));
  });
  const { call } = await harness(t, { fetchImpl });
  const status = async () => (await call('GET', '/api/mittr/auth/status')).body;

  await startSignIn(call);
  await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
  assert.deepEqual(await status(), { signedIn: false, signInFailed: 'unreachable' });

  await startSignIn(call);
  assert.deepEqual(await status(), { signedIn: false });

  await call('POST', '/api/mittr/auth/callback', { url: 'mittrcraft://auth/callback?code=c2' });
  assert.deepEqual(await status(), { signedIn: false, signInFailed: 'failed' });

  reachable = true;
  await startSignIn(call);
  await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c4` });
  assert.deepEqual(await status(), { signedIn: true, userId: 'u-a', displayName: 'A' });
});

const twoAccountHarness = async (t) => {
  let reachable = true;
  const fetchImpl = fakeFetch(({ body }) => {
    if (!reachable) throw new Error('ECONNREFUSED');
    return body.code === 'cb' ? json(sessionFor('u-b', 'B')) : json(sessionFor('u-a', 'A'));
  });
  const h = await harness(t, { fetchImpl });
  const signInWith = async (code) => {
    await startSignIn(h.call);
    return h.call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=${code}` });
  };
  const failOnce = async () => {
    reachable = false;
    await signInWith('cx');
    reachable = true;
  };
  const status = async () => (await h.call('GET', '/api/mittr/auth/status')).body;
  await signInWith('ca');
  await signInWith('cb');
  return { ...h, failOnce, status };
};

test('a failed sign-in is never reported while signed in', async (t) => {
  const { failOnce, status } = await twoAccountHarness(t);
  await failOnce();
  assert.deepEqual(await status(), { signedIn: true, userId: 'u-b', displayName: 'B' });
});

test('switching account clears an earlier failed sign-in', async (t) => {
  const { call, store, failOnce, status } = await twoAccountHarness(t);
  await failOnce();
  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  store.signOut('u-a');
  store.signOut('u-b');
  assert.deepEqual(await status(), { signedIn: false });
});

test('signing out clears an earlier failed sign-in', async (t) => {
  const { call, failOnce, status } = await twoAccountHarness(t);
  await failOnce();
  await call('DELETE', '/api/mittr/auth/session');
  await call('DELETE', '/api/mittr/auth/session');
  assert.deepEqual(await status(), { signedIn: false });
});

test('a refusal is not a failed sign-in: the status says what stands in the way instead', async (t) => {
  const { auth, call, dataDir } = await harness(t);
  fs.mkdirSync(path.join(dataDir, 'mittr-accounts'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'mittr-accounts', 'index.json'), '{');
  await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
  await assert.rejects(auth.completeSignIn(`${DEV_CALLBACK}?code=c1`), { status: 503 });
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false, accountsDamaged: true });

  const locked = await harness(t, { signInRefusal: 'no keychain' });
  await locked.call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
  assert.deepEqual((await locked.call('GET', '/api/mittr/auth/status')).body, { signedIn: false, keychainMissing: true });
});

test('the keychain refusal is asked per request and never when the routes are registered', async (t) => {
  let asked = 0;
  let refusal = null;
  const signInRefusal = () => {
    asked += 1;
    return refusal;
  };
  const { call } = await harness(t, { signInRefusal });
  assert.equal(asked, 0);

  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
  assert.equal(asked, 1);

  refusal = 'no keychain';
  assert.deepEqual((await call('POST', '/api/mittr/auth/start')), { status: 503, body: { error: 'no keychain' } });
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false, keychainMissing: true });
});

test('signing in as another user is an account change', async (t) => {
  const changes = [];
  const signIns = [];
  const { call } = await harness(t, {
    sessions: [sessionFor('u-a', 'A')],
    fetchImpl: fakeFetch(() => json(sessionFor('u-b', 'B'))),
    onSignIn: () => signIns.push('sync'),
    onAccountChange: (next) => changes.push(next),
  });
  await startSignIn(call);
  assert.deepEqual((await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` })).body, {
    signedIn: true,
    userId: 'u-b',
    displayName: 'B',
  });
  assert.deepEqual(changes, ['u-b']);
  assert.deepEqual(signIns, []);
});

test('completeSignIn finishes a sign-in from the raw deep link and throws the refusal otherwise', async (t) => {
  const fetchImpl = fakeFetch(() => json(sessionFor('u-a', 'A')));
  const { auth, call } = await harness(t, { fetchImpl });
  await assert.rejects(auth.completeSignIn(`${DEV_CALLBACK}?code=c1`), { message: 'No sign-in is in progress', status: 400 });
  await startSignIn(call);
  assert.deepEqual(await auth.completeSignIn(`${DEV_CALLBACK}?code=c1`), { signedIn: true, userId: 'u-a', displayName: 'A' });
  assert.equal(fetchImpl.calls.length, 1);
});

test('ensureFreshSession refreshes inside the 60 s margin and keeps rotated tokens', async (t) => {
  const fetchImpl = fakeFetch(() => json(sessionFor('u-a', 'A', { accessToken: 'at-2', refreshToken: 'r2', expiresAt: NOW + 3_600_000 })));
  const { auth, store } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 59_000 })] });
  assert.equal(REFRESH_MARGIN_MS, 60_000);

  const session = await auth.ensureFreshSession();

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api-dev.mittr.asia/auth/desktop/refresh');
  assert.deepEqual(fetchImpl.calls[0].body, { refresh_token: 'r1' });
  assert.equal(session.accessToken, 'at-2');
  assert.equal(store.read().refreshToken, 'r2');
});

test('a session outside the margin is used as it is', async (t) => {
  const fetchImpl = fakeFetch();
  const { auth } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 61_000 })] });
  assert.equal((await auth.ensureFreshSession()).accessToken, 'at-u-a');
  assert.equal(fetchImpl.calls.length, 0);
  const signedOut = await harness(t, { fetchImpl });
  assert.equal(await signedOut.auth.ensureFreshSession(), null);
});

test('concurrent ensureFreshSession calls share one refresh request', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = fakeFetch(async () => {
    await gate;
    return json(sessionFor('u-a', 'A', { refreshToken: 'r2' }));
  });
  const { auth } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })] });

  const all = Promise.all([auth.ensureFreshSession(), auth.ensureFreshSession(), auth.ensureFreshSession()]);
  release();
  const sessions = await all;

  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sessions.map((session) => session.refreshToken), ['r2', 'r2', 'r2']);
});

test('a refused refresh signs out the account it was for', async (t) => {
  const fetchImpl = fakeFetch(() => json({ error: 'invalid_grant' }, 401));
  const { auth, store, call } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })] });
  const signedOut = [];
  const signOut = store.signOut;
  store.signOut = (userId) => { signedOut.push(userId); signOut(userId); };
  store.clear = () => assert.fail('a refused refresh must not clear whichever account is active');

  assert.equal(await auth.ensureFreshSession(), null);
  assert.deepEqual(signedOut, ['u-a']);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
});

test('a refused refresh of the active account hands its request nothing, not the next account\'s session', async (t) => {
  const changes = [];
  const fetchImpl = fakeFetch(() => json({ error: 'invalid_grant' }, 401));
  const { auth, store } = await harness(t, {
    fetchImpl,
    sessions: [sessionFor('u-b', 'B'), sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })],
    onAccountChange: (next) => changes.push(next),
  });
  assert.equal(store.read().subject.userId, 'u-a');

  assert.equal(await auth.ensureFreshSession(), null);

  assert.equal(store.read().subject.userId, 'u-b');
  assert.deepEqual(changes, ['u-b']);
});

test('a failing platform keeps the session', async (t) => {
  for (const respond of [() => json({ error: 'bad gateway' }, 502), () => { throw new Error('offline'); }]) {
    const fetchImpl = fakeFetch(respond);
    const { auth, call } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })] });
    assert.equal((await auth.ensureFreshSession()).accessToken, 'at-u-a');
    assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
  }
});

test('a refresh that finishes after a switch keeps the account switched to', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = fakeFetch(async () => {
    await gate;
    return json(sessionFor('u-b', 'B', { refreshToken: 'r2' }));
  });
  const { auth, store } = await harness(t, {
    fetchImpl,
    sessions: [sessionFor('u-a', 'A'), sessionFor('u-b', 'B', { expiresAt: NOW + 1_000 })],
  });

  const refreshing = auth.ensureFreshSession();
  store.activate('u-a');
  release();

  assert.equal((await refreshing).subject.userId, 'u-a');
  assert.equal(store.read().subject.userId, 'u-a');
  store.activate('u-b');
  assert.equal(store.read().refreshToken, 'r2');
});

test('accounts are listed under accounts', async (t) => {
  const { call } = await harness(t, { sessions: [sessionFor('u-a', 'A')] });
  assert.deepEqual((await call('GET', '/api/mittr/auth/accounts')).body, {
    accounts: [{ userId: 'u-a', displayName: 'A', active: true }],
  });
});

test('signing out answers the next status', async (t) => {
  const changes = [];
  const two = await harness(t, { sessions: [sessionFor('u-b', 'B'), sessionFor('u-a', 'A')], onAccountChange: (next) => changes.push(next) });
  assert.deepEqual(await two.call('DELETE', '/api/mittr/auth/session'), {
    status: 200,
    body: { signedIn: true, userId: 'u-b', displayName: 'B' },
  });

  const one = await harness(t, { sessions: [sessionFor('u-a', 'A')], onAccountChange: (next) => changes.push(next) });
  assert.deepEqual(await one.call('DELETE', '/api/mittr/auth/session'), { status: 200, body: { signedIn: false } });
  assert.deepEqual(changes, ['u-b', null]);
});

test('activating another signed-in account switches to it, and an unknown one is refused', async (t) => {
  const changes = [];
  const { call } = await harness(t, {
    sessions: [sessionFor('u-a', 'A'), sessionFor('u-b', 'B')],
    onAccountChange: (next) => changes.push(next),
  });
  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' }), {
    status: 200,
    body: { signedIn: true, userId: 'u-a', displayName: 'A' },
  });
  assert.deepEqual((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'nobody' }), {
    status: 404,
    body: { error: 'That account is not signed in on this machine' },
  });
  assert.deepEqual(changes, ['u-a']);
});

test('an account change that fails is logged, not answered as a failure', async (t) => {
  const { call } = await harness(t, {
    sessions: [sessionFor('u-a', 'A'), sessionFor('u-b', 'B')],
    onAccountChange: () => { throw new Error('restart failed'); },
  });
  t.mock.method(console, 'warn', () => {});
  assert.equal((await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' })).status, 200);
});

test('a refused sign-in changes nothing on disk', async (t) => {
  const refusal = "MittrCraft can't find a secure keychain on this computer to keep your sign-in safe.";
  const { call, fetchImpl, dataDir } = await harness(t, { sessions: [sessionFor('u-a', 'A')], signInRefusal: refusal });
  const before = fs.readdirSync(path.join(dataDir, 'mittr-accounts')).map((name) => [name, fs.readFileSync(path.join(dataDir, 'mittr-accounts', name), 'utf8')]);

  for (const [method, route, body] of [
    ['POST', '/api/mittr/auth/start'],
    ['POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` }],
    ['DELETE', '/api/mittr/auth/session'],
    ['POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' }],
  ]) {
    assert.deepEqual(await call(method, route, body), { status: 503, body: { error: refusal } }, route);
  }
  assert.equal(fetchImpl.calls.length, 0);
  const after = fs.readdirSync(path.join(dataDir, 'mittr-accounts')).map((name) => [name, fs.readFileSync(path.join(dataDir, 'mittr-accounts', name), 'utf8')]);
  assert.deepEqual(after, before);
});

test('a body larger than 8 kB is refused', async (t) => {
  const { call } = await harness(t);
  await startSignIn(call);
  assert.equal((await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=${'x'.repeat(9_000)}` })).status, 413);
});

test('a sign-out during a refresh in flight wins over the refresh', async (t) => {
  const release = deferred();
  const fetchImpl = fakeFetch(async () => {
    await release.promise;
    return json(sessionFor('u-a', 'A', { accessToken: 'at-2', refreshToken: 'r2' }));
  });
  const { auth, store, call } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })] });

  const refreshing = auth.ensureFreshSession();
  await new Promise(setImmediate);
  store.clear();
  release.resolve();

  assert.equal(await refreshing, null);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
  assert.deepEqual(store.list(), []);
  assert.equal(store.readOf('u-a'), null);
});

test('a stale refusal does not sign out a fresh sign-in of the same account', async (t) => {
  const release = deferred();
  const fetchImpl = fakeFetch(async () => {
    await release.promise;
    return json({ error: 'invalid_grant' }, 401);
  });
  const { auth, store, call } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })] });

  const refreshing = auth.ensureFreshSession();
  await new Promise(setImmediate);
  store.signOut('u-a');
  store.write(sessionFor('u-a', 'A', { accessToken: 'at-fresh', refreshToken: 'r-fresh' }));
  release.resolve();

  assert.equal((await refreshing).accessToken, 'at-fresh');
  assert.equal(store.read().refreshToken, 'r-fresh');
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: true, userId: 'u-a', displayName: 'A' });
});

test('the exchange and the refresh give up after 15 seconds', async (t) => {
  const timeouts = t.mock.method(AbortSignal, 'timeout');
  const fetchImpl = fakeFetch(() => json(sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })));
  const { auth, call } = await harness(t, { fetchImpl });
  await startSignIn(call);
  await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` });
  await auth.ensureFreshSession();

  assert.deepEqual(fetchImpl.calls.map((entry) => new URL(entry.url).pathname), ['/auth/desktop/exchange', '/auth/desktop/refresh']);
  for (const entry of fetchImpl.calls) assert.ok(entry.signal instanceof AbortSignal, entry.url);
  assert.deepEqual(timeouts.mock.calls.map((entry) => entry.arguments), [[15_000], [15_000]]);
});

test('a sign-in that cannot be stored is answered', async (t) => {
  const fetchImpl = fakeFetch(() => json(sessionFor('u-a', 'A')));
  const { call, store } = await harness(t, { fetchImpl });
  t.mock.method(console, 'error', () => {});
  const cannotWrite = () => { throw new Error('ENOSPC: no space left on device'); };
  store.write = cannotWrite;
  store.clear = cannotWrite;
  await startSignIn(call);

  assert.deepEqual(await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` }), {
    status: 500,
    body: { error: 'Cannot store the Mittr sign-in on this machine' },
  });
  assert.deepEqual(await call('DELETE', '/api/mittr/auth/session'), {
    status: 500,
    body: { error: 'Cannot store the Mittr sign-in on this machine' },
  });
});

const damageIndex = (dataDir, text = '{"active": "u-a", "accou') => {
  const indexFile = path.join(dataDir, 'mittr-accounts', 'index.json');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, text);
  return indexFile;
};

test('an unreadable account list refuses sign-in up front, before any browser trip or exchange', async (t) => {
  const { call, fetchImpl, dataDir } = await harness(t, { sessions: [sessionFor('u-a', 'A')] });
  t.mock.method(console, 'error', () => {});
  const indexFile = damageIndex(dataDir);
  const damaged = { status: 503, body: { error: ACCOUNTS_DAMAGED } };

  assert.deepEqual(await call('POST', '/api/mittr/auth/start'), damaged);
  assert.deepEqual(await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` }), damaged);
  assert.deepEqual(await call('DELETE', '/api/mittr/auth/session'), damaged);
  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/activate', { userId: 'u-a' }), damaged);
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false, accountsDamaged: true });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '{"active": "u-a", "accou');
  assert.equal(ACCOUNTS_DAMAGED, 'Your Mittr account list on this computer is damaged. Choose Repair to set it aside and sign in again.');
});

test('repair sets the damaged list aside, and sign-in works again', async (t) => {
  const changes = [];
  const fetchImpl = fakeFetch(() => json(sessionFor('u-b', 'B')));
  const { call, dataDir } = await harness(t, { fetchImpl, onAccountChange: (next) => changes.push(next) });
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  damageIndex(dataDir);

  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/repair'), { status: 200, body: { repaired: true } });

  const setAside = fs.readdirSync(path.join(dataDir, 'mittr-accounts')).filter((name) => name.startsWith('index.json.unreadable-'));
  assert.equal(setAside.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, 'mittr-accounts', setAside[0]), 'utf8'), '{"active": "u-a", "accou');
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false });
  await startSignIn(call);
  assert.deepEqual(await call('POST', '/api/mittr/auth/callback', { url: `${DEV_CALLBACK}?code=c1` }), {
    status: 200,
    body: { signedIn: true, userId: 'u-b', displayName: 'B' },
  });
  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/repair'), { status: 200, body: { repaired: false } });
  assert.deepEqual(changes, [null, 'u-b']);
});

test('a sign-out that lands while the refreshed body is read still wins', async (t) => {
  const release = deferred();
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => {
      await release.promise;
      return sessionFor('u-a', 'A', { accessToken: 'at-2', refreshToken: 'r2' });
    },
  }));
  const { auth, store } = await harness(t, { fetchImpl, sessions: [sessionFor('u-a', 'A', { expiresAt: NOW + 1_000 })] });

  const refreshing = auth.ensureFreshSession();
  await new Promise(setImmediate);
  assert.equal(fetchImpl.calls.length, 1);
  store.clear();
  release.resolve();

  assert.equal(await refreshing, null);
  assert.equal(store.readOf('u-a'), null);
  assert.deepEqual(store.list(), []);
});

test('a repair that cannot write answers so, and the list still reads as damaged', async (t) => {
  const failingFs = {
    ...fs,
    writeFileSync: (file, ...rest) => {
      if (path.basename(String(file)).startsWith('index.json.')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return fs.writeFileSync(file, ...rest);
    },
  };
  const { call, dataDir } = await harness(t, { storeOptions: { fs: failingFs, logger: { error: () => {}, warn: () => {}, log: () => {} } } });
  t.mock.method(console, 'error', () => {});
  const indexFile = damageIndex(dataDir);

  assert.deepEqual(await call('POST', '/api/mittr/auth/accounts/repair'), {
    status: 500,
    body: { error: 'Cannot store the Mittr sign-in on this machine' },
  });
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '{"active": "u-a", "accou');
  assert.deepEqual((await call('GET', '/api/mittr/auth/status')).body, { signedIn: false, accountsDamaged: true });
});
