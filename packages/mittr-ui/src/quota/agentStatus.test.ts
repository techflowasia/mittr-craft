import { afterEach, describe, expect, test } from 'bun:test';

import { agentEntryStatus, mittrEntryStatus } from './agentStatus';
import type { AgentStatus } from './quotaMeStore';

const status = (over: Partial<AgentStatus>): AgentStatus => ({
  modelKey: 'writer-model',
  left: 10,
  limit: 100,
  resetsAt: '2026-10-20T00:00:00+07:00',
  state: 'ok',
  ...over,
});

const machineZone = process.env.TZ;

afterEach(() => {
  if (machineZone === undefined) delete process.env.TZ;
  else process.env.TZ = machineZone;
});

describe('agent status marks', () => {
  test('out agent is blocked with its reset time', () => {
    const out = agentEntryStatus(status({ state: 'out', left: 0 }), 'Writer');
    expect(out?.blocked).toBe(true);
    expect(out?.tone).toBe('neutral');
    expect(out?.pill).toBe('Used up');
    expect(out?.title).toContain('Writer is used up this week');
    expect(out?.title).toContain('20 Oct');
  });

  test('the reset time does not depend on the machine time zone', () => {
    const titles = ['America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Bangkok'].map((zone) => {
      process.env.TZ = zone;
      return agentEntryStatus(status({ state: 'out', left: 0 }), 'Writer')?.title;
    });
    expect(new Set(titles).size).toBe(1);
    expect(titles[0]).toContain('20 Oct');
    expect(titles[0]).toContain('00:00');
  });

  test('the product time zone is explicit, so another zone gives another day', () => {
    const elsewhere = agentEntryStatus(status({ state: 'out', left: 0 }), 'Writer', undefined, 'en-GB', 'America/Los_Angeles');
    expect(elsewhere?.title).toContain('19 Oct');
    expect(elsewhere?.title).not.toContain('20 Oct');
  });

  test('near agent shows what is left', () => {
    const near = agentEntryStatus(status({ state: 'near', percentLeft: 12 }), 'Writer');
    expect(near).toEqual({
      blocked: false,
      tone: 'near',
      pill: '12% left',
      title: "Writer has 12% of this week's quota left.",
    });
  });

  test('a near agent without a percentage is worked out from what is left', () => {
    expect(agentEntryStatus(status({ state: 'near', left: 7, limit: 100 }), 'Writer')?.pill).toBe('7% left');
    expect(agentEntryStatus(status({ state: 'near', left: 0.2, limit: 100 }), 'Writer')?.pill).toBe('1% left');
  });

  test('ok agent has no mark', () => {
    expect(agentEntryStatus(status({ state: 'ok' }), 'Writer')).toBeNull();
    expect(agentEntryStatus(undefined, 'Writer')).toBeNull();
  });

  test('an agent on a backup model stays pickable and names the backup', () => {
    expect(agentEntryStatus(status({ state: 'substitute', substituteLabel: 'MITTR 1.0 fast' }), 'Writer')).toEqual({
      blocked: false,
      tone: 'neutral',
      pill: 'Using backup',
      title: 'Writer is used up this week, so MITTR 1.0 fast answers instead.',
    });
    expect(agentEntryStatus(status({ state: 'substitute' }), 'Writer')?.title)
      .toBe('Writer is used up this week, so a backup model answers instead.');
  });
});

describe('looking an agent up for a picker entry', () => {
  const statuses = new Map<string, AgentStatus>([
    ['writer', status({ state: 'out', left: 0 })],
    ['constructor', status({ state: 'near', percentLeft: 5 })],
  ]);
  const entryStatus = mittrEntryStatus(statuses);

  test('a Mittr entry is found by its model id and named by its display name', () => {
    expect(entryStatus({ providerID: 'mittr', modelID: 'writer', name: 'Mittr Writer' })?.title)
      .toContain('Mittr Writer is used up this week');
  });

  test('an entry of another provider with the same model id has no mark', () => {
    expect(entryStatus({ providerID: 'openai', modelID: 'writer', name: 'Writer' })).toBeNull();
  });

  test('an agent the quota does not list has no mark', () => {
    expect(entryStatus({ providerID: 'mittr', modelID: 'analyst', name: 'Analyst' })).toBeNull();
    expect(entryStatus({ providerID: 'mittr', modelID: 'toString', name: 'Odd' })).toBeNull();
  });

  test('before the quota is known nothing is marked', () => {
    expect(mittrEntryStatus(null)({ providerID: 'mittr', modelID: 'writer', name: 'Writer' })).toBeNull();
  });
});
