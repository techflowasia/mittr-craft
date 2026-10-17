import assert from 'node:assert/strict';
import test from 'node:test';

import { QUOTA_REFUSAL_STATUS, createQuotaStreamRewriter, readQuotaExhausted, toEngineRefusal } from './exhausted.js';

const RESETS_AT = '2026-10-04T17:00:00.000Z';

const flat = {
  code: 'llm_quota_exhausted',
  modelKey: 'qwen-36',
  kind: 'stt',
  label: 'Voice input',
  resetsAt: RESETS_AT,
  message: 'quota used up',
};

const envelope = {
  error: {
    type: 'insufficient_quota',
    code: 'llm_quota_exhausted',
    message: 'quota used up',
    resets_at: RESETS_AT,
    model: 'MITTR 2.0',
  },
};

const ENGINE_RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
];
const engineWouldRetry = (value) => ENGINE_RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value));

const decode = (chunks) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
const encode = (text) => new TextEncoder().encode(text);

test('readQuotaExhausted reads the flat platform body', () => {
  assert.deepEqual(readQuotaExhausted(flat), { kind: 'stt', resetsAt: RESETS_AT });
});

test('readQuotaExhausted reads the chat completions envelope', () => {
  assert.deepEqual(readQuotaExhausted(envelope), { kind: 'chat', resetsAt: RESETS_AT });
});

test('readQuotaExhausted reads a JSON string of either shape', () => {
  assert.equal(readQuotaExhausted(JSON.stringify(flat))?.kind, 'stt');
  assert.equal(readQuotaExhausted(JSON.stringify(envelope))?.kind, 'chat');
});

test('readQuotaExhausted keeps an exhaustion whose reset time is missing or unreadable', () => {
  assert.equal(readQuotaExhausted({ code: 'llm_quota_exhausted', resetsAt: 'soon' })?.resetsAt, null);
  assert.equal(readQuotaExhausted({ error: { code: 'llm_quota_exhausted' } })?.resetsAt, null);
});

test('readQuotaExhausted reads the frame the stream rewriter produces', () => {
  const inner = JSON.stringify({ type: 'error', error: { type: 'insufficient_quota', code: 'insufficient_quota', reason: 'llm_quota_exhausted', kind: 'chat', resets_at: RESETS_AT } });
  assert.deepEqual(readQuotaExhausted(inner), { kind: 'chat', resetsAt: RESETS_AT });
});

test('readQuotaExhausted ignores an ordinary rate limit and other refusals', () => {
  assert.equal(readQuotaExhausted({ error: { type: 'rate_limit_exceeded', code: 'rate_limit', message: 'slow down' } }), null);
  assert.equal(readQuotaExhausted({ error: 'agent_not_granted' }), null);
  assert.equal(readQuotaExhausted({ code: 'upstream_failed' }), null);
  assert.equal(readQuotaExhausted('not json'), null);
  assert.equal(readQuotaExhausted(null), null);
});

test('readQuotaExhausted does not claim a provider insufficient_quota that carries no reset time', () => {
  assert.equal(readQuotaExhausted({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'billing' } }), null);
});

test('toEngineRefusal answers with a status and header the engine does not retry', () => {
  const refusal = toEngineRefusal({ kind: 'chat', resetsAt: RESETS_AT });
  assert.equal(QUOTA_REFUSAL_STATUS, 402);
  assert.equal(refusal.status, 402);
  assert.deepEqual(refusal.headers, { 'x-should-retry': 'false' });
});

test('toEngineRefusal keeps the ISO reset time', () => {
  const refusal = toEngineRefusal({ kind: 'weekly', resetsAt: '2026-10-20T00:00:00+07:00' });
  assert.deepEqual(refusal.body, {
    error: {
      type: 'insufficient_quota',
      code: 'llm_quota_exhausted',
      message: 'Weekly model quota used up',
      kind: 'weekly',
      resets_at: '2026-10-19T17:00:00.000Z',
    },
  });
});

test('toEngineRefusal sends no reset time when there is none', () => {
  assert.equal(toEngineRefusal({ kind: 'chat', resetsAt: null }).body.error.resets_at, null);
});

test('toEngineRefusal gives the engine nothing its retry patterns match, whatever the label, message or reset time', () => {
  for (const label of ['GPT-5 (500K)', 'Model 429', 'Overloaded 503 timeout']) {
    const upstream = {
      error: {
        type: 'insufficient_quota',
        code: 'llm_quota_exhausted',
        message: `quota ${label} used up 500 tokens rate limit`,
        resets_at: '2026-10-04T17:00:00.524Z',
        model: label,
      },
    };
    const { body } = toEngineRefusal(readQuotaExhausted(upstream));
    assert.equal(engineWouldRetry(body.error.message), false);
    assert.equal(engineWouldRetry(JSON.stringify(body)), false);
    assert.equal(body.error.resets_at, '2026-10-04T17:00:00.000Z');
  }
});

test('the stream rewriter passes ordinary frames through byte for byte', () => {
  const rewriter = createQuotaStreamRewriter();
  const input = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: [DONE]\n\n';
  assert.equal(decode([rewriter.push(encode(input)), rewriter.end()]), input);
});

test('the stream rewriter holds only an unfinished line until the rest arrives', () => {
  const rewriter = createQuotaStreamRewriter();
  assert.equal(decode([rewriter.push(encode('data: {"a":'))]), '');
  assert.equal(decode([rewriter.push(encode('1}\n\n'))]), 'data: {"a":1}\n\n');
});

test('the stream rewriter turns a quota frame into an error the engine stops on', () => {
  const rewriter = createQuotaStreamRewriter();
  const frame = `data: ${JSON.stringify(envelope)}\n\ndata: [DONE]\n\n`;
  const text = decode([rewriter.push(encode(frame.slice(0, 30))), rewriter.push(encode(frame.slice(30))), rewriter.end()]);
  const payload = JSON.parse(text.split('\n\n')[0].slice('data: '.length));
  assert.equal(payload.error.code, 'llm_quota_exhausted');
  assert.deepEqual(JSON.parse(payload.error.message), {
    type: 'error',
    error: {
      type: 'insufficient_quota',
      code: 'insufficient_quota',
      reason: 'llm_quota_exhausted',
      kind: 'chat',
      resets_at: RESETS_AT,
    },
  });
  assert.equal(engineWouldRetry(payload.error.message), false);
  assert.ok(text.includes('data: [DONE]\n\n'));
});

test('the stream rewriter keeps a streamed label with retry-looking digits away from the engine', () => {
  const rewriter = createQuotaStreamRewriter();
  const loud = { error: { ...envelope.error, model: 'GPT-5 (500K)', message: 'Model 429 quota' } };
  const text = decode([rewriter.push(encode(`data: ${JSON.stringify(loud)}\n\n`)), rewriter.end()]);
  assert.equal(engineWouldRetry(JSON.parse(text.split('\n')[0].slice('data: '.length)).error.message), false);
});

test('the stream rewriter handles the flat body when the platform streams it', () => {
  const rewriter = createQuotaStreamRewriter();
  const text = decode([rewriter.push(encode(`event: error\ndata: ${JSON.stringify(flat)}\n\n`)), rewriter.end()]);
  assert.ok(text.startsWith('event: error\n'));
  const line = text.split('\n')[1];
  assert.equal(JSON.parse(JSON.parse(line.slice('data: '.length)).error.message).error.resets_at, RESETS_AT);
});

test('the stream rewriter flushes a last line that never got its newline', () => {
  const rewriter = createQuotaStreamRewriter();
  assert.equal(decode([rewriter.push(encode('data: [DONE]')), rewriter.end()]), 'data: [DONE]');
});
