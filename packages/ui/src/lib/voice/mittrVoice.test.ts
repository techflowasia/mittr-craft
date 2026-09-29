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
} from './mittrVoice';

describe('initial providers', () => {
  test('empty storage starts on Mittr for both', () => {
    expect(resolveInitialVoiceProvider(null)).toBe('mittr');
    expect(resolveInitialSttProvider(null)).toBe('mittr');
  });

  test('a saved read-aloud choice survives', () => {
    for (const saved of ['browser', 'local', 'openai', 'openai-compatible', 'say', 'mittr'] as const) {
      expect(resolveInitialVoiceProvider(saved)).toBe(saved);
    }
  });

  test('an unrecognised saved read-aloud value keeps the old browser fallback', () => {
    expect(resolveInitialVoiceProvider('nonsense')).toBe('browser');
  });

  test('a saved dictation choice survives, legacy values included', () => {
    expect(resolveInitialSttProvider('local')).toBe('local');
    expect(resolveInitialSttProvider('openai-compatible')).toBe('openai-compatible');
    expect(resolveInitialSttProvider('mittr')).toBe('mittr');
    expect(resolveInitialSttProvider('server')).toBe('openai-compatible');
    expect(resolveInitialSttProvider('browser')).toBe('local');
    expect(resolveInitialSttProvider('wasm')).toBe('local');
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
