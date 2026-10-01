import { beforeEach, describe, expect, test } from 'bun:test';

import { speechBlockedUntil, useSpeechQuotaStore } from './speech-quota-store';

const NOW = Date.parse('2026-09-30T08:00:00.000Z');
const RESETS_AT = '2026-10-04T17:00:00.000Z';

beforeEach(() => {
  useSpeechQuotaStore.setState({ owner: null, stt: null, tts: null });
});

const line = (kind: 'stt' | 'tts' | 'chat', used: number, limit: number) => ({ modelKey: kind, kind, label: kind, used, limit });

describe('speech quota blocks', () => {
  test('keeps voice input off until the reset time the platform gave', () => {
    useSpeechQuotaStore.getState().block('stt', RESETS_AT, NOW);
    expect(speechBlockedUntil('stt', NOW)).toBe(RESETS_AT);
    expect(speechBlockedUntil('stt', Date.parse(RESETS_AT))).toBeNull();
    expect(speechBlockedUntil('tts', NOW)).toBeNull();
  });

  test('falls back to the next Monday in Bangkok when no reset time came back', () => {
    expect(useSpeechQuotaStore.getState().block('tts', null, NOW)).toBe(RESETS_AT);
    expect(speechBlockedUntil('tts', NOW)).toBe(RESETS_AT);
  });

  test('does not block for a reset time already in the past', () => {
    useSpeechQuotaStore.getState().block('stt', '2026-09-01T00:00:00.000Z', NOW);
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
  });
});

describe('whose block it is', () => {
  test('a block belongs to the person signed in when it was set', () => {
    const store = useSpeechQuotaStore.getState();
    store.setOwner('u1');
    store.block('stt', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().setOwner('u1');
    expect(speechBlockedUntil('stt', NOW)).toBe(RESETS_AT);
  });

  test('signing out or another person signing in clears it', () => {
    useSpeechQuotaStore.getState().setOwner('u1');
    useSpeechQuotaStore.getState().block('stt', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().block('tts', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().setOwner(null);
    expect([speechBlockedUntil('stt', NOW), speechBlockedUntil('tts', NOW)]).toEqual([null, null]);

    useSpeechQuotaStore.getState().setOwner('u1');
    useSpeechQuotaStore.getState().block('stt', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().setOwner('u2');
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
  });
});

describe('when speech is usable again', () => {
  test('this week showing room left on voice input lifts the block', () => {
    useSpeechQuotaStore.getState().block('stt', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().block('tts', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().reconcile([line('stt', 10, 600), line('tts', 5000, 5000), line('chat', 0, 10)]);
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
    expect(speechBlockedUntil('tts', NOW)).toBe(RESETS_AT);
  });

  test('a week with no voice input line keeps the block', () => {
    useSpeechQuotaStore.getState().block('stt', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().reconcile([line('chat', 0, 10)]);
    expect(speechBlockedUntil('stt', NOW)).toBe(RESETS_AT);
  });

  test('clear lifts one kind only', () => {
    useSpeechQuotaStore.getState().block('stt', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().block('tts', RESETS_AT, NOW);
    useSpeechQuotaStore.getState().clear('stt');
    expect([speechBlockedUntil('stt', NOW), speechBlockedUntil('tts', NOW)]).toEqual([null, RESETS_AT]);
  });
});
