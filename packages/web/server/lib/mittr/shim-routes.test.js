import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrShimRoutes } from './shim-routes.js';

const createApp = (fetchImpl, session = { accessToken: 'at-1' }) => {
  const app = express();
  app.use(express.json());
  registerMittrShimRoutes(app, {
    upstream: { baseUrl: 'https://upstream.test/v1' },
    localToken: 'mc_local_abc',
    ensureFreshSession: async () => session,
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
    expect(init.headers.authorization).toBe('Bearer at-1');
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

  it('answers 401 with a sign-in hint when nobody is signed in', async () => {
    const fetchImpl = vi.fn();
    const res = await request(createApp(fetchImpl, null))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [] })
      .expect(401);
    expect(res.body.error).toMatch(/sign in/i);
    expect(fetchImpl).not.toHaveBeenCalled();
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

describe('mittr shim markup detection', () => {
  const post = (app, body) => request(app)
    .post('/v1/chat/completions')
    .set('authorization', 'Bearer mc_local_abc')
    .send(body);

  it('reports a tool call that came back as text, and forwards the bytes untouched', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<|tool_"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"call>call:read_file{}"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post(createApp(vi.fn().mockResolvedValue(sseResponse(chunks))), {
        model: 'mittr-craft-1-0', messages: [], stream: true,
      }).expect(200);

      // The detector must not be a filter: what the engine receives is exactly
      // what the gateway sent, markup and all.
      expect(res.text).toBe(chunks.join(''));
      expect(error).toHaveBeenCalled();
      expect(error.mock.calls[0][0]).toMatch(/emitted a tool call as text/);
    } finally {
      error.mockRestore();
    }
  });

  it('stays quiet about markup when the tool call actually arrived', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"<|channel>thought"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await post(createApp(vi.fn().mockResolvedValue(sseResponse(chunks))), {
        model: 'mittr-craft-1-0', messages: [], stream: true,
      }).expect(200);
      expect(error).not.toHaveBeenCalled();
      // Still worth a word: the transcript carries markup a reader will see.
      expect(warn).toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('reports the same failure on a non-streamed answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
        choices: [{ message: { content: '<function=read_file><parameter=path>x</parameter></function>' } }],
      }));
      await post(createApp(fetchImpl), { model: 'mittr-craft-1-0', messages: [] }).expect(200);
      expect(error.mock.calls[0][0]).toMatch(/emitted a tool call as text/);
    } finally {
      error.mockRestore();
    }
  });

  it('says nothing about an ordinary answer', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
        choices: [{ message: { content: 'The version is 4.2.1.' } }],
      }));
      await post(createApp(fetchImpl), { model: 'mittr-craft-1-0', messages: [] }).expect(200);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
