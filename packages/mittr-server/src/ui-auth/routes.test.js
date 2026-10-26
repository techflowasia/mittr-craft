import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { repoRoot } from '../upstream-contract.js';
import { listen } from '../mittr/test-helpers.js';
import { PROVIDER_ID, TRANSACTION_COOKIE, clientLabelFor, registerCompanySignIn } from './routes.js';
import { ENTRA_ENV, LDAP_ENV, NOW, directoryEntry, fakeDirectory, fakeMicrosoft, recordingLogger } from './test-fixtures.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-ui-auth-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;
delete process.env.OPENCODE_JWT_SECRET;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const { createUiAuth, registerUiAuthProvider } = await import(pathToFileURL(path.join(repoRoot, 'packages/web/server/lib/ui-auth/ui-auth.js')).href);

const ADA_DN = 'CN=ada,OU=Staff,DC=corp,DC=test';
const AD_ROUTES = [
  ['GET', '/auth/ad/status'],
  ['GET', '/auth/ad/login'],
  ['GET', '/auth/ad/callback?state=s&code=c'],
  ['POST', '/auth/ad/session'],
  ['GET', '/auth/ad/profile'],
];

const harness = async (t, { env, scope = 'local', password = '', directory, microsoft, createClient, logger = recordingLogger(), clock = { now: NOW } } = {}) => {
  const app = express();
  const uiAuth = createUiAuth({ password });
  t.after(() => uiAuth.dispose());
  const signIn = registerCompanySignIn({
    app,
    express,
    logger,
    requestScope: () => scope,
    uiAuth: { registerProvider: registerUiAuthProvider, passwordEnabled: () => Boolean(password), ...(createClient ? { createClient } : {}) },
  }, {
    env,
    ldap: directory ? { createClient: directory.createClient } : {},
    entra: microsoft ? { fetchImpl: microsoft.fetchImpl, now: () => clock.now } : {},
    now: () => clock.now,
  });
  t.after(() => signIn.dispose());
  app.use('/api', (req, res, next) => uiAuth.requireAuth(req, res, next));
  app.get('/api/x', (_req, res) => res.json({ ok: true }));
  const base = await listen(t, app);
  const call = async (method, route, { body, cookie, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method,
      redirect: 'manual',
      headers: {
        ...headers,
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, cookies: response.headers.getSetCookie(), text, body: json };
  };
  return { call, logger, signIn };
};

const sessionCookieOf = (response) => response.cookies.find((cookie) => cookie.startsWith('oc_ui_session'))?.split(';')[0];

const ldapDirectory = () => fakeDirectory({
  users: { [LDAP_ENV.MITTR_AD_BIND_DN]: LDAP_ENV.MITTR_AD_BIND_PASSWORD, [ADA_DN]: 'correct horse' },
  entries: [directoryEntry('ada')],
});

test('AD status body', async (t) => {
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft: fakeMicrosoft() });

  const { status, body } = await call('GET', '/auth/ad/status');

  assert.equal(status, 200);
  assert.deepEqual(body, { enabled: true, mode: 'entra', passwordEnabled: false, tunnelLocked: false });
});

test('with nothing configured no provider is registered and the server stays as upstream', async (t) => {
  const { call } = await harness(t, { env: {} });

  assert.deepEqual((await call('GET', '/auth/ad/status')).body, { enabled: false, passwordEnabled: false, tunnelLocked: false });
  assert.equal((await call('GET', '/api/x')).status, 200);
  assert.equal((await call('DELETE', '/auth/session')).status, 404);
  const refused = await call('POST', '/auth/ad/session', { body: { username: 'a', password: 'b' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'not-configured');
});

test('the LDAP session route says why it refuses a Microsoft server and an empty form', async (t) => {
  const entra = await harness(t, { env: ENTRA_ENV, microsoft: fakeMicrosoft() });
  const microsoft = await entra.call('POST', '/auth/ad/session', { body: { username: 'a', password: 'b' } });
  assert.equal(microsoft.status, 400);
  assert.equal(microsoft.body.code, 'use-microsoft');
});

test('an LDAP form with nothing in it is refused as missing fields', async (t) => {
  const { call } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory() });
  const empty = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: '' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'missing-fields');
});

test('a configured provider makes every API request need a session', async (t) => {
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft: fakeMicrosoft() });

  const { status, body } = await call('GET', '/api/x', { headers: { accept: 'application/json' } });

  assert.equal(status, 401);
  assert.deepEqual(body, { error: 'UI authentication required', locked: true });
});

test('partial Entra config fails closed', (t) => {
  const { MITTR_AD_TENANT_ID, ...three } = ENTRA_ENV;
  assert.ok(MITTR_AD_TENANT_ID);
  const app = express();
  let registered = 0;
  assert.throws(() => registerCompanySignIn({
    app,
    express,
    logger: recordingLogger(),
    requestScope: () => 'local',
    uiAuth: { registerProvider: () => { registered += 1; return {}; }, passwordEnabled: () => false },
  }, { env: three }), /Missing MITTR_AD_TENANT_ID/);
  assert.equal(registered, 0);
  t.diagnostic('the server plugin loader fails the server start when setup throws');
});

test('incomplete directory settings fail closed', () => {
  const { MITTR_AD_SEARCH_BASE, ...partial } = LDAP_ENV;
  assert.ok(MITTR_AD_SEARCH_BASE);
  assert.throws(() => registerCompanySignIn({
    app: express(),
    express,
    logger: recordingLogger(),
    requestScope: () => 'local',
    uiAuth: { registerProvider: registerUiAuthProvider, passwordEnabled: () => false },
  }, { env: partial }), /Missing MITTR_AD_SEARCH_BASE/);
});

test('a configured provider on a server that cannot require a session fails closed', () => {
  assert.throws(() => registerCompanySignIn({
    app: express(),
    express,
    logger: recordingLogger(),
    requestScope: () => 'local',
  }, { env: ENTRA_ENV }), /refusing to start/);
});

test('Entra login redirects to Microsoft with PKCE and state', async (t) => {
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft: fakeMicrosoft() });

  const response = await call('GET', '/auth/ad/login?returnTo=%2Fprojects', { headers: { 'x-forwarded-proto': 'https' } });

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.host, 'login.microsoftonline.com');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), ENTRA_ENV.MITTR_AD_REDIRECT_URI);
  const state = location.searchParams.get('state');
  assert.ok(state);
  const cookie = response.cookies.find((entry) => entry.startsWith(`${TRANSACTION_COOKIE}=`));
  assert.ok(cookie, response.cookies.join('\n'));
  assert.equal(cookie, `${TRANSACTION_COOKIE}=${state}; Path=/auth/ad/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the redirect URI ignores the request host', async (t) => {
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft: fakeMicrosoft() });

  const response = await call('GET', '/auth/ad/login', { headers: { host: 'evil.example.test', 'x-forwarded-host': 'evil.example.test' } });

  assert.equal(new URL(response.headers.get('location')).searchParams.get('redirect_uri'), ENTRA_ENV.MITTR_AD_REDIRECT_URI);
  assert.ok(!response.cookies.join(';').includes('Secure'));
});

const startEntra = async (call, returnTo = '/projects') => {
  const response = await call('GET', `/auth/ad/login?returnTo=${encodeURIComponent(returnTo)}`);
  const location = new URL(response.headers.get('location'));
  return {
    state: location.searchParams.get('state'),
    nonce: location.searchParams.get('nonce'),
    cookie: response.cookies.find((entry) => entry.startsWith(`${TRANSACTION_COOKIE}=`)).split(';')[0],
  };
};

test('callback with a mismatched state is refused', async (t) => {
  const microsoft = fakeMicrosoft();
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft });
  const { state, cookie } = await startEntra(call);

  const mismatched = await call('GET', `/auth/ad/callback?state=${state}x&code=auth-code`, { cookie });
  const noCookie = await call('GET', `/auth/ad/callback?state=${state}&code=auth-code`);
  const providerError = await call('GET', `/auth/ad/callback?state=${state}&code=auth-code&error=access_denied`, { cookie });

  for (const response of [mismatched, noCookie, providerError]) {
    assert.equal(response.status, 400);
    assert.equal(sessionCookieOf(response), undefined);
    assert.ok(response.cookies.some((entry) => entry.startsWith(`${TRANSACTION_COOKIE}=;`) && entry.includes('Max-Age=0')));
  }
  assert.ok(!microsoft.calls.some((entry) => entry.method === 'POST'));
});

test('a verified Microsoft callback opens a UI session and goes back where the person was', async (t) => {
  const microsoft = fakeMicrosoft();
  const logger = recordingLogger();
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft, logger });
  const { state, nonce, cookie } = await startEntra(call, 'https://evil.example.test/steal');
  microsoft.state.nonce = nonce;

  const response = await call('GET', `/auth/ad/callback?state=${state}&code=auth-code-value`, { cookie });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/');
  const session = sessionCookieOf(response);
  assert.ok(session);
  assert.ok(response.cookies.some((entry) => entry.startsWith(`${TRANSACTION_COOKIE}=;`)));
  assert.equal((await call('GET', '/api/x', { cookie: session })).status, 200);
  const profile = await call('GET', '/auth/ad/profile', { cookie: session });
  assert.equal(profile.body.profile.displayName, 'Ada Lovelace');
  const replay = await call('GET', `/auth/ad/callback?state=${state}&code=auth-code-value`, { cookie });
  assert.equal(replay.status, 401);
  for (const line of logger.lines) {
    assert.ok(!line.includes('auth-code-value') && !line.includes(ENTRA_ENV.MITTR_AD_CLIENT_SECRET) && !line.includes(session.split('=')[1]), line);
  }
});

test('after Microsoft sign-in the redirect never leaves this origin', async (t) => {
  const cases = ['/.//evil.example', '/..//evil.example', '/./\\evil.example', '//evil', '\\\\evil', '/\\evil', '%2F%2Fevil', '/%2F%2Fevil', '/projects?x=1'];
  for (const returnTo of cases) {
    const microsoft = fakeMicrosoft();
    const { call, signIn } = await harness(t, { env: ENTRA_ENV, microsoft });
    const { state, nonce, cookie } = await startEntra(call, returnTo);
    microsoft.state.nonce = nonce;

    const response = await call('GET', `/auth/ad/callback?state=${state}&code=auth-code`, { cookie });

    assert.equal(response.status, 302, returnTo);
    const location = response.headers.get('location');
    assert.ok(location.startsWith('/') && !/^[\\/]{2}/.test(location) && !location.startsWith('/\\'), `${returnTo} -> ${location}`);
    assert.equal(new URL(location, 'http://127.0.0.1').origin, 'http://127.0.0.1', `${returnTo} -> ${location}`);
    signIn.dispose();
  }
  const microsoft = fakeMicrosoft();
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft });
  const { state, nonce, cookie } = await startEntra(call, '/projects?x=1');
  microsoft.state.nonce = nonce;
  assert.equal((await call('GET', `/auth/ad/callback?state=${state}&code=auth-code`, { cookie })).headers.get('location'), '/projects?x=1');
});

test('one address cannot flood Microsoft sign-in starts', async (t) => {
  const microsoft = fakeMicrosoft();
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft });
  const first = await startEntra(call);

  for (let attempt = 1; attempt < 20; attempt += 1) assert.equal((await call('GET', '/auth/ad/login')).status, 302);
  const refused = await call('GET', '/auth/ad/login');

  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal(refused.cookies.length, 0);
  microsoft.state.nonce = first.nonce;
  const completed = await call('GET', `/auth/ad/callback?state=${first.state}&code=auth-code`, { cookie: first.cookie });
  assert.equal(completed.status, 302, 'the first sign-in in progress was evicted');
});

test('the start cap counts only sign-ins still in progress', async (t) => {
  const microsoft = fakeMicrosoft();
  const clock = { now: NOW };
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft, clock });

  for (let signIn = 0; signIn < 25; signIn += 1) {
    const { state, nonce, cookie } = await startEntra(call);
    microsoft.state.nonce = nonce;
    const done = await call('GET', `/auth/ad/callback?state=${state}&code=auth-code`, { cookie });
    assert.equal(done.status, 302, `sign-in ${signIn + 1}`);
  }
  const failed = await startEntra(call);
  microsoft.state.claims = { aud: 'another-app' };
  microsoft.state.nonce = failed.nonce;
  assert.equal((await call('GET', `/auth/ad/callback?state=${failed.state}&code=auth-code`, { cookie: failed.cookie })).status, 401);
  const cancelled = await startEntra(call);
  assert.equal((await call('GET', `/auth/ad/callback?state=${cancelled.state}&error=access_denied`, { cookie: cancelled.cookie })).status, 400);

  for (let start = 0; start < 20; start += 1) assert.equal((await call('GET', '/auth/ad/login')).status, 302, `start ${start + 1}`);
  assert.equal((await call('GET', '/auth/ad/login')).status, 429);

  clock.now += 600_000;
  assert.equal((await call('GET', '/auth/ad/login')).status, 302, 'expired sign-ins still held a slot');
});

test('one address may start at most 60 Microsoft sign-ins in 10 minutes, finished or not', async (t) => {
  const microsoft = fakeMicrosoft();
  const clock = { now: NOW };
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft, clock });

  for (let signIn = 0; signIn < 60; signIn += 1) {
    const { state, nonce, cookie } = await startEntra(call);
    microsoft.state.nonce = nonce;
    assert.equal((await call('GET', `/auth/ad/callback?state=${state}&code=auth-code`, { cookie })).status, 302, `sign-in ${signIn + 1}`);
  }
  const tokenRequests = microsoft.calls.filter((entry) => entry.method === 'POST').length;
  const refused = await call('GET', '/auth/ad/login');

  assert.equal(refused.status, 429);
  const retryAfter = Number(refused.headers.get('retry-after'));
  assert.ok(retryAfter > 0 && retryAfter <= 600, String(retryAfter));
  assert.equal(refused.cookies.length, 0);
  assert.equal(microsoft.calls.filter((entry) => entry.method === 'POST').length, tokenRequests);
  clock.now += 600_000;
  assert.equal((await call('GET', '/auth/ad/login')).status, 302);
});

test('a parallel burst of starts cannot get past the cap while Microsoft is slow to answer', async (t) => {
  const microsoft = fakeMicrosoft();
  const slow = { ...microsoft, fetchImpl: async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return microsoft.fetchImpl(url, init);
  } };
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft: slow });

  const responses = await Promise.all(Array.from({ length: 25 }, () => call('GET', '/auth/ad/login')));

  const started = responses.filter((response) => response.status === 302).length;
  assert.ok(started <= 20, `${started} starts passed`);
  assert.equal(started, 20);
  assert.equal(responses.filter((response) => response.status === 429).length, 5);
});

test('a start that fails gives its slot back', async (t) => {
  const microsoft = fakeMicrosoft();
  let failing = true;
  const flaky = { ...microsoft, fetchImpl: async (url, init) => {
    if (failing) throw new Error('network down');
    return microsoft.fetchImpl(url, init);
  } };
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft: flaky });

  for (let attempt = 0; attempt < 20; attempt += 1) assert.equal((await call('GET', '/auth/ad/login')).status, 502);
  failing = false;
  assert.equal((await call('GET', '/auth/ad/login')).status, 302);
});

test('a Microsoft token for another app does not open a session', async (t) => {
  const microsoft = fakeMicrosoft();
  const { call } = await harness(t, { env: ENTRA_ENV, microsoft });
  const { state, nonce, cookie } = await startEntra(call);
  microsoft.state.nonce = nonce;
  microsoft.state.claims = { aud: 'another-app' };

  const response = await call('GET', `/auth/ad/callback?state=${state}&code=auth-code`, { cookie });

  assert.equal(response.status, 401);
  assert.equal(sessionCookieOf(response), undefined);
});

test('LDAP wrong password is refused', async (t) => {
  const directory = ldapDirectory();
  const logger = recordingLogger();
  const { call } = await harness(t, { env: LDAP_ENV, directory, logger });

  const response = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'wrong password' } });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'Invalid credentials' });
  assert.ok(sessionCookieOf(response)?.endsWith('='));
  assert.ok(directory.clients.every((client) => client.closed));
  for (const line of logger.lines) assert.ok(!line.includes('wrong password'), line);
});

test('LDAP sign-in opens a UI session, and an empty password never binds', async (t) => {
  const directory = ldapDirectory();
  const { call } = await harness(t, { env: LDAP_ENV, directory });

  const empty = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: '' } });
  assert.equal(empty.status, 400);
  assert.equal(directory.clients.length, 0);

  const response = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse', trustDevice: true } });
  assert.equal(response.status, 200);
  assert.equal(response.body.authenticated, true);
  assert.equal(response.body.profile.username, 'ada');
  const sessionCookie = response.cookies.find((entry) => entry.startsWith('oc_ui_session'));
  assert.ok(sessionCookie.includes(`Max-Age=${7 * 24 * 60 * 60}`));
  const session = sessionCookie.split(';')[0];
  assert.equal((await call('GET', '/api/x', { cookie: session })).status, 200);
  const profile = await call('GET', '/auth/ad/profile', { cookie: session });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.profile.department, 'Engineering');
  assert.equal((await call('GET', '/auth/ad/profile')).status, 401);
  assert.equal((await call('GET', '/auth/ad/login')).status, 400);
});

const clientMinter = () => {
  const calls = [];
  return {
    calls,
    createClient: async (options) => {
      calls.push(options);
      return { token: 'oc_client_token', client: { id: 'client-1', label: options.fallbackLabel } };
    },
  };
};

test('LDAP sign-in gives a desktop app a client token only when asked', async (t) => {
  const minter = clientMinter();
  const { call } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory(), createClient: minter.createClient });

  const plain = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse' } });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.clientToken, undefined);
  assert.equal(minter.calls.length, 0);

  const asked = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse', issueClientToken: true, clientLabel: 'Anything the app says' } });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.clientToken, 'oc_client_token');
  assert.equal(asked.body.client.id, 'client-1');
  assert.ok(sessionCookieOf(asked));
  assert.equal(minter.calls.length, 1);
  assert.equal(minter.calls[0].label, 'MittrCraft Desktop (ada)');
  assert.equal(minter.calls[0].fallbackLabel, undefined);
  assert.equal(minter.calls[0].authMethod, 'ad');
  assert.equal(Date.parse(minter.calls[0].expiresAt), NOW + 12 * 60 * 60 * 1000);
});

test('the desktop client label drops control and format characters', () => {
  assert.equal(clientLabelFor('ada'), 'MittrCraft Desktop (ada)');
  assert.equal(clientLabelFor('a\u0000d\u001b[2Ja\n\u007f'), 'MittrCraft Desktop (ad[2Ja)');
  assert.equal(clientLabelFor('a\u200bd\u202ea\u2066\ufeff'), 'MittrCraft Desktop (ada)');
});

test('the whole desktop client label fits upstream\'s 80 UTF-16 units and keeps its closing parenthesis', () => {
  const long = clientLabelFor('x'.repeat(200));
  assert.equal(long.length, 80);
  assert.equal(long, `MittrCraft Desktop (${'x'.repeat(59)})`);
  assert.equal(clientLabelFor('x'.repeat(59)), `MittrCraft Desktop (${'x'.repeat(59)})`);
});

test('a capped desktop client label never splits a surrogate pair', () => {
  const label = clientLabelFor('\u{1F600}'.repeat(40));
  assert.ok(label.length <= 80, String(label.length));
  assert.equal(label, `MittrCraft Desktop (${'\u{1F600}'.repeat(29)})`);
  assert.equal(clientLabelFor(`x${'\u{1F600}'.repeat(40)}`), `MittrCraft Desktop (x${'\u{1F600}'.repeat(29)})`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clientLabelFor(`x${'\u{1F600}'.repeat(40)}`)));
});

test('a username with nothing left after cleaning gives the plain desktop label', () => {
  assert.equal(clientLabelFor(''), 'MittrCraft Desktop');
  assert.equal(clientLabelFor('\u0000\u001b\u200b'), 'MittrCraft Desktop');
  assert.equal(clientLabelFor('   '), 'MittrCraft Desktop');
});

test('a trusted device keeps its client token for as long as its session', async (t) => {
  const minter = clientMinter();
  const { call } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory(), createClient: minter.createClient });

  await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse', trustDevice: true, issueClientToken: true } });

  assert.equal(Date.parse(minter.calls[0].expiresAt), NOW + 7 * 24 * 60 * 60 * 1000);
});

test('the person picks neither the kind nor the dedupe key of the client token', async (t) => {
  const minter = clientMinter();
  const { call } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory(), createClient: minter.createClient });

  await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse', issueClientToken: true, clientKind: 'desktop-local', dedupeKey: 'desktop-local' } });

  assert.equal(minter.calls.length, 1);
  assert.equal(minter.calls[0].clientKind, undefined);
  assert.equal(minter.calls[0].dedupeKey, undefined);
});

test('no client token for wrong credentials', async (t) => {
  const minter = clientMinter();
  const { call } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory(), createClient: minter.createClient });

  const refused = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'nope', issueClientToken: true } });

  assert.equal(refused.status, 401);
  assert.equal(minter.calls.length, 0);
});

test('a failed mint still leaves the session', async (t) => {
  const logger = recordingLogger();
  const failing = await harness(t, { env: LDAP_ENV, directory: ldapDirectory(), logger, createClient: async () => { throw new Error('store is read-only'); } });

  const response = await failing.call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse', issueClientToken: true } });
  assert.equal(response.status, 200);
  assert.equal(response.body.authenticated, true);
  assert.equal(response.body.clientToken, undefined);
  assert.ok(sessionCookieOf(response));
  assert.ok(logger.lines.some((line) => line.includes('client token')));
});

test('repeated wrong LDAP passwords are rate limited', async (t) => {
  const { call } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory() });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'nope' } })).status, 401);
  }
  const locked = await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse' } });

  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});

test('tunnel scope is refused', async (t) => {
  for (const scope of ['tunnel', 'unknown-public']) {
    for (const env of [ENTRA_ENV, LDAP_ENV]) {
      const directory = ldapDirectory();
      const microsoft = fakeMicrosoft();
      const { call, signIn } = await harness(t, { env, scope, directory, microsoft });
      for (const [method, route] of AD_ROUTES) {
        const response = await call(method, route, method === 'POST' ? { body: { username: 'ada', password: 'correct horse' } } : {});
        assert.equal(response.status, 403, `${scope} ${method} ${route}`);
        assert.equal(response.body.tunnelLocked, true);
      }
      assert.equal((await call('DELETE', '/auth/session')).status, 403);
      assert.equal(directory.clients.length, 0);
      assert.equal(microsoft.calls.length, 0);
      signIn.dispose();
    }
  }
});

test('sign-out clears only this browser', async (t) => {
  const { call } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory() });
  const thisBrowser = sessionCookieOf(await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse' } }));
  const otherBrowser = sessionCookieOf(await call('POST', '/auth/ad/session', { body: { username: 'ada', password: 'correct horse' } }));

  const response = await call('DELETE', '/auth/session', { cookie: thisBrowser });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { authenticated: false });
  assert.equal(response.cookies.length, 1);
  assert.match(response.cookies[0], /^oc_ui_session_\d+=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await call('GET', '/api/x', { cookie: otherBrowser })).status, 200);
});

test('the provider is registered under its id and removed on dispose', async (t) => {
  const { call, signIn } = await harness(t, { env: LDAP_ENV, directory: ldapDirectory() });
  const status = createUiAuth({});
  const recorder = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, setHeader() { return this; } };
  await status.handleSessionStatus({ headers: {} }, recorder);
  assert.deepEqual(recorder.body.providers, [PROVIDER_ID]);

  signIn.dispose();
  assert.equal((await call('GET', '/api/x')).status, 200);
  registerUiAuthProvider({ id: PROVIDER_ID }).unregister();
});
