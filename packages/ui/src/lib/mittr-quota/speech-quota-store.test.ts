import { beforeEach, describe, expect, test } from 'bun:test';

import { speechBlockedUntil, useSpeechQuotaStore } from './speech-quota-store';

const NOW = Date.parse('2026-09-30T08:00:00.000Z');

beforeEach(() => {
  useSpeechQuotaStore.setState({ stt: null, tts: null });
});

describe('speech quota blocks', () => {
  test('keeps voice input off until the reset time the platform gave', () => {
    useSpeechQuotaStore.getState().block('stt', '2026-10-04T17:00:00.000Z', NOW);
    expect(speechBlockedUntil('stt', NOW)).toBe('2026-10-04T17:00:00.000Z');
    expect(speechBlockedUntil('stt', Date.parse('2026-10-04T17:00:00.000Z'))).toBeNull();
    expect(speechBlockedUntil('tts', NOW)).toBeNull();
  });

  test('falls back to the next Monday in Bangkok when no reset time came back', () => {
    expect(useSpeechQuotaStore.getState().block('tts', null, NOW)).toBe('2026-10-04T17:00:00.000Z');
    expect(speechBlockedUntil('tts', NOW)).toBe('2026-10-04T17:00:00.000Z');
  });

  test('does not block for a reset time already in the past', () => {
    useSpeechQuotaStore.getState().block('stt', '2026-09-01T00:00:00.000Z', NOW);
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
  });
});
