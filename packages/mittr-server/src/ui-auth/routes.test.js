import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { repoRoot } from '../upstream-contract.js';
import { listen } from '../mittr/test-helpers.js';
import { PROVIDER_ID, TRANSACTION_COOKIE, registerCompanySignIn } from './routes.js';
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

const harness = async (t, { env, scope = 'local', password = '', directory, microsoft, logger = recordingLogger() } = {}) => {
  const app = express();
  const uiAuth = createUiAuth({ password });
  t.after(() => uiAuth.dispose());
  const signIn = registerCompanySignIn({
    app,
    express,
    logger,
    requestScope: () => scope,
    uiAuth: { registerProvider: registerUiAuthProvider, passwordEnabled: () => Boolean(password) },
  }, {
    env,
    ldap: directory ? { createClient: directory.createClient } : {},
    entra: microsoft ? { fetchImpl: microsoft.fetchImpl, now: () => NOW } : {},
    now: () => NOW,
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
  assert.equal((await call('POST', '/auth/ad/session', { body: { username: 'a', password: 'b' } })).status, 400);
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
