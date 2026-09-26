import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrAuthRoutes } from './auth-routes.js';

const session = (over = {}) => ({
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 3_600_000,
  subject: { userId: 'u1', displayName: 'Chaiwat' },
  ...over,
});

const memoryStore = (initial = null) => {
  let value = initial;
  return { read: () => value, write: (s) => { value = s; }, clear: () => { value = null; } };
};

const jsonBody = (body, status = 201) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const build = ({ fetchImpl = vi.fn(), store = memoryStore() } = {}) => {
  const app = express();
  // Deliberately no express.json() here. The application does not parse JSON
  // globally, so a harness that parses for the routes proves nothing about
  // whether they work on the real server -- which is how a sign-in that could
  // never complete passed every test.
  const api = registerMittrAuthRoutes(app, {
    brokerBaseUrl: 'https://mittr.test',
    sessionStore: store,
    fetchImpl,
  });
  return { app, api, fetchImpl, store };
};

const startAndCallback = async (app, code = 'abc') => {
  await request(app).post('/api/mittr/auth/start').expect(200);
  return request(app)
    .post('/api/mittr/auth/callback')
    .send({ url: `mittrcraft://auth/callback?code=${code}` });
};

describe('mittr auth routes', () => {
  it('reports signed out before any sign-in', async () => {
    const { app } = build();
    await request(app).get('/api/mittr/auth/status').expect(200, { signedIn: false });
  });

  it('returns an authorize url carrying a challenge and the redirect, and no state', async () => {
    const { app } = build();
    const res = await request(app).post('/api/mittr/auth/start').expect(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin).toBe('https://mittr.test');
    expect(url.pathname).toBe('/auth/desktop/start');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe('mittrcraft://auth/callback');
    expect(url.searchParams.get('state')).toBeNull();
  });

  it('exchanges the code with the verifier and stores the session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonBody(session()));
    const { app, store } = build({ fetchImpl });

    await startAndCallback(app).then((r) => expect(r.status).toBe(200));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://mittr.test/auth/desktop/exchange');
    const body = JSON.parse(init.body);
    expect(body.code).toBe('abc');
    expect(body.code_verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(body.redirect_uri).toBe('mittrcraft://auth/callback');
    expect(store.read().accessToken).toBe('at-1');
  });

  it('signs a dev flavor in on its own deep link, end to end', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonBody(session()));
    const app = express();
    registerMittrAuthRoutes(app, {
      brokerBaseUrl: 'https://mittr.test',
      sessionStore: memoryStore(),
      fetchImpl,
      redirectUri: 'mittrcraft-dev://auth/callback',
    });
    const start = await request(app).post('/api/mittr/auth/start').expect(200);
    expect(new URL(start.body.authorizeUrl).searchParams.get('redirect_uri')).toBe('mittrcraft-dev://auth/callback');
    await request(app)
      .post('/api/mittr/auth/callback')
      .set('content-type', 'application/json')
      .send({ url: 'mittrcraft://auth/callback?code=abc' })
      .expect(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    await request(app).post('/api/mittr/auth/start').expect(200);
    await request(app)
      .post('/api/mittr/auth/callback')
      .set('content-type', 'application/json')
      .send({ url: 'mittrcraft-dev://auth/callback?code=abc' })
      .expect(200);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).redirect_uri).toBe('mittrcraft-dev://auth/callback');
  });

  it('refuses a callback that arrives with no sign-in pending', async () => {
    const { app, fetchImpl } = build();
    await request(app)
      .post('/api/mittr/auth/callback')
      .send({ url: 'mittrcraft://auth/callback?code=abc' })
      .expect(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consumes the transaction so a replayed callback cannot be exchanged twice', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonBody(session()));
    const { app } = build({ fetchImpl });
    await request(app).post('/api/mittr/auth/start').expect(200);
    const body = { url: 'mittrcraft://auth/callback?code=abc' };

    await request(app).post('/api/mittr/auth/callback').send(body).expect(200);
    await request(app).post('/api/mittr/auth/callback').send(body).expect(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected exchange and stores nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const { app, store } = build({ fetchImpl });
    const res = await startAndCallback(app);
    expect(res.status).toBe(401);
    expect(store.read()).toBeNull();
  });

  it('refuses a malformed session payload rather than storing it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonBody({ accessToken: 'at-1' }));
    const { app, store } = build({ fetchImpl });
    const res = await startAndCallback(app);
    expect(res.status).toBe(502);
    expect(store.read()).toBeNull();
  });

  it('reports an unreachable broker as 502, distinct from a rejection', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { app } = build({ fetchImpl });
    const res = await startAndCallback(app);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/mittr/i);
  });

  it('signs out', async () => {
    const store = memoryStore(session());
    const { app } = build({ store });
    await request(app).delete('/api/mittr/auth/session').expect(200, { signedIn: false });
    expect(store.read()).toBeNull();
  });
});

describe('ensureFreshSession', () => {
  it('returns a session that is still valid without calling refresh', async () => {
    const fetchImpl = vi.fn();
    const { api } = build({ fetchImpl, store: memoryStore(session()) });
    await expect(api.ensureFreshSession()).resolves.toMatchObject({ accessToken: 'at-1' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes once when two callers race, and both get the new session', async () => {
    let release;
    const fetchImpl = vi.fn().mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(jsonBody(session({ accessToken: 'at-2', refreshToken: 'rt-2' })));
    }));
    const { api } = build({ fetchImpl, store: memoryStore(session({ expiresAt: Date.now() - 1 })) });

    const both = Promise.all([api.ensureFreshSession(), api.ensureFreshSession()]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    const [first, second] = await both;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.accessToken).toBe('at-2');
    expect(second.accessToken).toBe('at-2');
  });

  it('signs out when the refresh token is rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const store = memoryStore(session({ expiresAt: Date.now() - 1 }));
    const { api } = build({ fetchImpl, store });
    await expect(api.ensureFreshSession()).resolves.toBeNull();
    expect(store.read()).toBeNull();
  });

  it('keeps the session when the broker is merely unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const store = memoryStore(session({ expiresAt: Date.now() - 1 }));
    const { api } = build({ fetchImpl, store });
    await expect(api.ensureFreshSession()).resolves.toMatchObject({ accessToken: 'at-1' });
    expect(store.read()).not.toBeNull();
  });
});
