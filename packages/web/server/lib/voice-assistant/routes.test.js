import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerVoiceAssistantRoutes } from './routes.js';

const createApp = (runTurn, extra = {}) => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  registerVoiceAssistantRoutes(app, {
    runTurn,
    controlService: { execute: vi.fn(), endChromeConversation: vi.fn(), isChromeHostAllowed: vi.fn(async () => false) },
    readSettingsFromDiskMigrated: vi.fn(async () => ({})),
    brokerBaseUrl: 'https://api.example/',
    ensureFreshSession: vi.fn(async () => ({ accessToken: 't' })),
    getOpenCodeClient: vi.fn(),
    chromeControl: { available: false },
    computerControl: { available: false },
    isBrowserMounted: () => false,
    ...extra,
  });
  return app;
};

const valid = { said: 'hello', history: [{ role: 'assistant', text: 'hi' }], locale: 'en', directory: '/repo', sessionId: 'ses_1' };

describe('POST /api/voice/turn', () => {
  it('streams the turn as server-sent events', async () => {
    const runTurn = vi.fn(async ({ emit }) => {
      emit({ type: 'text-delta', text: 'Hi' });
      emit({ type: 'done' });
    });
    const response = await request(createApp(runTurn)).post('/api/voice/turn').send(valid).expect(200);
    expect(response.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(response.headers['cache-control']).toContain('no-cache');
    expect(response.text).toBe('data: {"type":"text-delta","text":"Hi"}\n\ndata: {"type":"done"}\n\n');
    const [input] = runTurn.mock.calls[0];
    expect(input).toMatchObject({ said: 'hello', history: [{ role: 'assistant', text: 'hi' }], locale: 'en', directory: '/repo', sessionId: 'ses_1' });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.deps.buildTools({}).map(({ name }) => name)).toEqual(['mittrcraft', 'mittrcraft_web', 'mittrcraft_voice', 'mittrcraft_end']);
    expect(input.deps.buildTools({ agentControlToolEnabled: false }).map(({ name }) => name)).toEqual(['mittrcraft_web', 'mittrcraft_end']);
  });

  it.each([
    [{ ...valid, said: '' }],
    [{ ...valid, said: 42 }],
    [{ ...valid, locale: 'de' }],
    [{ ...valid, history: 'no' }],
    [{ ...valid, history: [{ role: 'system', text: 'x' }] }],
    [{ ...valid, history: [{ role: 'user', text: 5 }] }],
    [{ ...valid, directory: 5 }],
    [{ ...valid, sessionId: {} }],
    [{ ...valid, queuedPrompts: -1 }],
    [{ ...valid, history: [{ role: 'user', text: 'x'.repeat(20_001) }] }],
  ])('rejects a malformed body %#', async (body) => {
    const runTurn = vi.fn();
    const response = await request(createApp(runTurn)).post('/api/voice/turn').send(body).expect(400);
    expect(response.body).toEqual({ error: 'bad_request' });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('accepts a body with only what was said and the locale', async () => {
    const runTurn = vi.fn(async ({ emit }) => emit({ type: 'done' }));
    await request(createApp(runTurn)).post('/api/voice/turn').send({ said: 'hi', history: [], locale: 'th' }).expect(200);
    expect(runTurn.mock.calls[0][0]).toMatchObject({ said: 'hi', history: [], locale: 'th', directory: undefined, sessionId: undefined });
  });

  it('aborts the turn when the client goes away', async () => {
    let seenSignal = null;
    const aborted = new Promise((resolve) => {
      const runTurn = async ({ signal, emit }) => {
        seenSignal = signal;
        emit({ type: 'text-delta', text: 'working' });
        await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
        resolve();
      };
      const app = createApp(runTurn);
      const server = app.listen(0, async () => {
        const controller = new AbortController();
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/voice/turn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(valid),
          signal: controller.signal,
        });
        const reader = response.body.getReader();
        await reader.read();
        controller.abort();
        aborted.finally(() => server.close());
      });
    });
    await aborted;
    expect(seenSignal.aborted).toBe(true);
  });

  it('ends the stream with an error event when the turn throws', async () => {
    const errorSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTurn = vi.fn(async () => { throw new Error('said: hello'); });
    const response = await request(createApp(runTurn)).post('/api/voice/turn').send(valid).expect(200);
    expect(response.text).toBe('data: {"type":"error","code":"upstream_failed"}\n\n');
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('hello');
    errorSpy.mockRestore();
  });

  it('ends the conversation: clears the voice site grants and the pending site question', async () => {
    const endChromeConversation = vi.fn();
    const conversations = [];
    const runTurn = vi.fn(async ({ deps, emit }) => {
      conversations.push(deps.conversation);
      deps.conversation.pendingApprovalHost = 'example.com';
      emit({ type: 'done' });
    });
    const app = createApp(runTurn, { controlService: { execute: vi.fn(), endChromeConversation, isChromeHostAllowed: vi.fn() } });
    await request(app).post('/api/voice/turn').send(valid).expect(200);
    await request(app).post('/api/voice/turn').send(valid).expect(200);
    expect(conversations[1]).toBe(conversations[0]);
    await request(app).post('/api/voice/end').send({}).expect(204);
    expect(endChromeConversation).toHaveBeenCalledWith('voice');
    expect(conversations[0].pendingApprovalHost).toBeNull();
  });
});
