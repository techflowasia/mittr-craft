import { describe, expect, it, mock } from 'bun:test';
import { createEntraAuth } from './entra-auth.js';

const completeEnv = {
  MITTR_AD_CLIENT_ID: 'client-id',
  MITTR_AD_CLIENT_SECRET: 'server-secret',
  MITTR_AD_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  MITTR_AD_REDIRECT_URI: 'https://openchamber.example.com/auth/ad/callback',
};

const metadata = {
  issuer: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
  authorization_endpoint: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token',
  jwks_uri: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/discovery/v2.0/keys',
};

const jsonResponse = (payload, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => payload,
});

describe('Microsoft Entra authentication', () => {
  it('reports partial configuration as disabled so the UI can fail closed', () => {
    const auth = createEntraAuth({ env: { MITTR_AD_CLIENT_ID: 'client-id' } });
    expect(auth.enabled).toBe(false);
    expect(auth.configurationPresent).toBe(true);
    expect(auth.getStatus()).toMatchObject({ enabled: false, mode: 'entra' });
  });

  it('uses authorization code with PKCE and validates the returned identity token', async () => {
    let tokenRequest = null;
    let expectedNonce = '';
    const fetchImpl = mock(async (url, init = {}) => {
      if (String(url).includes('openid-configuration')) return jsonResponse(metadata);
      tokenRequest = { url: String(url), init };
      return jsonResponse({ id_token: 'signed-id-token', access_token: 'not-persisted' });
    });
    const jwtVerifyImpl = mock(async (_token, _keySet, options) => ({
      payload: {
        sub: 'subject-1',
        oid: 'object-1',
        tid: completeEnv.MITTR_AD_TENANT_ID,
        nonce: expectedNonce,
        name: 'Ada Lovelace',
        preferred_username: 'ada@example.com',
      },
      protectedHeader: { alg: 'RS256' },
      options,
    }));
    const auth = createEntraAuth({
      env: completeEnv,
      fetchImpl,
      createRemoteJWKSetImpl: () => 'trusted-key-set',
      jwtVerifyImpl,
    });

    const started = await auth.beginAuthorization({ trustDevice: true });
    const authorizationUrl = new URL(started.authorizationUrl);
    expectedNonce = authorizationUrl.searchParams.get('nonce');
    expect(authorizationUrl.searchParams.get('client_id')).toBe('client-id');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(completeEnv.MITTR_AD_REDIRECT_URI);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorizationUrl.searchParams.has('client_secret')).toBe(false);

    const result = await auth.completeAuthorization({ code: 'authorization-code', state: started.state });
    expect(result).toEqual({
      trustDevice: true,
      profile: {
        id: 'object-1',
        username: 'ada@example.com',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        tenantId: completeEnv.MITTR_AD_TENANT_ID,
      },
    });

    expect(tokenRequest.url).toBe(metadata.token_endpoint);
    const tokenBody = tokenRequest.init.body;
    expect(tokenBody.get('client_secret')).toBe('server-secret');
    expect(tokenBody.get('code_verifier')).toBeTruthy();
    expect(tokenBody.get('code')).toBe('authorization-code');
    expect(jwtVerifyImpl).toHaveBeenCalledWith('signed-id-token', 'trusted-key-set', {
      issuer: metadata.issuer,
      audience: 'client-id',
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
  });

  it('consumes state once and rejects a mismatched nonce', async () => {
    const fetchImpl = mock(async (url) => String(url).includes('openid-configuration')
      ? jsonResponse(metadata)
      : jsonResponse({ id_token: 'signed-id-token' }));
    const auth = createEntraAuth({
      env: completeEnv,
      fetchImpl,
      createRemoteJWKSetImpl: () => 'trusted-key-set',
      jwtVerifyImpl: async () => ({ payload: { sub: 'subject-1', nonce: 'wrong-nonce' } }),
    });
    const started = await auth.beginAuthorization();

    await expect(auth.completeAuthorization({ code: 'code', state: started.state }))
      .rejects.toThrow('nonce does not match');
    await expect(auth.completeAuthorization({ code: 'code', state: started.state }))
      .rejects.toThrow('invalid or expired');
  });

  it('rejects discovery metadata that leaves the Microsoft identity host', async () => {
    const auth = createEntraAuth({
      env: completeEnv,
      fetchImpl: async () => jsonResponse({ ...metadata, token_endpoint: 'https://attacker.example/token' }),
      createRemoteJWKSetImpl: () => 'unreachable',
    });

    await expect(auth.beginAuthorization()).rejects.toThrow('metadata is invalid');
  });
});
