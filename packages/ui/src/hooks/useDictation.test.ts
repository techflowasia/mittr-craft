import { beforeEach, describe, expect, test } from 'bun:test';

import { speechBlockedUntil, useSpeechQuotaStore } from '@/lib/mittr-quota/speech-quota-store';
import { noteDictationFailure } from './useDictation';

const NOW = Date.parse('2026-09-30T08:00:00.000Z');
const RESETS_AT = '2026-10-04T17:00:00.000Z';

const failure = (fields: Record<string, unknown>) => Object.assign(new Error('Dictation failed'), fields);

beforeEach(() => {
  useSpeechQuotaStore.setState({ owner: null, stt: null, tts: null });
});

describe('noteDictationFailure', () => {
  test('a quota refusal keeps voice input off until the reset time it carried', () => {
    expect(noteDictationFailure(failure({ reasonCode: 'llm_quota_exhausted', resetsAt: RESETS_AT }))).toBe('llm_quota_exhausted');
    expect(speechBlockedUntil('stt', NOW)).toBe(RESETS_AT);
  });

  test('any other failure leaves voice input alone', () => {
    expect(noteDictationFailure(failure({ reasonCode: 'unreachable' }))).toBe('unreachable');
    expect(noteDictationFailure(new Error('boom'))).toBeNull();
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
  });
});
