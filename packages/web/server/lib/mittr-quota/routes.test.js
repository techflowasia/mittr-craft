import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerMittrQuotaRoutes } from './routes.js';

const QUOTA = {
  weekStart: '2026-09-27T17:00:00.000Z',
  resetsAt: '2026-10-04T17:00:00.000Z',
  lines: [
    { modelKey: 'mittr-2', kind: 'chat', label: 'MITTR 2.0', used: 1200, limit: 500000, source: 'group' },
    { modelKey: 'asr', kind: 'stt', label: 'Voice', used: 30, limit: 600, source: 'default' },
  ],
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const createApp = ({ fetchImpl = vi.fn(async () => json(QUOTA)), session = { accessToken: 'token-1' }, brokerBaseUrl = 'https://api.example/' } = {}) => {
  const app = express();
  registerMittrQuotaRoutes(app, { brokerBaseUrl, ensureFreshSession: async () => session, fetchImpl });
  return { app, fetchImpl };
};

describe('GET /api/mittr/quota/me', () => {
  it('reads this week from the platform with the desktop session', async () => {
    const { app, fetchImpl } = createApp();
    const response = await request(app).get('/api/mittr/quota/me');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(QUOTA);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example/api/quota/me');
    expect(init.headers.Authorization).toBe('Bearer token-1');
  });

  it('drops lines it cannot read instead of failing the week', async () => {
    const fetchImpl = vi.fn(async () => json({
      ...QUOTA,
      lines: [...QUOTA.lines, { modelKey: 'x', kind: 'video', label: 'X', used: 1, limit: 2, source: 'user' }, { kind: 'chat' }],
    }));
    const response = await request(createApp({ fetchImpl }).app).get('/api/mittr/quota/me');
    expect(response.body.lines).toEqual(QUOTA.lines);
  });

  it('keeps role names, the agents behind a model and each agent status', async () => {
    const body = {
      ...QUOTA,
      lines: [
        { modelKey: 'm:abc', kind: 'chat', label: '', labelKey: 'quota.role.decision', used: 10, limit: 100, source: 'default', agents: [{ key: 'assistant', label: 'General Assistant' }, { key: 'bad' }] },
        { modelKey: 'm:def', kind: 'chat', label: '', labelKey: '<script>', used: 1, limit: 100, source: 'default' },
      ],
      agentStatus: {
        assistant: { modelKey: 'm:abc', left: 90, limit: 100, resetsAt: QUOTA.resetsAt, state: 'near', percentLeft: 9 },
        writer: { modelKey: 'm:def', left: 0, limit: 100, resetsAt: QUOTA.resetsAt, state: 'substitute', substituteLabel: 'MITTR 1.0 fast' },
        broken: { modelKey: 'm:def', state: 'gone' },
      },
    };
    const response = await request(createApp({ fetchImpl: vi.fn(async () => json(body)) }).app).get('/api/mittr/quota/me');
    expect(response.body.lines).toEqual([
      { modelKey: 'm:abc', kind: 'chat', label: '', labelKey: 'quota.role.decision', used: 10, limit: 100, source: 'default', agents: [{ key: 'assistant', label: 'General Assistant' }] },
      { modelKey: 'm:def', kind: 'chat', label: '', used: 1, limit: 100, source: 'default' },
    ]);
    expect(response.body.agentStatus).toEqual({
      assistant: body.agentStatus.assistant,
      writer: body.agentStatus.writer,
    });
  });

  it('answers not_signed_in without a session and without calling the platform', async () => {
    const { app, fetchImpl } = createApp({ session: null });
    const response = await request(app).get('/api/mittr/quota/me');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ reasonCode: 'not_signed_in' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers not_signed_in when the platform refuses the session', async () => {
    const response = await request(createApp({ fetchImpl: vi.fn(async () => json({ message: 'no' }, 401)) }).app).get('/api/mittr/quota/me');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ reasonCode: 'not_signed_in' });
  });

  it('answers not_configured when this install has no platform, and unreachable when it cannot be reached', async () => {
    const none = await request(createApp({ brokerBaseUrl: '' }).app).get('/api/mittr/quota/me');
    expect(none.status).toBe(503);
    expect(none.body).toMatchObject({ reasonCode: 'not_configured' });
    const down = await request(createApp({ fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) }).app).get('/api/mittr/quota/me');
    expect(down.status).toBe(502);
    expect(down.body).toMatchObject({ reasonCode: 'unreachable' });
  });

  it('never answers a failed read as an empty week', async () => {
    const broken = await request(createApp({ fetchImpl: vi.fn(async () => json({ nope: true })) }).app).get('/api/mittr/quota/me');
    expect(broken.status).toBe(502);
    expect(broken.body).toMatchObject({ reasonCode: 'upstream_failed' });
    const failed = await request(createApp({ fetchImpl: vi.fn(async () => json({}, 500)) }).app).get('/api/mittr/quota/me');
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ reasonCode: 'upstream_failed' });
  });

  it('answers not_available when the platform has no quota route yet', async () => {
    const response = await request(createApp({ fetchImpl: vi.fn(async () => json({}, 404)) }).app).get('/api/mittr/quota/me');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ reasonCode: 'not_available' });
  });
});
