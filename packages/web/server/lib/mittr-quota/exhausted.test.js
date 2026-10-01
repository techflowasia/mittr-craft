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

// Copied from the engine, opencode v1.18.18 packages/opencode/src/session/retry.ts:33-40
// (RETRYABLE_MESSAGE_PATTERNS). retryable() retries a non-retryable APIError whose
// message or responseBody matches any of these.
const ENGINE_RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
];
const engineWouldRetry = (value) => ENGINE_RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value));

describe('readQuotaExhausted', () => {
  it('reads the flat platform body', () => {
    expect(readQuotaExhausted(flat)).toEqual({ kind: 'stt', resetsAt: RESETS_AT });
  });

  it('reads the chat completions envelope', () => {
    expect(readQuotaExhausted(envelope)).toEqual({ kind: 'chat', resetsAt: RESETS_AT });
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

  it('keeps only what the app reads', () => {
    expect(toEngineRefusal(readQuotaExhausted(envelope))).toEqual({
      error: {
        type: 'insufficient_quota',
        code: 'llm_quota_exhausted',
        message: 'Weekly model quota used up',
        kind: 'chat',
        resets_at: RESETS_AT,
      },
    });
  });

  it('gives the engine nothing its retry patterns match, whatever the label, message or reset time', () => {
    for (const label of ['GPT-5 (500K)', 'Model 429', 'Overloaded 503 timeout']) {
      const upstream = {
        error: {
          type: 'insufficient_quota',
          code: 'llm_quota_exhausted',
          message: `โควตา ${label} หมด 500 โทเคน rate limit`,
          resets_at: '2026-10-04T17:00:00.524Z',
          model: label,
        },
      };
      const refusal = toEngineRefusal(readQuotaExhausted(upstream));
      expect(engineWouldRetry(refusal.error.message)).toBe(false);
      expect(engineWouldRetry(JSON.stringify(refusal))).toBe(false);
      expect(refusal.error.resets_at).toBe('2026-10-04T17:00:00.000Z');
    }
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
        kind: 'chat',
        resets_at: RESETS_AT,
      },
    });
    expect(engineWouldRetry(payload.error.message)).toBe(false);
    expect(text).toContain('data: [DONE]\n\n');
  });

  it('keeps a streamed label with retry-looking digits away from the engine', () => {
    const rewriter = createQuotaStreamRewriter();
    const loud = { error: { ...envelope.error, model: 'GPT-5 (500K)', message: 'Model 429 quota' } };
    const text = decode([rewriter.push(encode(`data: ${JSON.stringify(loud)}\n\n`)), rewriter.end()]);
    const message = JSON.parse(text.split('\n')[0].slice('data: '.length)).error.message;
    expect(engineWouldRetry(message)).toBe(false);
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
