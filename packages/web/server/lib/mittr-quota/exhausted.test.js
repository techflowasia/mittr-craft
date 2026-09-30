import { describe, expect, it } from 'vitest';
import {
  QUOTA_REFUSAL_STATUS,
  createQuotaStreamRewriter,
  readQuotaExhausted,
  toEngineRefusal,
} from './exhausted.js';

const RESETS_AT = '2026-10-04T17:00:00.000Z';

const flat = {
  code: 'llm_quota_exhausted',
  modelKey: 'qwen-36',
  kind: 'stt',
  label: 'Voice input',
  resetsAt: RESETS_AT,
  message: 'โควตาหมด',
};

const envelope = {
  error: {
    type: 'insufficient_quota',
    code: 'llm_quota_exhausted',
    message: 'โควตาหมด',
    resets_at: RESETS_AT,
    model: 'MITTR 2.0',
  },
};

describe('readQuotaExhausted', () => {
  it('reads the flat platform body', () => {
    expect(readQuotaExhausted(flat)).toEqual({
      kind: 'stt',
      resetsAt: RESETS_AT,
      message: 'โควตาหมด',
      model: 'Voice input',
    });
  });

  it('reads the chat completions envelope', () => {
    expect(readQuotaExhausted(envelope)).toEqual({
      kind: 'chat',
      resetsAt: RESETS_AT,
      message: 'โควตาหมด',
      model: 'MITTR 2.0',
    });
  });

  it('reads a JSON string of either shape', () => {
    expect(readQuotaExhausted(JSON.stringify(flat))?.kind).toBe('stt');
    expect(readQuotaExhausted(JSON.stringify(envelope))?.kind).toBe('chat');
  });

  it('keeps an exhaustion whose reset time is missing or unreadable', () => {
    expect(readQuotaExhausted({ code: 'llm_quota_exhausted', resetsAt: 'soon' })?.resetsAt).toBeNull();
  });

  it('ignores an ordinary rate limit and other refusals', () => {
    expect(readQuotaExhausted({ error: { type: 'rate_limit_exceeded', code: 'rate_limit', message: 'slow down' } })).toBeNull();
    expect(readQuotaExhausted({ error: 'agent_not_granted' })).toBeNull();
    expect(readQuotaExhausted({ code: 'upstream_failed' })).toBeNull();
    expect(readQuotaExhausted('not json')).toBeNull();
    expect(readQuotaExhausted(null)).toBeNull();
  });

  it('does not claim a provider insufficient_quota that carries no reset time', () => {
    expect(readQuotaExhausted({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'billing' } })).toBeNull();
  });
});

describe('toEngineRefusal', () => {
  it('answers with a status the engine does not retry', () => {
    expect(QUOTA_REFUSAL_STATUS).toBe(402);
  });

  it('keeps the envelope the engine and the app both parse', () => {
    expect(toEngineRefusal(readQuotaExhausted(flat))).toEqual({
      error: {
        type: 'insufficient_quota',
        code: 'llm_quota_exhausted',
        message: 'โควตาหมด',
        resets_at: RESETS_AT,
        model: 'Voice input',
      },
    });
  });
});

const decode = (chunks) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join('');
const encode = (text) => new TextEncoder().encode(text);

describe('createQuotaStreamRewriter', () => {
  it('passes ordinary frames through byte for byte', () => {
    const rewriter = createQuotaStreamRewriter();
    const input = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: [DONE]\n\n';
    const out = [rewriter.push(encode(input)), rewriter.end()];
    expect(decode(out)).toBe(input);
  });

  it('holds only an unfinished line until the rest arrives', () => {
    const rewriter = createQuotaStreamRewriter();
    expect(decode([rewriter.push(encode('data: {"a":'))])).toBe('');
    expect(decode([rewriter.push(encode('1}\n\n'))])).toBe('data: {"a":1}\n\n');
  });

  it('rewrites a quota frame into an error the engine stops on', () => {
    const rewriter = createQuotaStreamRewriter();
    const frame = `data: ${JSON.stringify(envelope)}\n\ndata: [DONE]\n\n`;
    const text = decode([rewriter.push(encode(frame.slice(0, 30))), rewriter.push(encode(frame.slice(30))), rewriter.end()]);
    const [first] = text.split('\n\n');
    const payload = JSON.parse(first.slice('data: '.length));
    expect(payload.error.code).toBe('llm_quota_exhausted');
    const inner = JSON.parse(payload.error.message);
    expect(inner).toEqual({
      type: 'error',
      error: {
        type: 'insufficient_quota',
        code: 'insufficient_quota',
        reason: 'llm_quota_exhausted',
        message: 'โควตาหมด',
        resets_at: RESETS_AT,
        model: 'MITTR 2.0',
      },
    });
    expect(text).toContain('data: [DONE]\n\n');
  });

  it('rewrites the flat body when the platform streams it', () => {
    const rewriter = createQuotaStreamRewriter();
    const text = decode([rewriter.push(encode(`event: error\ndata: ${JSON.stringify(flat)}\n\n`)), rewriter.end()]);
    expect(text.startsWith('event: error\n')).toBe(true);
    const line = text.split('\n')[1];
    expect(JSON.parse(JSON.parse(line.slice('data: '.length)).error.message).error.resets_at).toBe(RESETS_AT);
  });

  it('flushes a last line that never got its newline', () => {
    const rewriter = createQuotaStreamRewriter();
    expect(decode([rewriter.push(encode('data: [DONE]')), rewriter.end()])).toBe('data: [DONE]');
  });
});
