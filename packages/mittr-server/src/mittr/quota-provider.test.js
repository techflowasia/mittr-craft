import assert from 'node:assert/strict';
import test from 'node:test';

import { mittrQuotaProvider } from './quota-provider.js';
import { quotaResult } from './test-helpers.js';

const RESETS_AT = '2026-10-20T00:00:00+07:00';
const quota = (lines, extra = {}) => ({ weekStart: '2026-10-13T00:00:00+07:00', resetsAt: RESETS_AT, lines, ...extra });
const CATALOG = { configured: true, items: [{ alias: 'writer', label: 'Writer' }, { alias: 'reader', label: 'Reader' }] };
const providerFor = (week, overrides = {}) => mittrQuotaProvider({
  service: { readMine: async () => week },
  isSignedIn: () => true,
  isBrokerConfigured: () => true,
  catalogModels: () => CATALOG,
  ...quotaResult,
  ...overrides,
});

test('the provider is Mittr', () => {
  const provider = providerFor(quota([]));
  assert.equal(provider.providerId, 'mittr');
  assert.equal(provider.providerName, 'Mittr');
});

test('the provider shows remaining per agent with the reset time', async () => {
  const result = await providerFor(quota([{ modelKey: 'writer', label: 'Writer', used: 30, limit: 50, kind: 'chat' }])).fetchQuota();
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
    { modelKey: 'writer', label: 'Writer', used: 30, limit: 50, kind: 'chat' },
    { modelKey: 'reader', label: 'Reader', used: 5, limit: 100, kind: 'chat' },
  ])).fetchQuota();
  const overall = result.usage.windows.weekly;
  assert.equal(overall.usedPercent, 60);
  assert.equal(overall.remainingPercent, 40);
  assert.equal(overall.resetAt, Date.parse(RESETS_AT));
});

test('a line over its limit reads as fully used', async () => {
  const result = await providerFor(quota([{ modelKey: 'writer', label: 'Writer', used: 80, limit: 50, kind: 'chat' }])).fetchQuota();
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

test('large amounts are grouped', async () => {
  const result = await providerFor(quota([{ modelKey: 'writer', label: 'Writer', used: 1200, limit: 500_000, kind: 'chat' }])).fetchQuota();
  assert.equal(result.usage.models.Writer.windows.weekly.valueLabel, '498,800 of 500,000 left');
});

test('lines with the same name stay apart', async () => {
  const twins = { configured: true, items: [{ alias: 'm1', label: 'Mittr' }, { alias: 'm2', label: 'Mittr' }] };
  const result = await providerFor(quota([
    { modelKey: 'm1', label: 'Mittr', used: 1, limit: 10, kind: 'chat' },
    { modelKey: 'speech', label: 'Mittr', used: 2, limit: 10, kind: 'stt' },
    { modelKey: 'm2', label: 'Mittr', used: 3, limit: 10, kind: 'chat' },
  ]), { catalogModels: () => twins }).fetchQuota();
  assert.equal(Object.keys(result.usage.models).length, 3);
  assert.equal(Object.values(result.usage.models).map((model) => model.windows.weekly.usedPercent).sort().join(), '10,20,30');
});

const DEV_PLATFORM_WEEK = quota([
  { modelKey: 'mittr-fast', kind: 'chat', label: 'MITTR 1.0 fast', used: 971205, limit: 981205, source: 'user', agents: [{ key: 'mittr-1-0', label: 'MITTR 1.0' }] },
  { modelKey: 'mittr-pro', kind: 'chat', label: 'MITTR Pro', used: 26450, limit: 26450, source: 'user' },
  { modelKey: 'm:9b17db7ab3d1', kind: 'chat', label: '', labelKey: 'quota.role.decision', used: 50617, limit: 50000000, source: 'default' },
  { modelKey: 'm:41aa0be2c7d9', kind: 'chat', label: '', labelKey: 'quota.role.manager', used: 50000000, limit: 50000000, source: 'default' },
  { modelKey: 'studio-writer', kind: 'chat', label: 'Studio writer', used: 10, limit: 100, source: 'default' },
  { modelKey: 'm:0c1d2e3f4a5b', kind: 'image', label: '', labelKey: 'quota.role.image', used: 1, limit: 10, source: 'default' },
  { modelKey: 'qwen3-asr', kind: 'stt', label: 'ฟังเสียง', used: 0, limit: 36000, source: 'default' },
], {
  agentStatus: { 'mittr-1-0': { modelKey: 'mittr-fast', left: 10000, limit: 981205, resetsAt: RESETS_AT, state: 'near', percentLeft: 1 } },
});
const DEV_CATALOG = { configured: true, items: [{ alias: 'mittr-fast', label: 'MITTR Fast' }, { alias: 'mittr-pro', label: 'MITTR Pro' }] };

test('Usage lists the person\'s MittrCraft names by their catalog names, and speech, and no internal platform line', async () => {
  const result = await providerFor(DEV_PLATFORM_WEEK, { catalogModels: () => DEV_CATALOG }).fetchQuota();
  assert.deepEqual(Object.keys(result.usage.models), ['MITTR Fast', 'MITTR Pro', 'ฟังเสียง']);
  assert.equal(result.usage.models['MITTR Fast'].windows.weekly.valueLabel, '10,000 of 981,205 left');
  assert.equal(result.usage.models['ฟังเสียง'].windows.weekly.valueLabel, '10 h of 10 h left');
});

test('the overall weekly share reads only the lines shown', async () => {
  const shown = await providerFor(DEV_PLATFORM_WEEK, { catalogModels: () => ({ configured: true, items: [{ alias: 'mittr-fast', label: 'MITTR Fast' }] }) }).fetchQuota();
  assert.equal(Math.round(shown.usage.windows.weekly.usedPercent), 99);
  const quiet = await providerFor(quota([
    { modelKey: 'writer', label: 'Writer', used: 1, limit: 100, kind: 'chat' },
    { modelKey: 'm:41aa0be2c7d9', label: '', labelKey: 'quota.role.manager', used: 100, limit: 100, kind: 'chat' },
  ])).fetchQuota();
  assert.equal(quiet.usage.windows.weekly.usedPercent, 1);
});

test('with no catalog held yet the week reads as not read, never as no model available', async () => {
  for (const models of [null, undefined, { configured: false, items: [] }]) {
    const result = await providerFor(DEV_PLATFORM_WEEK, { catalogModels: () => models }).fetchQuota();
    assert.equal(result.ok, false, JSON.stringify(models));
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Could not read this week’s quota');
    assert.equal(result.usage, null);
  }
});

test('signed out or with no platform the week is never read as no model available', async () => {
  for (const reasonCode of ['not_signed_in', 'not_configured']) {
    const result = await providerFor(null, {
      isSignedIn: () => reasonCode !== 'not_signed_in',
      isBrokerConfigured: () => reasonCode !== 'not_configured',
      catalogModels: () => null,
      service: { readMine: async () => { throw Object.assign(new Error('no'), { reasonCode }); } },
    }).fetchQuota();
    assert.equal(result.ok, false, reasonCode);
    assert.equal(JSON.stringify(result).includes('No model available this week'), false, reasonCode);
  }
});

test('a week with only internal lines reads no model available', async () => {
  const result = await providerFor(quota([{ modelKey: 'm:9b17db7ab3d1', label: '', labelKey: 'quota.role.decision', used: 1, limit: 10, kind: 'chat' }])).fetchQuota();
  assert.deepEqual(result.usage.models, {});
  assert.deepEqual(Object.keys(result.usage.windows), ['No model available this week']);
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
    ['not_permitted', 'This week’s quota is not available to you'],
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
