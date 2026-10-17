import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ui-auth-providers-test-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;

const handles = [];

afterEach(() => {
  while (handles.length > 0) handles.pop().unregister();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const loadUiAuth = () => import('./ui-auth.js');

const register = async (id) => {
  const { registerUiAuthProvider } = await loadUiAuth();
  const handle = registerUiAuthProvider({ id });
  handles.push(handle);
  return handle;
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
    type() {
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const setCookies = (res) => {
  const value = res.getHeader('set-cookie');
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const cookieHeaderFrom = (res) => setCookies(res).map((cookie) => cookie.split(';')[0]).join('; ');

const apiRequest = (headers = {}) => ({ method: 'GET', path: '/api/x', originalUrl: '/api/x', url: '/api/x', headers });

describe('ui auth providers registered at run time', () => {
  it('no provider keeps upstream behaviour', async () => {
    const { createUiAuth } = await loadUiAuth();
    const auth = createUiAuth({});
    let called = false;
    const res = createResponse();

    await auth.requireAuth(apiRequest(), res, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(auth.enabled).toBe(false);
    const status = createResponse();
    await auth.handleSessionStatus(apiRequest(), status);
    expect(status.body).toEqual({ authenticated: true, disabled: true });
    const login = createResponse();
    auth.handleSessionCreate({ body: { password: 'x' }, headers: {} }, login);
    expect(login.statusCode).toBe(400);
    expect(login.body).toEqual({ error: 'UI password not configured' });
    expect(fs.existsSync(path.join(dataDir, 'jwt-secret'))).toBe(false);
  });

  it('a registered provider makes the session required', async () => {
    const { createUiAuth } = await loadUiAuth();
    const auth = createUiAuth({});
    await register('company');
    let called = false;
    const res = createResponse();

    await auth.requireAuth(apiRequest(), res, () => {
      called = true;
    });

    expect(called).toBe(false);
    expect(auth.enabled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'UI authentication required', locked: true });
    expect(await auth.resolveAuthContext(apiRequest(), createResponse(), {})).toBeNull();
    expect(await auth.ensureSessionToken(apiRequest(), createResponse())).toBeNull();
    const urlToken = createResponse();
    await auth.handleUrlAuthToken({ method: 'POST', headers: {}, body: {} }, urlToken);
    expect(urlToken.statusCode).toBe(401);
    const login = createResponse();
    auth.handleSessionCreate({ body: { password: 'x' }, headers: {} }, login);
    expect(login.body).toEqual({ error: 'UI password not configured' });
  });

  it('issueSession then requireAuth passes', async () => {
    const { createUiAuth } = await loadUiAuth();
    const auth = createUiAuth({});
    const handle = await register('company');
    const issued = createResponse();
    issued.setHeader('Set-Cookie', 'other=1; Path=/other');

    await handle.issueSession(apiRequest(), issued, { claims: { username: 'ada' } });

    expect(setCookies(issued)[0]).toBe('other=1; Path=/other');
    const sessionCookie = setCookies(issued)[1];
    expect(sessionCookie).toMatch(/^oc_ui_session=/);
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain(`Max-Age=${12 * 60 * 60}`);
    const cookie = cookieHeaderFrom(issued);
    let called = false;
    await auth.requireAuth(apiRequest({ cookie }), createResponse(), () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(await handle.readClaims(apiRequest({ cookie }))).toEqual({ username: 'ada' });
    expect(await auth.resolveAuthContext(apiRequest({ cookie }), createResponse(), {})).toMatchObject({ type: 'session' });

    const trusted = createResponse();
    await handle.issueSession(apiRequest(), trusted, { trustDevice: true });
    expect(setCookies(trusted)[0]).toContain(`Max-Age=${7 * 24 * 60 * 60}`);

    const cleared = createResponse();
    handle.clearSession(apiRequest({ cookie }), cleared);
    expect(setCookies(cleared)[0]).toMatch(/^oc_ui_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
  });

  it('a forged or foreign session is refused', async () => {
    const { createUiAuth } = await loadUiAuth();
    const auth = createUiAuth({});
    const handle = await register('company');
    const other = await register('other');
    const issued = createResponse();
    await other.issueSession(apiRequest(), issued, { claims: { username: 'eve' } });
    const cookie = cookieHeaderFrom(issued);

    expect(await handle.readClaims(apiRequest({ cookie }))).toBeNull();
    other.unregister();
    let called = false;
    await auth.requireAuth(apiRequest({ cookie }), createResponse(), () => {
      called = true;
    });
    expect(called).toBe(false);

    const forged = `oc_ui_session=${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"type":"ui-session","provider":"company"}').toString('base64url')}.`;
    await auth.requireAuth(apiRequest({ cookie: forged }), createResponse(), () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(await handle.readClaims(apiRequest({ cookie: forged }))).toBeNull();
  });

  it('status lists providers and says whether a password is set', async () => {
    const { createUiAuth } = await loadUiAuth();
    const auth = createUiAuth({});
    await register('company');

    const res = createResponse();
    await auth.handleSessionStatus(apiRequest(), res);

    expect(res.statusCode).toBe(401);
    expect(res.body.providers).toContain('company');
    expect(res.body.passwordEnabled).toBe(false);
    expect(res.body).toMatchObject({ authenticated: false, locked: true });

    const withPassword = createUiAuth({ password: 'secret' });
    const passwordStatus = createResponse();
    await withPassword.handleSessionStatus(apiRequest(), passwordStatus);
    expect(passwordStatus.body).toEqual({ authenticated: false, locked: true, providers: ['company'], passwordEnabled: true });
    withPassword.dispose();
  });

  it('a provider session opens a password-protected server too', async () => {
    const { createUiAuth } = await loadUiAuth();
    const auth = createUiAuth({ password: 'secret' });
    const handle = await register('company');
    const issued = createResponse();
    await handle.issueSession(apiRequest(), issued, {});
    let called = false;

    await auth.requireAuth(apiRequest({ cookie: cookieHeaderFrom(issued) }), createResponse(), () => {
      called = true;
    });

    expect(called).toBe(true);
    auth.dispose();
  });

  it('refuses a duplicate or malformed id', async () => {
    const { registerUiAuthProvider } = await loadUiAuth();
    await register('company');

    expect(() => registerUiAuthProvider({ id: 'company' })).toThrow();
    expect(() => registerUiAuthProvider({ id: '' })).toThrow();
    expect(() => registerUiAuthProvider({})).toThrow();
  });
});
