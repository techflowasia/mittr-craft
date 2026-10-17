import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createEntraAuth, hasEntraConfiguration } from './entra-auth.js';
import { CLIENT_ID, ENTRA_ENV, ISSUER, NOW, REDIRECT_URI, TENANT, fakeMicrosoft } from './test-fixtures.js';

const begin = async (t, over = {}) => {
  const microsoft = fakeMicrosoft();
  const auth = createEntraAuth(ENTRA_ENV, { fetchImpl: microsoft.fetchImpl, now: () => NOW, ...over });
  t.after(() => auth.dispose());
  const transaction = await auth.beginAuthorization({ trustDevice: true, returnTo: '/projects' });
  const url = new URL(transaction.authorizationUrl);
  microsoft.state.nonce = url.searchParams.get('nonce');
  return { auth, microsoft, transaction, url };
};

test('partial Entra config fails closed', () => {
  const { MITTR_AD_REDIRECT_URI, ...three } = ENTRA_ENV;
  assert.ok(MITTR_AD_REDIRECT_URI);

  const auth = createEntraAuth(three);

  assert.equal(auth.enabled, false);
  assert.equal(auth.configurationPresent, true);
  assert.ok(auth.configurationError.startsWith('Missing'), auth.configurationError);
  assert.equal(auth.configurationError, 'Missing MITTR_AD_REDIRECT_URI');
  assert.equal(hasEntraConfiguration(three), true);
  assert.equal(hasEntraConfiguration({}), false);
});

test('a multi-tenant endpoint, a bad tenant or a plain-HTTP redirect is refused', () => {
  for (const tenant of ['common', 'organizations', 'Consumers']) {
    assert.equal(createEntraAuth({ ...ENTRA_ENV, MITTR_AD_TENANT_ID: tenant }).enabled, false, tenant);
  }
  assert.equal(createEntraAuth({ ...ENTRA_ENV, MITTR_AD_TENANT_ID: 'bad/tenant' }).enabled, false);
  assert.equal(createEntraAuth({ ...ENTRA_ENV, MITTR_AD_REDIRECT_URI: 'http://mittrcraft.example.test/cb' }).enabled, false);
  assert.equal(createEntraAuth({ ...ENTRA_ENV, MITTR_AD_REDIRECT_URI: 'http://127.0.0.1:3000/auth/ad/callback' }).enabled, true);
});

test('the authorization URL carries PKCE S256, state, nonce and only the configured redirect URI', async (t) => {
  const { url, transaction, microsoft } = await begin(t);

  assert.equal(url.host, 'login.microsoftonline.com');
  assert.equal(url.pathname, `/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.get('state'), transaction.state);
  assert.ok(url.searchParams.get('nonce').length >= 43);
  assert.equal(transaction.expiresAt, NOW + 600_000);
  assert.ok(microsoft.calls.every((call) => call.redirect === 'error'));
});

test('a valid callback exchanges the code with the matching verifier and returns the profile', async (t) => {
  const { auth, microsoft, transaction, url } = await begin(t);

  const result = await auth.completeAuthorization({ code: 'auth-code', state: transaction.state });

  assert.deepEqual(result, {
    profile: { id: 'object-1', username: 'ada@corp.test', displayName: 'Ada Lovelace', email: 'ada@corp.test', tenantId: TENANT },
    trustDevice: true,
    returnTo: '/projects',
  });
  const exchange = microsoft.calls.find((call) => call.method === 'POST');
  assert.equal(exchange.body.get('redirect_uri'), REDIRECT_URI);
  assert.equal(exchange.body.get('code'), 'auth-code');
  const verifier = exchange.body.get('code_verifier');
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  await assert.rejects(auth.completeAuthorization({ code: 'auth-code', state: transaction.state }), /invalid or expired/);
});

test('an expired transaction is refused', async (t) => {
  let clock = NOW;
  const { auth, transaction } = await begin(t, { now: () => clock });
  clock += 600_001;
  await assert.rejects(auth.completeAuthorization({ code: 'auth-code', state: transaction.state }), /invalid or expired/);
});

const rejectsWith = async (t, mutate, pattern) => {
  const { auth, microsoft, transaction } = await begin(t);
  mutate(microsoft);
  await assert.rejects(auth.completeAuthorization({ code: 'auth-code', state: transaction.state }), pattern);
};

test('the ID token must come from the configured issuer', async (t) => {
  await rejectsWith(t, (m) => { m.state.claims = { iss: 'https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0' }; }, /wrong issuer/);
});

test('the ID token must be for this app', async (t) => {
  await rejectsWith(t, (m) => { m.state.claims = { aud: 'another-app' }; }, /wrong audience/);
  await rejectsWith(t, (m) => { m.state.claims = { aud: [CLIENT_ID, 'another-app'], azp: 'another-app' }; }, /wrong audience/);
});

test('the ID token must be from the configured tenant', async (t) => {
  await rejectsWith(t, (m) => { m.state.claims = { tid: '99999999-2222-3333-4444-555555555555' }; }, /another tenant/);
});

test('an expired or not-yet-valid ID token is refused', async (t) => {
  const seconds = NOW / 1000;
  await rejectsWith(t, (m) => { m.state.claims = { exp: seconds - 60 }; }, /expired/);
  await rejectsWith(t, (m) => { m.state.claims = { nbf: seconds + 600 }; }, /not valid yet/);
  await rejectsWith(t, (m) => { m.state.claims = { exp: undefined }; }, /expired/);
});

test('the nonce must match the one sent', async (t) => {
  await rejectsWith(t, (m) => { m.state.claims = { nonce: 'replayed-nonce' }; }, /nonce does not match/);
});

test('the signature is checked against Microsoft signing keys', async (t) => {
  const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await rejectsWith(t, (m) => { m.state.idToken = m.sign(m.baseClaims(m.state.nonce), { key: otherKey }); }, /signature is invalid/);
  await rejectsWith(t, (m) => { m.state.idToken = m.sign(m.baseClaims(m.state.nonce), { header: { kid: 'unknown' } }); }, /unknown key/);
  await rejectsWith(t, (m) => { m.state.idToken = m.sign(m.baseClaims(m.state.nonce), { header: { alg: 'HS256' } }); }, /unexpected signature/);
  await rejectsWith(t, (m) => {
    const claims = Buffer.from(JSON.stringify(m.baseClaims(m.state.nonce))).toString('base64url');
    m.state.idToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${claims}.`;
  }, /malformed/);
});

test('a refused code exchange fails without echoing the response', async (t) => {
  await rejectsWith(t, (m) => { m.state.tokenStatus = 400; }, /^Error: Microsoft token exchange failed \(400\)$/);
});

test('metadata pointing away from Microsoft is refused', async () => {
  const microsoft = fakeMicrosoft();
  microsoft.state.metadata = {
    issuer: ISSUER,
    authorization_endpoint: 'https://evil.example.test/authorize',
    token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
  };
  const auth = createEntraAuth(ENTRA_ENV, { fetchImpl: microsoft.fetchImpl, now: () => NOW });
  await assert.rejects(auth.beginAuthorization(), /metadata is invalid/);
});

test('metadata for another tenant is refused', async () => {
  const microsoft = fakeMicrosoft();
  microsoft.state.metadata = {
    issuer: 'https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0',
    authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
  };
  const auth = createEntraAuth(ENTRA_ENV, { fetchImpl: microsoft.fetchImpl, now: () => NOW });
  await assert.rejects(auth.beginAuthorization(), /metadata is invalid/);
});
