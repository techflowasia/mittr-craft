import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestMetadata } from './request-metadata.js';

const capture = (body = {}) => {
  const lines = [];
  let time = 1000;
  const metadata = createRequestMetadata({ body, now: () => time, logger: { log: (line) => lines.push(line) } });
  return { metadata, lines, finish: () => { time = 1250; metadata.fail('length'); return JSON.parse(lines[0].slice('[mittr] request-failed '.length)); } };
};

test('failed requests record only selected budget and usage with a local correlation id', () => {
  const { metadata, lines, finish } = capture({ max_tokens: 32000, max_completion_tokens: 40000, messages: ['PRIVATE'], model: 'PRIVATE' });
  metadata.setStatus(200);
  metadata.observe({ choices: [{ finish_reason: 'length', delta: { content: 'PRIVATE' } }], usage: { prompt_tokens: 120, completion_tokens: 32000, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 30000 }, extra: 'PRIVATE' } });
  assert.equal(lines.length, 0);
  const record = finish();
  assert.match(record.requestId, /^[0-9a-f-]{36}$/);
  const { requestId, ...fields } = record;
  assert.deepEqual(fields, { startedAt: 1000, elapsedMs: 250, maxTokens: 32000, maxCompletionTokens: 40000, httpStatus: 200, finishReason: 'length', inputTokens: 120, outputTokens: 32000, reasoningTokens: 30000, cachedInputTokens: 20, usageAvailable: true, outcome: 'length' });
  metadata.fail('timeout');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('PRIVATE'), false);
});

test('malformed metadata and unknown strings never enter the record', () => {
  for (const invalid of ['PRIVATE', -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, {}, null]) {
    const { metadata, finish } = capture({ max_tokens: invalid });
    metadata.setStatus(invalid);
    metadata.observe({ choices: [{ finish_reason: 'PRIVATE' }], usage: { prompt_tokens: invalid, completion_tokens: invalid } });
    const record = finish();
    assert.equal(record.maxTokens, null);
    assert.equal(record.inputTokens, null);
    assert.equal(record.outputTokens, null);
    assert.equal(record.usageAvailable, false);
    assert.equal(record.finishReason, 'unknown');
    assert.equal(JSON.stringify(record).includes('PRIVATE'), false);
  }
});

test('partial usage retains zero and missing fields separately, and later empty frames do not erase it', () => {
  const { metadata, finish } = capture();
  metadata.observe({ usage: { completion_tokens: 0 } });
  metadata.observe({ usage: null });
  const record = finish();
  assert.equal(record.outputTokens, 0);
  assert.equal(record.inputTokens, null);
  assert.equal(record.usageAvailable, true);
});

test('throwing diagnostics logger cannot escape or retry emission', () => {
  let calls = 0;
  const metadata = createRequestMetadata({ body: {}, now: () => 1000, logger: { log() { calls += 1; throw new Error('PRIVATE'); } } });
  assert.doesNotThrow(() => metadata.fail('transport_error'));
  metadata.fail('timeout');
  assert.equal(calls, 1);
});
