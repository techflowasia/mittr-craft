import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrShimRoutes } from './shim-routes.js';

const createApp = (fetchImpl) => {
  const app = express();
  app.use(express.json());
  registerMittrShimRoutes(app, {
    upstream: { baseUrl: 'https://upstream.test/v1', token: 'sk-upstream' },
    localToken: 'mc_local_abc',
    fetchImpl,
  });
  return app;
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('mittr shim routes', () => {
  it('rejects a request without the local token', async () => {
    const fetchImpl = vi.fn();
    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .send({ model: 'mittr-craft-1-0', messages: [] })
      .expect(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards an authorised request and swaps in the upstream credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));

    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200, { choices: [] });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://upstream.test/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-upstream');
    expect(JSON.parse(init.body).model).toBe('mittr-craft-1-0');
  });

  it('never leaks the local token upstream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));
    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [] });
    expect(JSON.stringify(fetchImpl.mock.calls[0][1])).not.toContain('mc_local_abc');
  });

  it('passes an upstream failure through with its status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'agent_not_granted' }, 403)
    );
    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [] })
      .expect(403, { error: 'agent_not_granted' });
  });

  it('reports an unreachable upstream as 502, not 500', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [] })
      .expect(502);
    expect(res.body.error).toMatch(/Mittr/);
  });
});

const sseResponse = (chunks) => new Response(
  new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

describe('mittr shim streaming', () => {
  it('passes server-sent events through and keeps their order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));

    const res = await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [], stream: true })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text.indexOf('"he"')).toBeLessThan(res.text.indexOf('"llo"'));
    expect(res.text).toContain('data: [DONE]');
  });

  it('disables buffering so a proxy in front cannot re-buffer the stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const res = await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [], stream: true })
      .expect(200);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['x-accel-buffering']).toBe('no');
  });
});
