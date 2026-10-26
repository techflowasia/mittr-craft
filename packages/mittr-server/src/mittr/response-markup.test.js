import assert from 'node:assert/strict';
import test from 'node:test';

import { createMarkupWatcher, createStreamMarkupWatcher, describeMarkup } from './response-markup.js';

test('ordinary prose is clean', () => {
  assert.deepEqual(describeMarkup({ content: 'The version is 4.2.1.', hasToolCalls: false }), { kind: 'clean', markers: [] });
});

test('channel markup is named as cosmetic when the loop still worked', () => {
  const result = describeMarkup({ content: '<|channel>thought\n<channel|>เวอร์ชันคือ 4.2.1 ครับ', hasToolCalls: false });
  assert.equal(result.kind, 'channel-markup');
  assert.ok(result.markers.includes('<|channel>'));
});

// The gateway's tool parser does not match the model, so the call comes back
// as text and tool_calls is empty. Nothing errors; the agent just stops.
test('a tool call left in the text with no tool_calls is a lost tool call', () => {
  for (const content of ['<|tool_call>call:read_file{"path":"src/index.js"}', '<tool_call>{}', '<function=read_file><parameter=path>src/index.js</parameter></function>', '<function=bash>']) {
    assert.equal(describeMarkup({ content, hasToolCalls: false }).kind, 'tool-calls-lost', content);
  }
});

test('a tool call that did come through is not a failure', () => {
  assert.equal(describeMarkup({ content: '<|tool_call>call:read_file{}', hasToolCalls: true }).kind, 'channel-markup');
});

test('missing or non-string content is clean', () => {
  assert.equal(describeMarkup({ content: null, hasToolCalls: false }).kind, 'clean');
  assert.equal(describeMarkup({}).kind, 'clean');
  assert.equal(describeMarkup().kind, 'clean');
});

test('the text watcher finds a marker split anywhere, and keeps only a marker of history', () => {
  const split = createMarkupWatcher();
  split.observe('<|tool_');
  split.observe('call>call:read_file{}');
  assert.equal(split.result().kind, 'tool-calls-lost');

  const perCharacter = createMarkupWatcher();
  for (const character of '<|tool_call>') perCharacter.observe(character);
  assert.equal(perCharacter.result().kind, 'tool-calls-lost');

  const long = createMarkupWatcher();
  for (let index = 0; index < 500; index += 1) long.observe('x'.repeat(1000));
  assert.ok(long.bufferedLength() < 32);
  assert.equal(long.result().kind, 'clean');
});

const event = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const run = (chunks) => {
  const watcher = createStreamMarkupWatcher();
  for (const chunk of chunks) watcher.observe(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  return watcher.finish();
};

test('an ordinary stream is clean', () => {
  assert.equal(run([event({ content: 'The version is ' }), event({ content: '4.2.1.' }), 'data: [DONE]\n\n']).kind, 'clean');
});

// Between two halves of a marker sits the protocol frame, so watching raw
// bytes never joins them up. Token-by-token streaming does this constantly.
test('a marker split across deltas is found in the decoded content', () => {
  assert.equal(run([event({ content: '<|tool_' }), event({ content: 'call>call:read_file{}' }), 'data: [DONE]\n\n']).kind, 'tool-calls-lost');
  assert.equal(run([...'<|tool_call>'].map((character) => event({ content: character }))).kind, 'tool-calls-lost');
});

test('an event split across network chunks, or a final one with no newline, is still read', () => {
  const whole = event({ content: '<|channel>thought' });
  const cut = Math.floor(whole.length / 2);
  assert.equal(run([whole.slice(0, cut), whole.slice(cut)]).kind, 'channel-markup');
  assert.equal(run([event({ content: '<|channel>x' }).trimEnd()]).kind, 'channel-markup');
});

test('a character split across network chunks is decoded whole', () => {
  const bytes = Buffer.from(event({ content: 'ครับ<|channel>' }), 'utf8');
  const cut = bytes.indexOf(Buffer.from('ครับ', 'utf8')) + 1;
  assert.equal(run([bytes.subarray(0, cut), bytes.subarray(cut)]).kind, 'channel-markup');
});

test('a real tool call on the stream clears the alarm', () => {
  assert.equal(run([event({ content: '<|tool_call>call:read_file{}' }), event({ tool_calls: [{ index: 0 }] })]).kind, 'channel-markup');
});

test('an unreadable frame or prose about tool_calls is not a finding', () => {
  assert.equal(run(['data: {not json\n\n', event({ content: 'fine' })]).kind, 'clean');
  assert.equal(run([event({ content: 'the delta has "tool_calls": in it' })]).kind, 'clean');
});
