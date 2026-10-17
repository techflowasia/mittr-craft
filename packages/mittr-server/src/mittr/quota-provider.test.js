import assert from 'node:assert/strict';
import test from 'node:test';

import { mittrQuotaProvider } from './quota-provider.js';
import { quotaResult } from './test-helpers.js';

const RESETS_AT = '2026-10-20T00:00:00+07:00';
const quota = (lines, extra = {}) => ({ weekStart: '2026-10-13T00:00:00+07:00', resetsAt: RESETS_AT, lines, ...extra });
const providerFor = (week, overrides = {}) => mittrQuotaProvider({
  service: { readMine: async () => week },
  isSignedIn: () => true,
  isBrokerConfigured: () => true,
  ...quotaResult,
  ...overrides,
});

test('the provider is Mittr', () => {
  const provider = providerFor(quota([]));
  assert.equal(provider.providerId, 'mittr');
  assert.equal(provider.providerName, 'Mittr');
});

test('the provider shows remaining per agent with the reset time', async () => {
  const result = await providerFor(quota([{ label: 'Writer', used: 30, limit: 50, kind: 'chat' }])).fetchQuota();
  assert.equal(result.providerId, 'mittr');
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  const weekly = result.usage.models.Writer.windows.weekly;
  assert.equal(weekly.usedPercent, 60);
  assert.equal(weekly.remainingPercent, 40);
  assert.equal(weekly.valueLabel, '20 of 50 left');
  assert.equal(weekly.resetAt, Date.parse('2026-10-20T00:00:00+07:00'));
  assert.equal(weekly.windowSeconds, 7 * 24 * 3600);
});

test('the provider shows the most used line as the overall weekly share', async () => {
  const result = await providerFor(quota([
    { label: 'Writer', used: 30, limit: 50, kind: 'chat' },
    { label: 'Reader', used: 5, limit: 100, kind: 'chat' },
  ])).fetchQuota();
  const overall = result.usage.windows.weekly;
  assert.equal(overall.usedPercent, 60);
  assert.equal(overall.remainingPercent, 40);
  assert.equal(overall.resetAt, Date.parse(RESETS_AT));
});

test('a line over its limit reads as fully used', async () => {
  const result = await providerFor(quota([{ label: 'Writer', used: 80, limit: 50, kind: 'chat' }])).fetchQuota();
  const weekly = result.usage.models.Writer.windows.weekly;
  assert.equal(weekly.usedPercent, 100);
  assert.equal(weekly.remainingPercent, 0);
  assert.equal(weekly.valueLabel, '0 of 50 left');
});

test('a speech line is shown in minutes', async () => {
  const result = await providerFor(quota([{ label: 'Voice input', used: 30, limit: 600, kind: 'stt' }])).fetchQuota();
  const weekly = result.usage.models['Voice input'].windows.weekly;
  assert.equal(weekly.valueLabel, '9.5 min of 10 min left');
  assert.equal(weekly.remainingPercent, 95);
});

test('a speech allowance of an hour or more is shown in hours', async () => {
  const cases = [
    [{ used: 600, limit: 36_000 }, '9 h 50 min of 10 h left'],
    [{ used: 0, limit: 3600 }, '1 h of 1 h left'],
    [{ used: 3600, limit: 7200 }, '1 h of 2 h left'],
    [{ used: 30, limit: 3630 }, '1 h of 1 h 1 min left'],
    [{ used: 3000, limit: 3600 }, '10 min of 1 h left'],
    [{ used: 3585, limit: 3600 }, '0.3 min of 1 h left'],
    [{ used: 36_000, limit: 90_000 }, '15 h of 25 h left'],
    [{ used: 1000, limit: 7200 }, '1 h 43 min of 2 h left'],
    [{ used: 7200, limit: 7200 }, '0 min of 2 h left'],
  ];
  for (const [amounts, expected] of cases) {
    const result = await providerFor(quota([{ label: 'Voice input', kind: 'stt', ...amounts }])).fetchQuota();
    assert.equal(result.usage.models['Voice input'].windows.weekly.valueLabel, expected, JSON.stringify(amounts));
  }
});

test('the role name outranks the label, as in 1.22', async () => {
  const result = await providerFor(quota([{ label: 'Stale label', labelKey: 'quota.role.manager', used: 1, limit: 10, kind: 'chat' }])).fetchQuota();
  assert.deepEqual(Object.keys(result.usage.models), ['Team manager (assigns, summarises, reviews)']);
});

test('an unknown role key falls back to the label', async () => {
  const result = await providerFor(quota([{ label: 'Writer', labelKey: 'quota.role.unknown', used: 1, limit: 10, kind: 'chat' }])).fetchQuota();
  assert.deepEqual(Object.keys(result.usage.models), ['Writer']);
});

test('large amounts are grouped', async () => {
  const result = await providerFor(quota([{ label: 'Writer', used: 1200, limit: 500_000, kind: 'chat' }])).fetchQuota();
  assert.equal(result.usage.models.Writer.windows.weekly.valueLabel, '498,800 of 500,000 left');
});

test('lines with the same label stay apart', async () => {
  const result = await providerFor(quota([
    { label: 'Mittr', used: 1, limit: 10, kind: 'chat' },
    { label: 'Mittr', used: 2, limit: 10, kind: 'image' },
    { label: 'Mittr', used: 3, limit: 10, kind: 'chat' },
  ])).fetchQuota();
  assert.equal(Object.keys(result.usage.models).length, 3);
  assert.equal(Object.values(result.usage.models).map((model) => model.windows.weekly.usedPercent).sort().join(), '10,20,30');
});

test('a system line without a label is named by its role', async () => {
  const result = await providerFor(quota([{ label: '', labelKey: 'quota.role.decision', used: 1, limit: 10, kind: 'chat' }])).fetchQuota();
  assert.deepEqual(Object.keys(result.usage.models), ['System decision model (Jev)']);
});

test('an empty week is one bare line that reads no model available', async () => {
  const result = await providerFor(quota([])).fetchQuota();
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.planLabel, undefined);
  assert.deepEqual(result.usage.models, {});
  assert.deepEqual(Object.keys(result.usage.windows), ['No model available this week']);
  const line = result.usage.windows['No model available this week'];
  assert.equal(line.usedPercent, null);
  assert.equal(line.remainingPercent, null);
  assert.equal(line.resetAt, null);
  assert.equal(line.valueLabel, undefined);
});

test('not configured when signed out', async () => {
  const provider = providerFor(quota([]), { isSignedIn: () => false });
  assert.equal(provider.isConfigured({}), false);
});

test('not configured with no broker', async () => {
  const provider = providerFor(quota([]), { isBrokerConfigured: () => false });
  assert.equal(provider.isConfigured({}), false);
});

test('configured when signed in with a broker', () => {
  assert.equal(providerFor(quota([])).isConfigured({}), true);
});

test('a check that throws means not configured', () => {
  const provider = providerFor(quota([]), { isSignedIn: () => { throw new Error('index unreadable'); } });
  assert.equal(provider.isConfigured({}), false);
});

test('a failed read is a failed result in plain words', async () => {
  const cases = [
    ['not_signed_in', 'Sign in to Mittr to see this week’s quota'],
    ['unreachable', 'Cannot reach Mittr'],
    ['upstream_timeout', 'Cannot reach Mittr'],
    ['not_available', 'Mittr does not report a quota for this account'],
    ['upstream_failed', 'Could not read this week’s quota'],
    ['not_configured', 'Could not read this week’s quota'],
  ];
  for (const [reasonCode, error] of cases) {
    const provider = providerFor(null, { service: { readMine: async () => { throw Object.assign(new Error('detail'), { reasonCode }); } } });
    const result = await provider.fetchQuota();
    assert.equal(result.ok, false, reasonCode);
    assert.equal(result.configured, true, reasonCode);
    assert.equal(result.error, error, reasonCode);
    assert.equal(result.providerId, 'mittr');
  }
});

test('an unexpected failure does not leak its message', async () => {
  const provider = providerFor(null, { service: { readMine: async () => { throw new Error('token at-1 rejected'); } } });
  assert.equal((await provider.fetchQuota()).error, 'Could not read this week’s quota');
});
