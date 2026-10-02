import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerMittrAuthRoutes } from './auth-routes.js';
import { createAccountStore } from './account-store.js';

const encrypt = (text) => Buffer.from(text, 'utf8');
const decrypt = (buffer) => Buffer.from(buffer).toString('utf8');

const sessionFor = (userId, displayName, over = {}) => ({
  accessToken: `at-${userId}`,
  refreshToken: `rt-${userId}`,
  expiresAt: Date.now() + 3_600_000,
  subject: { userId, displayName },
  ...over,
});

const jsonBody = (body, status = 201) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-auth-accounts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const build = ({ fetchImpl = vi.fn() } = {}) => {
  const store = createAccountStore({ dataDir: dir, encrypt, decrypt });
  const onSignIn = vi.fn();
  const onAccountChange = vi.fn();
  const app = express();
  const api = registerMittrAuthRoutes(app, {
    brokerBaseUrl: 'https://mittr.test',
    sessionStore: store,
    fetchImpl,
    onSignIn,
    onAccountChange,
  });
  return { app, api, store, onSignIn, onAccountChange };
};

const signIn = async (app) => {
  await request(app).post('/api/mittr/auth/start').expect(200);
  return request(app).post('/api/mittr/auth/callback').send({ url: 'mittrcraft://auth/callback?code=abc' });
};

describe('several Mittr accounts on one machine', () => {
  it('lists every signed-in account and which one is in use', async () => {
    const { app, store } = build();
    store.write(sessionFor('u1', 'Chaiwat'));
    store.write(sessionFor('u2', 'Chaiwat (test)'));

    await request(app).get('/api/mittr/auth/accounts').expect(200, {
      accounts: [
        { userId: 'u1', displayName: 'Chaiwat', active: false },
        { userId: 'u2', displayName: 'Chaiwat (test)', active: true },
      ],
    });
  });

  it('signing in a second account keeps the first and switches to the new one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonBody(sessionFor('u2', 'Chaiwat (test)')));
    const { app, store, onAccountChange, onSignIn } = build({ fetchImpl });
    store.write(sessionFor('u1', 'Chaiwat'));

    const res = await signIn(app);

    expect(res.body).toEqual({ signedIn: true, userId: 'u2', displayName: 'Chaiwat (test)' });
    expect(store.list().map((account) => account.userId)).toEqual(['u1', 'u2']);
    expect(onAccountChange).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('signing in again as the account in use only refreshes it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonBody(sessionFor('u1', 'Chaiwat')));
    const { app, store, onAccountChange, onSignIn } = build({ fetchImpl });
    store.write(sessionFor('u1', 'Chaiwat'));

    await signIn(app);

    expect(onAccountChange).not.toHaveBeenCalled();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('switches to another signed-in account', async () => {
    const { app, store, onAccountChange } = build();
    store.write(sessionFor('u1', 'Chaiwat'));
    store.write(sessionFor('u2', 'Chaiwat (test)'));

    await request(app)
      .post('/api/mittr/auth/accounts/activate')
      .send({ userId: 'u1' })
      .expect(200, { signedIn: true, userId: 'u1', displayName: 'Chaiwat' });

    expect(store.read().subject.userId).toBe('u1');
    expect(onAccountChange).toHaveBeenCalledTimes(1);
  });

  it('refuses to switch to an account that is not signed in here', async () => {
    const { app, onAccountChange } = build();
    await request(app).post('/api/mittr/auth/accounts/activate').send({ userId: 'nobody' }).expect(404);
    expect(onAccountChange).not.toHaveBeenCalled();
  });

  it('signing out the account in use moves to the one still signed in', async () => {
    const { app, store, onAccountChange } = build();
    store.write(sessionFor('u1', 'Chaiwat'));
    store.write(sessionFor('u2', 'Chaiwat (test)'));

    await request(app)
      .delete('/api/mittr/auth/session')
      .expect(200, { signedIn: true, userId: 'u1', displayName: 'Chaiwat' });

    expect(onAccountChange).toHaveBeenCalledTimes(1);
  });

  it('a token refreshed after a switch does not switch back', async () => {
    let answer;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const { api, store } = build({ fetchImpl });
    store.write(sessionFor('u2', 'Chaiwat (test)'));
    store.write(sessionFor('u1', 'Chaiwat', { expiresAt: Date.now() }));

    const pending = api.ensureFreshSession();
    store.activate('u2');
    answer(jsonBody(sessionFor('u1', 'Chaiwat', { accessToken: 'at-u1-new' }), 200));
    await pending;

    expect(store.read().subject.userId).toBe('u2');
    store.activate('u1');
    expect(store.read().accessToken).toBe('at-u1-new');
  });

  it('a rejected refresh signs out the account it belonged to, not the one in use', async () => {
    let answer;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const { api, store } = build({ fetchImpl });
    store.write(sessionFor('u2', 'Chaiwat (test)'));
    store.write(sessionFor('u1', 'Chaiwat', { expiresAt: Date.now() }));

    const pending = api.ensureFreshSession();
    store.activate('u2');
    answer(new Response('', { status: 401 }));
    await pending;

    expect(store.list()).toEqual([{ userId: 'u2', displayName: 'Chaiwat (test)', active: true }]);
  });
});
