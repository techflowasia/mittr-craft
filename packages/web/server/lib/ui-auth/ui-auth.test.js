import { afterAll, describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ui-auth-test-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const loadCreateUiAuth = async () => {
  const module = await import('./ui-auth.js');
  return module.createUiAuth;
};

const createResponse = () => {
  let statusCode = 200;
  let body = null;
  const headers = new Map();
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    redirect(code, location) {
      statusCode = code;
      headers.set('location', location);
      return this;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
  };
};

describe('ui auth client credential seam', () => {
  it('accepts bearer client credentials when UI password auth is enabled', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const req = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const res = createResponse();
    let called = false;

    await auth.requireAuth(req, res, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(await auth.ensureSessionToken(req, res)).toBe('client:device-1');
    expect(await auth.resolveAuthContext(req, res, { allowUrlToken: false })).toMatchObject({
      type: 'client',
      clientId: 'device-1',
      token: 'client:device-1',
    });
  });

  it('does not accept bearer client credentials for UI-session-only auth', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const clientReq = { method: 'GET', path: '/api/client-auth/clients', headers: { authorization: 'Bearer client-token' } };
    const clientRes = createResponse();
    let clientCalled = false;
    await auth.requireSessionAuth(clientReq, clientRes, () => {
      clientCalled = true;
    });
    expect(clientCalled).toBe(false);
    expect(clientRes.statusCode).toBe(401);

    const loginReq = { method: 'POST', headers: {}, body: { password: 'secret' } };
    const loginRes = createResponse();
    await auth.handleSessionCreate(loginReq, loginRes);
    const sessionCookie = String(loginRes.getHeader('set-cookie') || '').split(';', 1)[0];
    expect(sessionCookie.startsWith('oc_ui_session=')).toBe(true);

    const sessionReq = { method: 'GET', path: '/api/client-auth/clients', headers: { cookie: sessionCookie } };
    const sessionRes = createResponse();
    let sessionCalled = false;
    await auth.requireSessionAuth(sessionReq, sessionRes, () => {
      sessionCalled = true;
    });
    expect(sessionCalled).toBe(true);
  });

  it('returns the private auth profile for an authenticated bearer client', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const profile = { id: 'object-1', displayName: 'Ada Lovelace', email: 'ada@example.com' };
    const auth = createUiAuth({
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token'
          ? { ok: true, clientId: 'device-1', authProfile: profile }
          : null,
      },
      adAuthController: { enabled: true },
    });
    const res = createResponse();

    await auth.handleAdProfile({ headers: { authorization: 'Bearer client-token' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ profile });
  });

  it('requires one new Microsoft login for a legacy Entra client without a profile', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token'
          ? { ok: true, clientId: 'device-1', client: { id: 'device-1', authMethod: 'entra' }, authProfile: null }
          : null,
      },
      adAuthController: { enabled: true },
    });
    const res = createResponse();

    await auth.handleAdProfile({ headers: { authorization: 'Bearer client-token' } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Microsoft sign-in must be renewed', reauthenticationRequired: true });
  });

  it('expires only the current UI session when logging out', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    const loginRes = createResponse();
    await auth.handleSessionCreate({ method: 'POST', headers: {}, body: { password: 'secret' } }, loginRes);
    const sessionCookie = String(loginRes.getHeader('set-cookie')).split(';', 1)[0];
    const urlTokenRes = createResponse();
    await auth.handleUrlAuthToken({ method: 'POST', headers: { cookie: sessionCookie } }, urlTokenRes);
    const urlToken = urlTokenRes.body.token;
    const req = { method: 'DELETE', headers: { cookie: sessionCookie } };
    const res = createResponse();

    auth.handleSessionDelete(req, res);

    expect(res.body).toEqual({ authenticated: false });
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('set-cookie')).toContain('oc_ui_session=');
    expect(res.getHeader('set-cookie')).toContain('Max-Age=0');

    const tokenReq = { method: 'GET', url: `/api/event?oc_url_token=${urlToken}`, headers: { accept: 'application/json' } };
    const tokenRes = createResponse();
    let tokenAccepted = false;
    await auth.requireAuth(tokenReq, tokenRes, () => {
      tokenAccepted = true;
    });
    expect(tokenAccepted).toBe(false);
    expect(tokenRes.statusCode).toBe(401);
  });

  it('can require bearer client credentials when UI password is disabled', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      requireClientAuth: true,
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, sessionToken: 'remote-session' } : null,
      },
    });

    const allowedReq = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const allowedRes = createResponse();
    let called = false;
    await auth.requireAuth(allowedReq, allowedRes, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(await auth.ensureSessionToken(allowedReq, allowedRes)).toBe('client:remote-session');

    const deniedReq = { method: 'GET', headers: {} };
    const deniedRes = createResponse();
    await auth.requireAuth(deniedReq, deniedRes, () => {});
    expect(deniedRes.statusCode).toBe(401);
    expect(deniedRes.body).toEqual({ error: 'Client authentication required', locked: true, clientAuthRequired: true });
  });

  it('reports authenticated client session status with bearer credentials', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });
    const req = { method: 'GET', headers: { authorization: 'Bearer client-token' } };
    const res = createResponse();

    await auth.handleSessionStatus(req, res);

    expect(res.body).toEqual({ authenticated: true, scope: 'client' });
  });

  it('exchanges bearer credentials for short-lived URL auth tokens', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      password: 'secret',
      clientAuthController: {
        authenticateBearerToken: async (token) => token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
      },
    });

    const oldQueryReq = { method: 'GET', path: '/api/config/settings', url: '/api/config/settings?oc_client_token=client-token', headers: { accept: 'application/json' } };
    const oldQueryRes = createResponse();
    let oldQueryCalled = false;
    await auth.requireAuth(oldQueryReq, oldQueryRes, () => {
      oldQueryCalled = true;
    });
    expect(oldQueryCalled).toBe(false);
    expect(oldQueryRes.statusCode).toBe(401);

    const mintReq = { method: 'POST', path: '/auth/url-token', headers: { authorization: 'Bearer client-token', accept: 'application/json' } };
    const mintRes = createResponse();
    await auth.handleUrlAuthToken(mintReq, mintRes);
    expect(typeof mintRes.body.token).toBe('string');
    expect(mintRes.body.token.startsWith('oc_url_')).toBe(true);
    expect(mintRes.body.expiresAt).toBeGreaterThan(Date.now());
    expect(mintRes.getHeader('cache-control')).toBe('no-store');

    const urlToken = mintRes.body.token;
    const urlReq = { method: 'GET', path: '/api/fs/raw', url: `/api/fs/raw?path=%2Ftmp%2Fimage.png&oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const urlRes = createResponse();
    let urlCalled = false;
    await auth.requireAuth(urlReq, urlRes, () => {
      urlCalled = true;
    });
    expect(urlCalled).toBe(true);
    expect(await auth.ensureSessionToken(urlReq, urlRes)).toBe('client:device-1');
    expect(await auth.resolveAuthContext(urlReq, urlRes, { allowUrlToken: false })).toBe(null);

    const serveReq = { method: 'GET', path: '/api/fs/serve/tmp/index.html', url: `/api/fs/serve/tmp/index.html?oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const serveRes = createResponse();
    let serveCalled = false;
    await auth.requireAuth(serveReq, serveRes, () => {
      serveCalled = true;
    });
    expect(serveCalled).toBe(true);

    const absoluteServeReq = { method: 'GET', path: '/api/fs/serve/Users/test/project/preview-test.html', url: `/api/fs/serve/Users/test/project/preview-test.html?oc_url_token=${encodeURIComponent(urlToken)}`, headers: {} };
    const absoluteServeRes = createResponse();
    let absoluteServeCalled = false;
    await auth.requireAuth(absoluteServeReq, absoluteServeRes, () => {
      absoluteServeCalled = true;
    });
    expect(absoluteServeCalled).toBe(true);

    const mountedServeReq = {
      method: 'GET',
      baseUrl: '/api',
      path: '/fs/serve/Users/test/project/preview-test.html',
      originalUrl: `/api/fs/serve/Users/test/project/preview-test.html?oc_url_token=${encodeURIComponent(urlToken)}`,
      url: `/fs/serve/Users/test/project/preview-test.html?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: {},
    };
    const mountedServeRes = createResponse();
    let mountedServeCalled = false;
    await auth.requireAuth(mountedServeReq, mountedServeRes, () => {
      mountedServeCalled = true;
    });
    expect(mountedServeCalled).toBe(true);

    const dictationWsReq = {
      method: 'GET',
      path: '/api/dictation/ws',
      url: `/api/dictation/ws?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { upgrade: 'websocket' },
    };
    expect(await auth.ensureSessionToken(dictationWsReq, null)).toBe('client:device-1');

    const dictationHttpReq = {
      method: 'GET',
      path: '/api/dictation/ws',
      url: `/api/dictation/ws?oc_url_token=${encodeURIComponent(urlToken)}`,
      headers: { accept: 'application/json' },
    };
    const dictationHttpRes = createResponse();
    let dictationHttpCalled = false;
    await auth.requireAuth(dictationHttpReq, dictationHttpRes, () => {
      dictationHttpCalled = true;
    });
    expect(dictationHttpCalled).toBe(false);
    expect(dictationHttpRes.statusCode).toBe(401);

    const arbitraryGetReq = { method: 'GET', path: '/api/config/settings', url: `/api/config/settings?oc_url_token=${encodeURIComponent(urlToken)}`, headers: { accept: 'application/json' } };
    const arbitraryGetRes = createResponse();
    let arbitraryGetCalled = false;
    await auth.requireAuth(arbitraryGetReq, arbitraryGetRes, () => {
      arbitraryGetCalled = true;
    });
    expect(arbitraryGetCalled).toBe(false);
    expect(arbitraryGetRes.statusCode).toBe(401);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const writeReq = { method, path: '/api/fs/raw', url: `/api/fs/raw?path=%2Ftmp%2Fimage.png&oc_url_token=${encodeURIComponent(urlToken)}`, headers: { accept: 'application/json' } };
      const writeRes = createResponse();
      let writeCalled = false;
      await auth.requireAuth(writeReq, writeRes, () => {
        writeCalled = true;
      });
      expect(writeCalled).toBe(false);
      expect(writeRes.statusCode).toBe(401);
    }
  });

  it('issues desktop client tokens with the UI session expiry', async () => {
    const createUiAuth = await loadCreateUiAuth();
    let createClientInput = null;
    const auth = createUiAuth({
      password: 'secret',
      sessionTtlMs: 123_000,
      clientAuthController: {
        createClient: async (input) => {
          createClientInput = input;
          return {
            token: 'client-token',
            client: {
              id: 'device-1',
              label: input.label,
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: null,
              expiresAt: input.expiresAt,
            },
          };
        },
      },
    });

    const before = Date.now();
    const req = {
      method: 'POST',
      headers: {},
      body: {
        password: 'secret',
        issueClientToken: true,
        clientLabel: 'MittrCraft Desktop',
      },
    };
    const res = createResponse();

    await auth.handleSessionCreate(req, res);

    expect(res.body.clientToken).toBe('client-token');
    expect(createClientInput.label).toBe('MittrCraft Desktop');
    const expiresAt = Date.parse(createClientInput.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 122_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 124_000);
  });
});

describe('ui auth Microsoft Entra seam', () => {
  it('protects the UI with Entra even when no UI password is configured', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const auth = createUiAuth({
      adAuthController: {
        enabled: true,
        configurationPresent: true,
        mode: 'entra',
        getStatus: () => ({ enabled: true, mode: 'entra', loginPath: '/auth/ad/login' }),
        dispose: () => {},
      },
    });
    const req = { method: 'GET', path: '/api/config/settings', headers: { accept: 'application/json' } };
    const res = createResponse();

    await auth.requireAuth(req, res, () => {});

    expect(auth.enabled).toBe(true);
    expect(res.statusCode).toBe(401);
    const statusRes = createResponse();
    auth.handleAdStatus({}, statusRes);
    expect(statusRes.body).toEqual({
      enabled: true,
      mode: 'entra',
      loginPath: '/auth/ad/login',
      passwordEnabled: false,
      desktopHandoff: true,
    });
  });

  it('binds the OIDC callback to its browser transaction and issues a UI session', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const completeAuthorization = mock(async () => ({
      trustDevice: true,
      profile: { id: 'object-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
    }));
    const auth = createUiAuth({
      sessionTtlMs: 60_000,
      adAuthController: {
        enabled: true,
        configurationPresent: true,
        mode: 'entra',
        getStatus: () => ({ enabled: true, mode: 'entra', loginPath: '/auth/ad/login' }),
        beginAuthorization: async () => ({
          authorizationUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=state-1',
          state: 'state-1',
          expiresAt: Date.now() + 60_000,
        }),
        completeAuthorization,
        dispose: () => {},
      },
    });

    const startRes = createResponse();
    await auth.handleAdLoginStart({ headers: {}, query: { trustDevice: 'true' } }, startRes);
    expect(startRes.statusCode).toBe(302);
    expect(startRes.getHeader('location')).toContain('login.microsoftonline.com');
    expect(startRes.getHeader('set-cookie')).toContain('oc_ad_transaction=state-1');
    expect(startRes.getHeader('set-cookie')).toContain('Path=/auth/ad/callback');
    expect(startRes.getHeader('set-cookie')).toContain('SameSite=Lax');

    const callbackRes = createResponse();
    await auth.handleAdCallback({
      headers: { cookie: 'oc_ad_transaction=state-1' },
      query: { state: 'state-1', code: 'authorization-code' },
    }, callbackRes);
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.getHeader('location')).toBe('/');
    expect(completeAuthorization).toHaveBeenCalledWith({ code: 'authorization-code', state: 'state-1' });
    const cookies = callbackRes.getHeader('set-cookie');
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('oc_ad_transaction=;'))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('oc_ui_session='))).toBe(true);
  });

  it('returns a loopback HMR login to the initiating UI origin', async () => {
    const createUiAuth = await loadCreateUiAuth();
    let authorizationInput = null;
    const auth = createUiAuth({
      adAuthController: {
        enabled: true,
        configurationPresent: true,
        mode: 'entra',
        getStatus: () => ({ enabled: true, mode: 'entra', loginPath: '/auth/ad/login' }),
        beginAuthorization: async (input) => {
          authorizationInput = input;
          return {
            authorizationUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=state-hmr',
            state: 'state-hmr',
            expiresAt: Date.now() + 60_000,
          };
        },
        completeAuthorization: async () => ({
          trustDevice: false,
          profile: { displayName: 'Ada Lovelace' },
          returnTo: 'http://localhost:5180/',
        }),
        dispose: () => {},
      },
    });

    const startRes = createResponse();
    await auth.handleAdLoginStart({
      headers: { host: 'localhost:3000', referer: 'http://localhost:5180/' },
      query: { returnTo: 'http://localhost:5180/' },
    }, startRes);
    expect(authorizationInput).toEqual({ trustDevice: false, returnTo: 'http://localhost:5180/' });

    const callbackRes = createResponse();
    await auth.handleAdCallback({
      headers: { cookie: 'oc_ad_transaction=state-hmr' },
      query: { state: 'state-hmr', code: 'authorization-code' },
    }, callbackRes);
    expect(callbackRes.getHeader('location')).toBe('http://localhost:5180/');
  });

  it('rejects an untrusted Microsoft login return target', async () => {
    const createUiAuth = await loadCreateUiAuth();
    let authorizationInput = null;
    const auth = createUiAuth({
      adAuthController: {
        enabled: true,
        configurationPresent: true,
        mode: 'entra',
        getStatus: () => ({ enabled: true, mode: 'entra' }),
        beginAuthorization: async (input) => {
          authorizationInput = input;
          return {
            authorizationUrl: 'https://login.microsoftonline.com/tenant/authorize',
            state: 'state-unsafe',
            expiresAt: Date.now() + 60_000,
          };
        },
        dispose: () => {},
      },
    });
    const res = createResponse();

    await auth.handleAdLoginStart({
      headers: { host: 'localhost:3000', referer: 'http://localhost:5180/' },
      query: { returnTo: 'https://attacker.example/' },
    }, res);

    expect(authorizationInput).toEqual({ trustDevice: false, returnTo: '/' });
  });

  it('rejects callbacks whose state does not match the browser cookie', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const completeAuthorization = mock(async () => ({ trustDevice: false, profile: {} }));
    const auth = createUiAuth({
      adAuthController: {
        enabled: true,
        configurationPresent: true,
        mode: 'entra',
        getStatus: () => ({ enabled: true, mode: 'entra' }),
        completeAuthorization,
        dispose: () => {},
      },
    });
    const res = createResponse();

    await auth.handleAdCallback({
      headers: { cookie: 'oc_ad_transaction=state-for-another-browser' },
      query: { state: 'state-1', code: 'authorization-code' },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('redeems a verified Desktop handoff once without creating a browser session', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const handoffId = 'h'.repeat(43);
    const verifier = 'v'.repeat(43);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const desktopHandoff = { handoffId, challenge };
    let authorizationInput = null;
    let createClientInput = null;
    const auth = createUiAuth({
      sessionTtlMs: 60_000,
      clientAuthController: {
        createClient: async (input) => {
          createClientInput = input;
          return { token: 'desktop-client-token', client: { id: 'desktop-client-1' } };
        },
      },
      adAuthController: {
        enabled: true,
        configurationPresent: true,
        mode: 'entra',
        getStatus: () => ({ enabled: true, mode: 'entra' }),
        beginAuthorization: async (input) => {
          authorizationInput = input;
          return {
            authorizationUrl: 'https://login.microsoftonline.com/tenant/authorize',
            state: 'state-desktop',
            expiresAt: Date.now() + 60_000,
          };
        },
        completeAuthorization: async () => ({
          trustDevice: false,
          profile: { id: 'object-1', displayName: 'Ada Lovelace' },
          desktopHandoff,
        }),
        dispose: () => {},
      },
    });

    const startRes = createResponse();
    await auth.handleAdLoginStart({
      headers: {},
      query: { desktopHandoff: handoffId, desktopChallenge: challenge },
    }, startRes);
    expect(authorizationInput).toEqual({ trustDevice: false, returnTo: '/', desktopHandoff });

    const pendingRes = createResponse();
    await auth.handleAdDesktopRedeem({ body: { handoffId, verifier } }, pendingRes);
    expect(pendingRes.statusCode).toBe(202);

    const callbackRes = createResponse();
    await auth.handleAdCallback({
      headers: { cookie: 'oc_ad_transaction=state-desktop' },
      query: { state: 'state-desktop', code: 'authorization-code' },
    }, callbackRes);
    expect(callbackRes.statusCode).toBe(200);
    expect(callbackRes.getHeader('content-type')).toBe('text/html; charset=utf-8');
    const callbackCookies = callbackRes.getHeader('set-cookie');
    const normalizedCallbackCookies = Array.isArray(callbackCookies) ? callbackCookies : [callbackCookies];
    expect(normalizedCallbackCookies.some((cookie) => cookie?.startsWith('oc_ui_session='))).toBe(false);

    const redeemRes = createResponse();
    await auth.handleAdDesktopRedeem({
      body: { handoffId, verifier, clientLabel: 'MittrCraft Desktop', clientKind: 'desktop' },
    }, redeemRes);
    expect(redeemRes.statusCode).toBe(200);
    expect(redeemRes.body).toMatchObject({
      authenticated: true,
      clientToken: 'desktop-client-token',
      profile: { id: 'object-1', displayName: 'Ada Lovelace' },
    });
    expect(createClientInput).toMatchObject({
      label: 'MittrCraft Desktop',
      clientKind: 'desktop',
      authMethod: 'entra',
      authProfile: { id: 'object-1', displayName: 'Ada Lovelace' },
    });

    const reusedRes = createResponse();
    await auth.handleAdDesktopRedeem({ body: { handoffId, verifier } }, reusedRes);
    expect(reusedRes.statusCode).toBe(409);
  });

  it('rejects malformed Desktop handoffs and invalid verifiers', async () => {
    const createUiAuth = await loadCreateUiAuth();
    const handoffId = 'h'.repeat(43);
    const verifier = 'v'.repeat(43);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const auth = createUiAuth({
      adAuthController: {
        enabled: true,
        configurationPresent: true,
        mode: 'entra',
        getStatus: () => ({ enabled: true, mode: 'entra' }),
        beginAuthorization: async () => ({
          authorizationUrl: 'https://login.microsoftonline.com/tenant/authorize',
          state: 'state-desktop-invalid',
          expiresAt: Date.now() + 60_000,
        }),
        dispose: () => {},
      },
    });

    const malformedRes = createResponse();
    await auth.handleAdLoginStart({
      headers: {},
      query: { desktopHandoff: 'short', desktopChallenge: challenge },
    }, malformedRes);
    expect(malformedRes.statusCode).toBe(400);

    const startRes = createResponse();
    await auth.handleAdLoginStart({
      headers: {},
      query: { desktopHandoff: handoffId, desktopChallenge: challenge },
    }, startRes);
    const invalidVerifierRes = createResponse();
    await auth.handleAdDesktopRedeem({ body: { handoffId, verifier: 'x'.repeat(43) } }, invalidVerifierRes);
    expect(invalidVerifierRes.statusCode).toBe(401);
  });
});
