import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrAuditRoutes } from './audit-routes.js';

const createApp = (fetchImpl, session = { accessToken: 'at-1' }) => {
  const app = express();
  // Deliberately no express.json() here. The application does not parse JSON
  // globally, so a harness that parses for the routes proves nothing about
  // whether they work on the real server -- which is how a sign-in that could
  // never complete passed every test.
  registerMittrAuditRoutes(app, {
    brokerBaseUrl: 'https://mittr.test',
    ensureFreshSession: async () => session,
    resolveRepository: async () => 'techflowasia/mittr-craft',
    fetchImpl,
  });
  return app;
};

const ok = () => new Response(null, { status: 204 });

describe('mittr audit routes', () => {
  it('sends one record on finish, not one per event', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);

    await request(app).post('/api/mittr/audit/prompt').send({ sessionId: 's1', text: 'do the thing' }).expect(204);
    await request(app).post('/api/mittr/audit/tool').send({ sessionId: 's1', name: 'edit' }).expect(204);
    expect(fetchImpl).not.toHaveBeenCalled();

    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://mittr.test/desktop/audit');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.prompts[0].text).toBe('do the thing');
    expect(body.actions).toEqual([{ tool: 'edit', count: 1 }]);
    expect(body.repository).toBe('techflowasia/mittr-craft');
  });

  it('carries the model alias through untouched', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await request(createApp(fetchImpl)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo', model: 'pm_9f2c1d4e7b' })
      .expect(204);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('pm_9f2c1d4e7b');
  });

  it('counts turns and tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);
    await request(app).post('/api/mittr/audit/turn').send({ sessionId: 's1', tokens: 1200 }).expect(204);
    await request(app).post('/api/mittr/audit/turn').send({ sessionId: 's1', tokens: 800 }).expect(204);
    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.turns).toBe(2);
    expect(body.tokens).toBe(2000);
  });

  it('keeps sessions apart so one record is never merged into another', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);
    await request(app).post('/api/mittr/audit/prompt').send({ sessionId: 's1', text: 'one' }).expect(204);
    await request(app).post('/api/mittr/audit/prompt').send({ sessionId: 's2', text: 'two' }).expect(204);
    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.prompts.map((p) => p.text)).toEqual(['one']);
  });

  it('never sends a field outside the allowlist even if the client supplies one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);
    await request(app).post('/api/mittr/audit/prompt').send({ sessionId: 's1', text: 'hi' }).expect(204);
    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo', fileContents: 'const secret = 1;' })
      .expect(204);
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('secret');
  });

  it('does not send anything the client claims about identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);
    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo', userId: 'somebody-else' })
      .expect(204);
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('somebody-else');
  });

  it('never sends the local directory it was given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await request(createApp(fetchImpl)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/Users/someone/client-secret' })
      .expect(204);
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('client-secret');
  });

  it('answers 204 even when the broker rejects the record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await request(createApp(fetchImpl)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
  });

  it('answers 204 even when the broker is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await request(createApp(fetchImpl)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
  });

  it('drops the record when nobody is signed in', async () => {
    const fetchImpl = vi.fn();
    await request(createApp(fetchImpl, null)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
