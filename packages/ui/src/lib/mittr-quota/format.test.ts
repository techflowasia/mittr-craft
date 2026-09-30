import { describe, expect, test } from 'bun:test';

import { formatMessage } from '@/lib/i18n';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';

import {
  agentQuotaBadge,
  formatQuotaAmount,
  groupQuotaLines,
  quotaAgentsText,
  quotaLeftText,
  quotaModelName,
  quotaUsedText,
} from './format';
import type { QuotaUsageLine } from './quota-me';

const t = (key: I18nKey, params?: I18nParams) => formatMessage(en, key, params);
const line = (over: Partial<QuotaUsageLine>): QuotaUsageLine => ({
  modelKey: 'm', kind: 'chat', label: 'MITTR 2.0', used: 0, limit: 100, ...over,
});

describe('quota amounts', () => {
  test('says what is left of the limit and what was used, with the unit', () => {
    const chat = line({ used: 12_500, limit: 50_000_000 });
    expect(quotaLeftText(chat, 'en-US', t)).toBe('49,987,500 left of 50,000,000 tokens');
    expect(quotaUsedText(chat, 'en-US', t)).toBe('Used 12,500 tokens');
    expect(quotaLeftText(line({ kind: 'image', used: 3, limit: 20 }), 'en-US', t)).toBe('17 left of 20 images');
    expect(quotaUsedText(line({ kind: 'tts', used: 5_000, limit: 1_000_000 }), 'en-US', t)).toBe('Used 5,000 chars');
  });

  test('shows voice input seconds as minutes and hours', () => {
    expect(formatQuotaAmount('stt', 90, 'en-US', t)).toBe('1.5 min');
    expect(formatQuotaAmount('stt', 1_500, 'en-US', t)).toBe('25 min');
    expect(formatQuotaAmount('stt', 36_000, 'en-US', t)).toBe('10 h');
    expect(formatQuotaAmount('stt', 5_400, 'en-US', t)).toBe('1 h 30 min');
    expect(quotaLeftText(line({ kind: 'stt', used: 600, limit: 36_000 }), 'en-US', t)).toBe('9 h 50 min left of 10 h');
    expect(quotaUsedText(line({ kind: 'stt', used: 600, limit: 36_000 }), 'en-US', t)).toBe('Used 10 min');
  });

  test('never goes below nothing left', () => {
    expect(quotaLeftText(line({ used: 150, limit: 100 }), 'en-US', t)).toBe('0 left of 100 tokens');
  });
});

describe('quota names', () => {
  test('names a system model from its role key instead of a bare kind', () => {
    expect(quotaModelName({ label: '', labelKey: 'quota.role.decision' }, t)).toBe('System decision model (Jev)');
    expect(quotaModelName({ label: '', labelKey: 'quota.role.rerank' }, t)).toBe('Search result ranking');
    expect(quotaModelName({ label: '', labelKey: 'quota.fallback.label' }, t)).toBe('Fallback for system models without their own limit');
    expect(quotaModelName({ label: '' }, t)).toBe('Other system model');
    expect(quotaModelName({ label: 'MITTR 2.0' }, t)).toBe('MITTR 2.0');
  });

  test('lists up to four agents and counts the rest', () => {
    expect(quotaAgentsText(['General Assistant'], t)).toBe('Used by: General Assistant');
    expect(quotaAgentsText(['A', 'B', 'C', 'D', 'E', 'F'], t)).toBe('Used by: A, B, C, D +2');
  });
});

describe('groupQuotaLines', () => {
  test('groups by kind in a fixed order with lines that have usage first', () => {
    const groups = groupQuotaLines([
      line({ modelKey: 'tts', kind: 'tts' }),
      line({ modelKey: 'idle' }),
      line({ modelKey: 'stt', kind: 'stt' }),
      line({ modelKey: 'busy', used: 50 }),
      line({ modelKey: 'full', used: 100 }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(['chat', 'stt', 'tts']);
    expect(groups[0].lines.map((entry) => entry.modelKey)).toEqual(['full', 'busy', 'idle']);
  });
});

describe('agentQuotaBadge', () => {
  const base = { modelKey: 'm', left: 5, limit: 100, resetsAt: '2026-10-04T17:00:00.000Z' };
  test('maps each state to what the picker shows', () => {
    expect(agentQuotaBadge({ ...base, state: 'ok' })).toBeNull();
    expect(agentQuotaBadge(undefined)).toBeNull();
    expect(agentQuotaBadge({ ...base, state: 'out' })).toEqual({ kind: 'out', resetsAt: base.resetsAt });
    expect(agentQuotaBadge({ ...base, state: 'substitute', substituteLabel: 'MITTR 1.0 fast' })).toEqual({ kind: 'substitute', label: 'MITTR 1.0 fast' });
    expect(agentQuotaBadge({ ...base, state: 'near', percentLeft: 12 })).toEqual({ kind: 'near', leftPercent: 12 });
    expect(agentQuotaBadge({ ...base, state: 'near' })).toEqual({ kind: 'near', leftPercent: 5 });
  });
});
