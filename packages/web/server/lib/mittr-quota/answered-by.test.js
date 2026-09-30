import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createAnsweredByLog, createAnsweredByWatcher, readAnsweredBy, sessionIdOf } from './answered-by.js';
import { registerMittrAnsweredByRoutes } from './routes.js';

const ANSWERED_BY = {
  substituted: true,
  requestedLabel: 'MITTR 1.0',
  answeredLabel: 'MittrCraft 1.0',
  answeredKey: 'mittr-craft-1-0',
  reason: 'quota',
  notice: 'โควตาหมด',
};

const encode = (text) => new TextEncoder().encode(text);

describe('readAnsweredBy', () => {
  it('reads a substitution from a body or its JSON text', () => {
    const expected = { requestedLabel: 'MITTR 1.0', answeredLabel: 'MittrCraft 1.0', reason: 'quota' };
    expect(readAnsweredBy({ choices: [], answered_by: ANSWERED_BY })).toEqual(expected);
    expect(readAnsweredBy(JSON.stringify({ choices: [], answered_by: ANSWERED_BY }))).toEqual(expected);
  });

  it('ignores answers that were not substituted or cannot be named', () => {
    expect(readAnsweredBy({ choices: [] })).toBeNull();
    expect(readAnsweredBy({ answered_by: { ...ANSWERED_BY, substituted: false } })).toBeNull();
    expect(readAnsweredBy({ answered_by: { ...ANSWERED_BY, answeredLabel: ' ' } })).toBeNull();
    expect(readAnsweredBy({ answered_by: { ...ANSWERED_BY, reason: 'other' } })).toBeNull();
    expect(readAnsweredBy('not json')).toBeNull();
  });
});

describe('sessionIdOf', () => {
  it('reads the session the engine names on every provider request', () => {
    expect(sessionIdOf({ 'x-session-id': 'ses_1' })).toBe('ses_1');
    expect(sessionIdOf({ 'x-session-affinity': 'ses_2' })).toBe('ses_2');
    expect(sessionIdOf({})).toBeNull();
  });
});

describe('createAnsweredByWatcher', () => {
  it('reads the first valid chunk even when it is split across reads', () => {
    const seen = vi.fn();
    const watcher = createAnsweredByWatcher(seen);
    const frame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }], answered_by: ANSWERED_BY })}\n\n`;
    watcher.observe(encode(': keep-alive\n\n'));
    watcher.observe(encode(frame.slice(0, 30)));
    expect(seen).not.toHaveBeenCalled();
    watcher.observe(encode(frame.slice(30)));
    watcher.finish();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0][0]).toMatchObject({ answeredLabel: 'MittrCraft 1.0', reason: 'quota' });
  });

  it('looks only at the first valid chunk', () => {
    const seen = vi.fn();
    const watcher = createAnsweredByWatcher(seen);
    watcher.observe(encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
    watcher.observe(encode(`data: ${JSON.stringify({ choices: [], answered_by: ANSWERED_BY })}\n\n`));
    watcher.finish();
    expect(seen).not.toHaveBeenCalled();
  });

  it('reads a final chunk that never got its newline', () => {
    const seen = vi.fn();
    const watcher = createAnsweredByWatcher(seen);
    watcher.observe(encode(`data: ${JSON.stringify({ choices: [], answered_by: ANSWERED_BY })}`));
    watcher.finish();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('createAnsweredByLog', () => {
  it('keeps the last few answers per session and a bounded number of sessions', () => {
    const log = createAnsweredByLog({ perSession: 2, sessions: 2 });
    log.record('ses_a', { at: 1 });
    log.record('ses_a', { at: 2 });
    log.record('ses_a', { at: 3 });
    expect(log.list('ses_a')).toEqual([{ at: 2 }, { at: 3 }]);
    log.record('ses_b', { at: 4 });
    log.record('ses_a', { at: 5 });
    log.record('ses_c', { at: 6 });
    expect(log.list('ses_b')).toEqual([]);
    expect(log.list('ses_a')).toEqual([{ at: 3 }, { at: 5 }]);
    expect(log.list('ses_c')).toEqual([{ at: 6 }]);
  });
});

describe('GET /api/mittr/answered-by', () => {
  const createApp = (log) => {
    const app = express();
    registerMittrAnsweredByRoutes(app, { answeredByLog: log, now: () => 9000 });
    return app;
  };

  it('lists what the session was answered by, without the platform notice', async () => {
    const log = createAnsweredByLog();
    log.record('ses_1', {
      at: 1000, model: 'mittr-1', requestedLabel: 'MITTR 1.0', answeredLabel: 'MittrCraft 1.0', reason: 'quota', notice: 'x',
    });
    const response = await request(createApp(log)).get('/api/mittr/answered-by').query({ sessionId: 'ses_1' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      now: 9000,
      answers: [{ at: 1000, model: 'mittr-1', requestedLabel: 'MITTR 1.0', answeredLabel: 'MittrCraft 1.0', reason: 'quota' }],
    });
  });

  it('answers an empty list for a session nothing was substituted in', async () => {
    const response = await request(createApp(createAnsweredByLog())).get('/api/mittr/answered-by').query({ sessionId: 'ses_2' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ now: 9000, answers: [] });
  });

  it('refuses a request without a session', async () => {
    const response = await request(createApp(createAnsweredByLog())).get('/api/mittr/answered-by');
    expect(response.status).toBe(400);
  });
});
