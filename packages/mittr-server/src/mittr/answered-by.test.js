import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAnsweredByLog, createAnsweredByWatcher, readAnsweredBy, registerAnsweredByRoute } from './answered-by.js';
import { serve } from './test-helpers.js';

const SUBSTITUTED = { substituted: true, requestedLabel: 'Writer', answeredLabel: 'Backup', reason: 'quota', notice: 'x' };
const bytes = (text) => new TextEncoder().encode(text);
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const FIRST = { choices: [{ delta: { content: 'hi' } }], answered_by: SUBSTITUTED };
const PLAIN = { choices: [{ delta: { content: 'hi' } }] };

const watched = () => {
  const log = createAnsweredByLog({ perSession: 10, sessions: 100 });
  return { log, onAnswer: createAnsweredByWatcher(log.record) };
};

const request = (over = {}) => ({ sessionId: 'ses_1', model: 'writer', startedAt: 1000, ...over });

test('readAnsweredBy reads a substitution from an object or its JSON text', () => {
  const expected = { requestedLabel: 'Writer', answeredLabel: 'Backup', reason: 'quota' };
  assert.deepEqual(readAnsweredBy({ choices: [], answered_by: SUBSTITUTED }), expected);
  assert.deepEqual(readAnsweredBy(JSON.stringify({ choices: [], answered_by: SUBSTITUTED })), expected);
});

test('readAnsweredBy ignores answers that were not substituted or cannot be named', () => {
  assert.equal(readAnsweredBy({ choices: [] }), null);
  assert.equal(readAnsweredBy({ answered_by: { ...SUBSTITUTED, substituted: false } }), null);
  assert.equal(readAnsweredBy({ answered_by: { ...SUBSTITUTED, answeredLabel: ' ' } }), null);
  assert.equal(readAnsweredBy({ answered_by: { ...SUBSTITUTED, reason: 'other' } }), null);
  assert.equal(readAnsweredBy('not json'), null);
  assert.equal(readAnsweredBy(null), null);
});

test("the engine's session header keys the record", () => {
  const { log, onAnswer } = watched();
  onAnswer({ ...request(), chunk: bytes(frame(FIRST)), done: false });
  onAnswer({ ...request(), chunk: new Uint8Array(0), done: true });
  assert.equal(log.list('ses_1')[0].answeredLabel, 'Backup');
  assert.deepEqual(log.list('ses_1'), [{ at: 1000, model: 'writer', requestedLabel: 'Writer', answeredLabel: 'Backup', reason: 'quota' }]);
  assert.deepEqual(log.list('ses_2'), []);
});

test('no substitution, no record', () => {
  const { log, onAnswer } = watched();
  onAnswer({ ...request(), chunk: bytes(frame(PLAIN)), done: false });
  onAnswer({ ...request(), chunk: bytes(frame({ choices: [], answered_by: { ...SUBSTITUTED, substituted: false } })), done: false });
  onAnswer({ ...request(), chunk: new Uint8Array(0), done: true });
  assert.deepEqual(log.list('ses_1'), []);
});

test('a first chunk split across reads is read once', () => {
  const { log, onAnswer } = watched();
  const text = frame(FIRST);
  onAnswer({ ...request(), chunk: bytes(': keep-alive\n\n'), done: false });
  onAnswer({ ...request(), chunk: bytes(text.slice(0, 30)), done: false });
  assert.deepEqual(log.list('ses_1'), []);
  onAnswer({ ...request(), chunk: bytes(text.slice(30)), done: false });
  onAnswer({ ...request(), chunk: bytes(frame(FIRST)), done: false });
  onAnswer({ ...request(), chunk: new Uint8Array(0), done: true });
  assert.equal(log.list('ses_1').length, 1);
});

test('only the first valid chunk counts', () => {
  const { log, onAnswer } = watched();
  onAnswer({ ...request(), chunk: bytes(frame(PLAIN)), done: false });
  onAnswer({ ...request(), chunk: bytes(frame(FIRST)), done: false });
  onAnswer({ ...request(), chunk: new Uint8Array(0), done: true });
  assert.deepEqual(log.list('ses_1'), []);
});

test('a final chunk that never got its newline is read when the answer ends', () => {
  const { log, onAnswer } = watched();
  onAnswer({ ...request(), chunk: bytes(`data: ${JSON.stringify(FIRST)}`), done: false });
  assert.deepEqual(log.list('ses_1'), []);
  onAnswer({ ...request(), chunk: new Uint8Array(0), done: true });
  assert.equal(log.list('ses_1').length, 1);
});

test('an answer that is not streamed is read whole', () => {
  const { log, onAnswer } = watched();
  onAnswer({ ...request(), chunk: bytes(JSON.stringify({ choices: [{ message: { content: 'hi' } }], answered_by: SUBSTITUTED })), done: false });
  onAnswer({ ...request(), chunk: new Uint8Array(0), done: true });
  assert.equal(log.list('ses_1')[0].reason, 'quota');
});

test('a cut-off or quota error frame is skipped, and a later substituted frame on the same request still records', () => {
  const cutOff = { error: { type: 'invalid_request_error', code: 'stream_cut_off', message: 'The answer was cut off.' } };
  const quota = { error: { type: 'insufficient_quota', code: 'llm_quota_exhausted' } };
  for (const [startedAt, errorFrame] of [[1000, frame(cutOff)], [2000, frame(quota)]]) {
    const { log, onAnswer } = watched();
    onAnswer({ ...request({ startedAt }), chunk: bytes(errorFrame), done: false });
    assert.deepEqual(log.list('ses_1'), []);
    onAnswer({ ...request({ startedAt }), chunk: bytes(frame(FIRST)), done: false });
    onAnswer({ ...request({ startedAt }), chunk: new Uint8Array(0), done: true });
    assert.equal(log.list('ses_1').length, 1);
  }
});

test('an error body that is not streamed records nothing and never throws', () => {
  const { log, onAnswer } = watched();
  assert.doesNotThrow(() => {
    onAnswer({ ...request(), chunk: bytes('{"error":'), done: false });
    onAnswer({ ...request(), chunk: new Uint8Array(0), done: true });
    onAnswer({ ...request({ startedAt: 4000 }), chunk: bytes('\xff\xfe'), done: false });
    onAnswer({ ...request({ startedAt: 4000 }), chunk: undefined, done: false });
    onAnswer(undefined);
  });
  assert.deepEqual(log.list('ses_1'), []);
});

test('a listener that throws costs only its own request', () => {
  const seen = [];
  const onAnswer = createAnsweredByWatcher((sessionId, answer) => {
    seen.push(answer.answeredLabel);
    if (answer.answeredLabel === 'Boom') throw new Error('boom');
  });
  const boom = frame({ ...FIRST, answered_by: { ...SUBSTITUTED, answeredLabel: 'Boom' } });
  const fine = frame(FIRST);
  onAnswer({ ...request({ requestId: 1 }), chunk: bytes(fine.slice(0, 25)), done: false });
  assert.doesNotThrow(() => onAnswer({ ...request({ requestId: 2 }), chunk: bytes(boom), done: false }));
  onAnswer({ ...request({ requestId: 1 }), chunk: bytes(fine.slice(25)), done: false });
  assert.deepEqual(seen, ['Boom', 'Backup']);
});

test('requests with no session or model are not recorded', () => {
  const { log, onAnswer } = watched();
  onAnswer({ ...request({ sessionId: null }), chunk: bytes(frame(FIRST)), done: false });
  onAnswer({ ...request({ model: null }), chunk: bytes(frame(FIRST)), done: false });
  assert.deepEqual(log.list('ses_1'), []);
});

test('two answers streaming in one session are kept apart', () => {
  const { log, onAnswer } = watched();
  const other = { ...FIRST, answered_by: { ...SUBSTITUTED, answeredLabel: 'Second' } };
  const text = frame(FIRST);
  onAnswer({ ...request(), chunk: bytes(text.slice(0, 20)), done: false });
  onAnswer({ ...request({ startedAt: 1001, model: 'other' }), chunk: bytes(frame(other)), done: false });
  onAnswer({ ...request(), chunk: bytes(text.slice(20)), done: false });
  assert.deepEqual(log.list('ses_1').map((answer) => [answer.model, answer.answeredLabel]), [['other', 'Second'], ['writer', 'Backup']]);
});

test('two requests of one session and model that start in the same millisecond are kept apart by their request id', () => {
  const { log, onAnswer } = watched();
  const second = frame({ ...FIRST, answered_by: { ...SUBSTITUTED, answeredLabel: 'Second' } });
  const first = frame(FIRST);
  onAnswer({ ...request({ requestId: 1 }), chunk: bytes(first.slice(0, 20)), done: false });
  onAnswer({ ...request({ requestId: 2 }), chunk: bytes(second.slice(0, 20)), done: false });
  onAnswer({ ...request({ requestId: 1 }), chunk: bytes(first.slice(20)), done: false });
  onAnswer({ ...request({ requestId: 2 }), chunk: bytes(second.slice(20)), done: false });
  onAnswer({ ...request({ requestId: 1 }), chunk: new Uint8Array(0), done: true });
  onAnswer({ ...request({ requestId: 2 }), chunk: new Uint8Array(0), done: true });
  assert.deepEqual(log.list('ses_1').map((answer) => answer.answeredLabel).sort(), ['Backup', 'Second']);
});

test('the log keeps the last few answers per session and a bounded number of sessions', () => {
  const log = createAnsweredByLog({ perSession: 2, sessions: 2 });
  log.record('a', { at: 1 });
  log.record('a', { at: 2 });
  log.record('a', { at: 3 });
  assert.deepEqual(log.list('a'), [{ at: 2 }, { at: 3 }]);
  log.record('b', { at: 4 });
  log.record('a', { at: 5 });
  log.record('c', { at: 6 });
  assert.deepEqual(log.list('b'), []);
  assert.deepEqual(log.list('a'), [{ at: 3 }, { at: 5 }]);
  assert.deepEqual(log.list('c'), [{ at: 6 }]);
  log.clear();
  assert.deepEqual(log.list('a'), []);
});

const serveRoute = async (t, log) => {
  const app = express();
  registerAnsweredByRoute(app, { log, now: () => 9000 });
  return serve(t, app);
};

test('GET /api/mittr/answered-by lists what the session was answered by, without the platform notice', async (t) => {
  const log = createAnsweredByLog();
  log.record('ses_1', { at: 1000, model: 'writer', requestedLabel: 'Writer', answeredLabel: 'Backup', reason: 'quota', notice: 'x', answeredKey: 'k' });
  const call = await serveRoute(t, log);
  assert.deepEqual(await call('GET', '/api/mittr/answered-by?sessionId=ses_1'), {
    status: 200,
    body: { now: 9000, answers: [{ at: 1000, model: 'writer', requestedLabel: 'Writer', answeredLabel: 'Backup', reason: 'quota' }] },
  });
  assert.deepEqual(await call('GET', '/api/mittr/answered-by?sessionId=ses_2'), { status: 200, body: { now: 9000, answers: [] } });
});

test('GET /api/mittr/answered-by without a session id is refused', async (t) => {
  const call = await serveRoute(t, createAnsweredByLog());
  const expected = { status: 400, body: { error: 'sessionId is required', reasonCode: 'invalid_request' } };
  assert.deepEqual(await call('GET', '/api/mittr/answered-by'), expected);
  assert.deepEqual(await call('GET', '/api/mittr/answered-by?sessionId=%20'), expected);
});
