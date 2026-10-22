import { beforeEach, describe, expect, test } from 'bun:test';

import { speechBlockedUntil, speechQuotaStore } from './speechQuotaStore';

const NOW = Date.parse('2026-09-30T08:00:00.000Z');
const RESETS_AT = '2026-10-04T17:00:00.000Z';

beforeEach(() => {
  speechQuotaStore.reset();
});

const line = (kind: 'stt' | 'tts' | 'chat', used: number, limit: number) => ({ modelKey: kind, kind, label: kind, used, limit });

describe('speech quota blocks', () => {
  test('keeps voice input off until the reset time the platform gave', () => {
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    expect(speechBlockedUntil('stt', NOW)).toBe(RESETS_AT);
    expect(speechBlockedUntil('stt', Date.parse(RESETS_AT))).toBeNull();
    expect(speechBlockedUntil('tts', NOW)).toBeNull();
  });

  test('falls back to the next Monday in Bangkok when no reset time came back', () => {
    expect(speechQuotaStore.block('tts', null, NOW)).toBe(RESETS_AT);
    expect(speechBlockedUntil('tts', NOW)).toBe(RESETS_AT);
  });

  test('does not block for a reset time already in the past', () => {
    speechQuotaStore.block('stt', '2026-09-01T00:00:00.000Z', NOW);
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
  });

  test('tells its listeners only when a block changes', () => {
    let heard = 0;
    const stop = speechQuotaStore.subscribe(() => {
      heard += 1;
    });
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.clear('stt');
    speechQuotaStore.clear('stt');
    stop();
    expect(heard).toBe(2);
  });
});

describe('whose block it is', () => {
  test('a block belongs to the person signed in when it was set', () => {
    speechQuotaStore.setOwner('u1');
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.setOwner('u1');
    expect(speechBlockedUntil('stt', NOW)).toBe(RESETS_AT);
  });

  test('signing out or another person signing in clears it', () => {
    speechQuotaStore.setOwner('u1');
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.block('tts', RESETS_AT, NOW);
    speechQuotaStore.setOwner(null);
    expect([speechBlockedUntil('stt', NOW), speechBlockedUntil('tts', NOW)]).toEqual([null, null]);

    speechQuotaStore.setOwner('u1');
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.setOwner('u2');
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
  });
});

describe('when speech is usable again', () => {
  test('this week showing room left on voice input lifts the block', () => {
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.block('tts', RESETS_AT, NOW);
    speechQuotaStore.reconcile([line('stt', 10, 600), line('tts', 5000, 5000), line('chat', 0, 10)]);
    expect(speechBlockedUntil('stt', NOW)).toBeNull();
    expect(speechBlockedUntil('tts', NOW)).toBe(RESETS_AT);
  });

  test('a week with no voice input line keeps the block', () => {
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.reconcile([line('chat', 0, 10)]);
    expect(speechBlockedUntil('stt', NOW)).toBe(RESETS_AT);
  });

  test('clear lifts one kind only', () => {
    speechQuotaStore.block('stt', RESETS_AT, NOW);
    speechQuotaStore.block('tts', RESETS_AT, NOW);
    speechQuotaStore.clear('stt');
    expect([speechBlockedUntil('stt', NOW), speechBlockedUntil('tts', NOW)]).toEqual([null, RESETS_AT]);
  });
});
