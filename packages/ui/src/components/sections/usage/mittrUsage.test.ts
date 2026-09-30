import { describe, expect, test } from 'bun:test';

import { isMittrUsageOffered, resolveUsageSelection } from './mittrUsage';

const results = [
  { providerId: 'claude' as const, configured: false },
  { providerId: 'codex' as const, configured: true },
];

describe('Usage page selection', () => {
  test('opens on Mittr when Mittr can answer', () => {
    expect(resolveUsageSelection(null, true, results)).toBe('mittr');
    expect(resolveUsageSelection(null, true, [])).toBe('mittr');
  });

  test('keeps what the person picked', () => {
    expect(resolveUsageSelection('claude', true, results)).toBe('claude');
    expect(resolveUsageSelection('mittr', true, results)).toBe('mittr');
  });

  test('falls back to the first configured provider when this install has no Mittr quota', () => {
    expect(resolveUsageSelection('mittr', false, results)).toBe('codex');
    expect(resolveUsageSelection(null, false, results)).toBe('codex');
    expect(resolveUsageSelection(null, false, [])).toBeNull();
  });

  test('offers Mittr everywhere but VS Code and a platform without quotas', () => {
    expect(isMittrUsageOffered({ status: 'loading' }, false)).toBe(true);
    expect(isMittrUsageOffered({ status: 'not_signed_in' }, false)).toBe(true);
    expect(isMittrUsageOffered({ status: 'not_available' }, false)).toBe(false);
    expect(isMittrUsageOffered({ status: 'loading' }, true)).toBe(false);
  });
});
