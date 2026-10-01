import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrShimRoutes } from './shim-routes.js';
import { createAnsweredByLog } from '../mittr-quota/answered-by.js';

const createApp = (fetchImpl, session = { accessToken: 'at-1' }) => {
  const app = express();
  // Deliberately no express.json() here. The application does not parse JSON
  // globally, so a harness that parses for the routes proves nothing about
  // whether they work on the real server -- which is how a sign-in that could
  // never complete passed every test.
  registerMittrShimRoutes(app, {
    upstream: { baseUrl: 'https://upstream.test/v1' },
    localToken: 'mc_local_abc',
    ensureFreshSession: async () => session,
    fetchImpl,
  });
  return app;
};

const post = (app, body) => request(app)
  .post('/v1/chat/completions')
  .set('authorization', 'Bearer mc_local_abc')
  .send(body);

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

describe('mittr shim refusals', () => {
  const refused = (error) => vi.fn().mockResolvedValue(new Response(JSON.stringify({ error }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  }));

  it('forwards a refusal body untouched, because the engine parses it', async () => {
    const res = await post(createApp(refused('agent_not_granted')), { model: 'pm_9f2c1d4e7b', messages: [] })
      .expect(403);
    expect(JSON.parse(res.text)).toEqual({ error: 'agent_not_granted' });
  });

  it('names a stale catalog as repairable and an entitlement as not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await post(createApp(refused('agent_not_granted')), { model: 'pm_9f2c1d4e7b', messages: [] }).expect(403);
      expect(warn.mock.calls.at(-1)[0]).toMatch(/re-sync/);

      await post(createApp(refused('desktop_entitlement_required')), { model: 'pm_9f2c1d4e7b', messages: [] }).expect(403);
      expect(warn.mock.calls.at(-1)[0]).toMatch(/admin/);
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when the refusal is one it cannot name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await post(createApp(refused('some_other_problem')), { model: 'pm_9f2c1d4e7b', messages: [] }).expect(403);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mittr shim weekly quota', () => {
  const RESETS_AT = '2026-10-04T17:00:00.000Z';
  const quotaEnvelope = {
    error: {
      type: 'insufficient_quota',
      code: 'llm_quota_exhausted',
      message: 'โควตาหมด',
      resets_at: RESETS_AT,
      model: 'MITTR 2.0',
    },
  };
  const engineRefusal = {
    error: {
      type: 'insufficient_quota',
      code: 'llm_quota_exhausted',
      message: 'Weekly model quota used up',
      kind: 'chat',
      resets_at: RESETS_AT,
    },
  };

  it('turns a quota 429 into a status the engine does not retry, keeping what the app reads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(quotaEnvelope, 429));
    const res = await post(createApp(fetchImpl), { model: 'pm_9f2c1d4e7b', messages: [] }).expect(402);
    expect(JSON.parse(res.text)).toEqual(engineRefusal);
  });

  it('does the same when the engine asked for a stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(quotaEnvelope, 429));
    const res = await post(createApp(fetchImpl), { model: 'pm_9f2c1d4e7b', messages: [], stream: true }).expect(402);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(res.text).error.resets_at).toBe(RESETS_AT);
  });

  it('recognises the flat platform body too', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      code: 'llm_quota_exhausted', modelKey: 'm', kind: 'chat', label: 'MITTR 2.0', resetsAt: RESETS_AT, message: 'โควตาหมด',
    }, 429));
    const res = await post(createApp(fetchImpl), { model: 'pm_9f2c1d4e7b', messages: [] }).expect(402);
    expect(JSON.parse(res.text)).toEqual(engineRefusal);
  });

  it('leaves an ordinary rate limit as a 429 the engine may retry', async () => {
    const body = { error: { type: 'rate_limit_exceeded', code: 'rate_limit', message: 'slow down' } };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body, 429));
    const res = await post(createApp(fetchImpl), { model: 'pm_9f2c1d4e7b', messages: [], stream: true }).expect(429);
    expect(JSON.parse(res.text)).toEqual(body);
  });

  it('rewrites a quota frame that arrives after the stream started', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      `data: ${JSON.stringify(quotaEnvelope).slice(0, 20)}`,
      `${JSON.stringify(quotaEnvelope).slice(20)}\n\n`,
      'data: [DONE]\n\n',
    ]));
    const res = await post(createApp(fetchImpl), { model: 'pm_9f2c1d4e7b', messages: [], stream: true }).expect(200);
    const frames = res.text.split('\n\n').filter(Boolean);
    expect(frames[0]).toBe('data: {"choices":[{"delta":{"content":"he"}}]}');
    const refusal = JSON.parse(frames[1].slice('data: '.length));
    expect(JSON.parse(refusal.error.message).error).toMatchObject({ code: 'insufficient_quota', resets_at: RESETS_AT });
    expect(frames[2]).toBe('data: [DONE]');
  });
});

describe('mittr shim answered by a substitute', () => {
  const ANSWERED_BY = {
    substituted: true,
    requestedLabel: 'MITTR 1.0',
    answeredLabel: 'MittrCraft 1.0',
    answeredKey: 'mittr-craft-1-0',
    reason: 'quota',
    notice: 'โควตา MITTR 1.0 สัปดาห์นี้หมดแล้ว',
  };

  const createLoggedApp = (fetchImpl) => {
    const answeredByLog = createAnsweredByLog();
    const app = express();
    registerMittrShimRoutes(app, {
      upstream: { baseUrl: 'https://upstream.test/v1' },
      localToken: 'mc_local_abc',
      ensureFreshSession: async () => ({ accessToken: 'at-1' }),
      answeredByLog,
      now: () => 5000,
      fetchImpl,
    });
    return { app, answeredByLog };
  };

  const postFor = (app, sessionId, body) => post(app, body).set('x-session-id', sessionId);

  const remembered = {
    at: 5000,
    model: 'mittr-1',
    requestedLabel: 'MITTR 1.0',
    answeredLabel: 'MittrCraft 1.0',
    reason: 'quota',
  };

  it('remembers a substitute on a streamed answer and forwards every byte unchanged', async () => {
    const chunks = [
      ': keep-alive\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'he' } }], answered_by: ANSWERED_BY })}\n\n`,
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { app, answeredByLog } = createLoggedApp(vi.fn().mockResolvedValue(sseResponse(chunks)));
    const res = await postFor(app, 'ses_1', { model: 'mittr-1', messages: [], stream: true }).expect(200);
    expect(res.text).toBe(chunks.join(''));
    expect(answeredByLog.list('ses_1')).toEqual([remembered]);
  });

  it('remembers a substitute on a non-streamed answer and returns the body unchanged', async () => {
    const body = { choices: [{ message: { content: 'hello' } }], answered_by: ANSWERED_BY };
    const { app, answeredByLog } = createLoggedApp(vi.fn().mockResolvedValue(jsonResponse(body)));
    const res = await postFor(app, 'ses_2', { model: 'mittr-1', messages: [] }).expect(200);
    expect(JSON.parse(res.text)).toEqual(body);
    expect(answeredByLog.list('ses_2')).toEqual([remembered]);
  });

  it('remembers nothing when the chosen model answered itself', async () => {
    const { app, answeredByLog } = createLoggedApp(vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    await postFor(app, 'ses_3', { model: 'mittr-1', messages: [], stream: true }).expect(200);
    expect(answeredByLog.list('ses_3')).toEqual([]);
  });

  it('remembers nothing when the engine named no session', async () => {
    const body = { choices: [{ message: { content: 'hello' } }], answered_by: ANSWERED_BY };
    const { app, answeredByLog } = createLoggedApp(vi.fn().mockResolvedValue(jsonResponse(body)));
    const record = vi.spyOn(answeredByLog, 'record');
    await post(app, { model: 'mittr-1', messages: [] }).expect(200);
    expect(record).not.toHaveBeenCalled();
  });
});
