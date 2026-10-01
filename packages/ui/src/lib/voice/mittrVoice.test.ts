import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_VOICE_REPLY_MAX_CHARS,
  DEFAULT_VOICE_STEP_CAP,
  mittrReasonFor,
  clampVoiceReplyMaxChars,
  clampVoiceStepCap,
  normalizeSttProvider,
  parseMittrVoiceReadiness,
  resolveInitialSttProvider,
  resolveInitialVoiceProvider,
  resolveUnsavedSttProvider,
  speakWithMittr,
  splitForMittrSpeech,
} from './mittrVoice';

const desktop = { vscode: false };

describe('initial providers', () => {
  test('empty storage starts on Mittr for both', () => {
    expect(resolveInitialVoiceProvider(null, desktop)).toBe('mittr');
    expect(resolveInitialSttProvider(null, desktop)).toBe('mittr');
  });

  test('the VS Code webview never starts on Mittr', () => {
    expect(resolveInitialVoiceProvider(null, { vscode: true })).toBe('browser');
    expect(resolveInitialSttProvider(null, { vscode: true })).toBe('local');
  });

  test('an install that already set up local dictation counts as having chosen local', () => {
    expect(resolveInitialSttProvider(null, { vscode: false, localModelSaved: true })).toBe('local');
    expect(resolveUnsavedSttProvider({ vscode: false, localModelInstalled: true })).toBe('local');
    expect(resolveUnsavedSttProvider({ vscode: false, localModelSaved: false, localModelInstalled: false })).toBe('mittr');
  });

  test('a saved read-aloud choice survives', () => {
    for (const saved of ['browser', 'local', 'openai', 'openai-compatible', 'say', 'mittr'] as const) {
      expect(resolveInitialVoiceProvider(saved, desktop)).toBe(saved);
    }
  });

  test('an unrecognised saved read-aloud value keeps the old browser fallback', () => {
    expect(resolveInitialVoiceProvider('nonsense', desktop)).toBe('browser');
  });

  test('a saved dictation choice survives, legacy values included', () => {
    expect(resolveInitialSttProvider('local', desktop)).toBe('local');
    expect(resolveInitialSttProvider('openai-compatible', desktop)).toBe('openai-compatible');
    expect(resolveInitialSttProvider('mittr', desktop)).toBe('mittr');
    expect(resolveInitialSttProvider('server', desktop)).toBe('openai-compatible');
    expect(resolveInitialSttProvider('browser', desktop)).toBe('local');
    expect(resolveInitialSttProvider('wasm', desktop)).toBe('local');
  });

  test('normalizing a stored dictation provider accepts mittr and legacy values', () => {
    expect(normalizeSttProvider('mittr')).toBe('mittr');
    expect(normalizeSttProvider('server')).toBe('openai-compatible');
    expect(normalizeSttProvider('wasm')).toBe('local');
    expect(normalizeSttProvider(undefined)).toBe(undefined);
    expect(normalizeSttProvider('other')).toBe(undefined);
  });
});

describe('voice assistant limits', () => {
  test('defaults', () => {
    expect(DEFAULT_VOICE_STEP_CAP).toBe(8);
    expect(DEFAULT_VOICE_REPLY_MAX_CHARS).toBe(8000);
  });

  test('step cap clamps to 1..20 whole numbers', () => {
    expect(clampVoiceStepCap(0)).toBe(1);
    expect(clampVoiceStepCap(25)).toBe(20);
    expect(clampVoiceStepCap(7.6)).toBe(8);
    expect(clampVoiceStepCap(Number.NaN)).toBe(8);
  });

  test('reply length clamps to 1000..30000 whole numbers', () => {
    expect(clampVoiceReplyMaxChars(10)).toBe(1000);
    expect(clampVoiceReplyMaxChars(99999)).toBe(30000);
    expect(clampVoiceReplyMaxChars(4500.4)).toBe(4500);
    expect(clampVoiceReplyMaxChars(Number.POSITIVE_INFINITY)).toBe(8000);
  });
});

describe('parseMittrVoiceReadiness', () => {
  test('reads the wire shape', () => {
    expect(parseMittrVoiceReadiness({
      listen: true, speak: false, voice: false, signedIn: true, voiceSilenceMs: 900, reason: 'not_configured',
    })).toEqual({ listen: true, speak: false, voice: false, signedIn: true, reason: 'not_configured' });
  });

  test('drops an unknown reason', () => {
    expect(parseMittrVoiceReadiness({ listen: true, speak: true, voice: true, signedIn: true, reason: 'weird' })?.reason).toBeNull();
  });

  test('refuses a payload that is not an object', () => {
    expect(parseMittrVoiceReadiness(null)).toBeNull();
    expect(parseMittrVoiceReadiness('x')).toBeNull();
  });
});

describe('mittrReasonFor', () => {
  const readiness = { listen: true, speak: false, voice: false, signedIn: true, reason: 'not_configured' as const };

  test('names no reason while the part is ready or readiness is unknown', () => {
    expect(mittrReasonFor(readiness, 'listen')).toBeNull();
    expect(mittrReasonFor(null, 'speak')).toBeNull();
  });

  test('names the readiness reason for a part that is not ready', () => {
    expect(mittrReasonFor(readiness, 'speak')).toBe('not_configured');
    expect(mittrReasonFor({ ...readiness, listen: false, signedIn: false, reason: 'not_signed_in' }, 'listen')).toBe('not_signed_in');
    expect(mittrReasonFor({ ...readiness, reason: null }, 'speak')).toBe('not_configured');
  });
});

describe('splitForMittrSpeech', () => {
  test('groups sentences up to the chunk size and keeps their order', () => {
    const chunks = splitForMittrSpeech('One. Two! Three? Four.', 12);
    expect(chunks).toEqual(['One. Two!', 'Three? Four.']);
  });

  test('splits a long Thai clause at spaces and never leaves an empty chunk', () => {
    const thai = `${'สวัสดีครับ '.repeat(20)}จบ`;
    const chunks = splitForMittrSpeech(thai, 50);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 50)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(thai.replace(/\s+/g, ' ').trim());
  });

  test('cuts a single long word by code points, never inside a surrogate pair', () => {
    const chunks = splitForMittrSpeech('😀'.repeat(30), 7);
    expect(chunks.every((chunk) => Array.from(chunk).every((ch) => ch === '😀'))).toBe(true);
    expect(chunks.join('')).toBe('😀'.repeat(30));
  });
});

describe('speakWithMittr', () => {
  const ready = { listen: true, speak: true, voice: true, signedIn: true, reason: null };

  test('checks readiness first and names the reason instead of speaking', async () => {
    const spoken: string[] = [];
    const result = await speakWithMittr({
      text: 'Hello there.',
      readSpeakReadiness: async () => ({ ...ready, speak: false, signedIn: false, reason: 'not_signed_in' as const }),
      speakChunk: async (chunk) => { spoken.push(chunk); },
      isCancelled: () => false,
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'not_signed_in' });
    expect(spoken).toEqual([]);
  });

  test('says unreachable when readiness cannot be read', async () => {
    const result = await speakWithMittr({
      text: 'Hello.',
      readSpeakReadiness: async () => null,
      speakChunk: async () => {},
      isCancelled: () => false,
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'unreachable' });
  });

  test('speaks every chunk in order', async () => {
    const spoken: string[] = [];
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const result = await speakWithMittr({
      text,
      readSpeakReadiness: async () => ready,
      speakChunk: async (chunk) => { spoken.push(chunk); },
      isCancelled: () => false,
    });
    expect(result).toEqual({ status: 'spoken' });
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.join(' ')).toBe(text);
  });

  test('stop cancels the chunks not yet spoken', async () => {
    const spoken: string[] = [];
    let cancelled = false;
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const result = await speakWithMittr({
      text,
      readSpeakReadiness: async () => ready,
      speakChunk: async (chunk) => {
        spoken.push(chunk);
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(spoken).toHaveLength(1);
  });
});
