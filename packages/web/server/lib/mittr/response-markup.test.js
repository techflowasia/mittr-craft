import { describe, expect, it } from 'vitest';
import { createMarkupWatcher, createStreamMarkupWatcher, describeMarkup } from './response-markup.js';

describe('describeMarkup', () => {
  it('passes ordinary prose', () => {
    expect(describeMarkup({ content: 'The version is 4.2.1.', hasToolCalls: false }))
      .toEqual({ kind: 'clean', markers: [] });
  });

  it('names channel markup as cosmetic when the loop still worked', () => {
    const result = describeMarkup({
      content: '<|channel>thought\n<channel|>เวอร์ชันคือ 4.2.1 ครับ',
      hasToolCalls: false,
    });
    expect(result.kind).toBe('channel-markup');
    expect(result.markers).toContain('<|channel>');
  });

  // The failure our notes describe: the gateway's parser does not match the
  // model, so the model's tool call is emitted as text and tool_calls is empty.
  // Nothing errors; the agent simply stops calling tools.
  it('calls a tool call left in the text with no tool_calls what it is', () => {
    const result = describeMarkup({
      content: '<|tool_call>call:read_file{"path":"src/index.js"}',
      hasToolCalls: false,
    });
    expect(result.kind).toBe('tool-calls-lost');
    expect(result.markers).toContain('<|tool_call>');
  });

  it('recognises the XML tool format as the same failure', () => {
    expect(describeMarkup({
      content: '<function=read_file><parameter=path>src/index.js</parameter></function>',
      hasToolCalls: false,
    }).kind).toBe('tool-calls-lost');
  });

  it('does not cry failure when the tool call actually came through', () => {
    expect(describeMarkup({
      content: '<|tool_call>call:read_file{}',
      hasToolCalls: true,
    }).kind).toBe('channel-markup');
  });

  it('survives a missing or non-string content', () => {
    expect(describeMarkup({ content: null, hasToolCalls: false }).kind).toBe('clean');
    expect(describeMarkup({}).kind).toBe('clean');
  });
});

describe('createMarkupWatcher', () => {
  it('reports clean when nothing unusual passed through', () => {
    const watcher = createMarkupWatcher();
    watcher.observe('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    expect(watcher.result().kind).toBe('clean');
  });

  it('finds a marker that arrives whole', () => {
    const watcher = createMarkupWatcher();
    watcher.observe('data: {"choices":[{"delta":{"content":"<|channel>thought"}}]}\n\n');
    expect(watcher.result().kind).toBe('channel-markup');
  });

  // A stream is chopped wherever the network felt like chopping it, so a marker
  // split across two chunks is the normal case, not the exotic one.
  it('finds a marker split across chunks', () => {
    const watcher = createMarkupWatcher();
    watcher.observe('data: {"delta":{"content":"<|tool_');
    watcher.observe('call>call:read_file{}"}}\n\n');
    expect(watcher.result().kind).toBe('tool-calls-lost');
  });

  it('finds a marker split one character at a time', () => {
    const watcher = createMarkupWatcher();
    for (const character of '<|tool_call>') watcher.observe(character);
    expect(watcher.result().kind).toBe('tool-calls-lost');
  });

  it('clears the alarm once a real tool call is seen on the stream', () => {
    const watcher = createMarkupWatcher();
    watcher.observe('<|tool_call>call:read_file{}');
    watcher.noteToolCall();
    expect(watcher.result().kind).toBe('channel-markup');
  });

  it('holds no more than a marker of history, whatever the stream size', () => {
    const watcher = createMarkupWatcher();
    for (let index = 0; index < 500; index += 1) watcher.observe('x'.repeat(1000));
    expect(watcher.bufferedLength()).toBeLessThan(32);
  });
});

const event = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

describe('createStreamMarkupWatcher', () => {
  const run = (chunks) => {
    const watcher = createStreamMarkupWatcher();
    for (const chunk of chunks) watcher.observe(Buffer.from(chunk, 'utf8'));
    return watcher.finish();
  };

  it('reports clean for an ordinary stream', () => {
    expect(run([event({ content: 'The version is ' }), event({ content: '4.2.1.' }), 'data: [DONE]\n\n']).kind)
      .toBe('clean');
  });

  // The case a first version missed: between two halves of a marker sits the
  // protocol frame, so watching raw bytes never joins them up. Token-by-token
  // streaming produces this constantly.
  it('finds a marker split across two deltas', () => {
    expect(run([
      event({ content: '<|tool_' }),
      event({ content: 'call>call:read_file{}' }),
      'data: [DONE]\n\n',
    ]).kind).toBe('tool-calls-lost');
  });

  it('finds a marker split one delta per character', () => {
    const chunks = [...'<|tool_call>'].map((character) => event({ content: character }));
    expect(run(chunks).kind).toBe('tool-calls-lost');
  });

  it('handles an event split across two network chunks', () => {
    const whole = event({ content: '<|channel>thought' });
    const cut = Math.floor(whole.length / 2);
    expect(run([whole.slice(0, cut), whole.slice(cut)]).kind).toBe('channel-markup');
  });

  it('reads a final event that arrives without its trailing newline', () => {
    expect(run([event({ content: '<|channel>x' }).trimEnd()]).kind).toBe('channel-markup');
  });

  it('clears the alarm when a real tool call is on the stream', () => {
    expect(run([
      event({ content: '<|tool_call>call:read_file{}' }),
      event({ tool_calls: [{ index: 0 }] }),
    ]).kind).toBe('channel-markup');
  });

  it('ignores a frame it cannot parse rather than treating it as a finding', () => {
    expect(run(['data: {not json\n\n', event({ content: 'fine' })]).kind).toBe('clean');
  });

  it('is not fooled by a model writing the words in prose', () => {
    expect(run([event({ content: 'the delta has "tool_calls": in it' })]).kind).toBe('clean');
  });
});
