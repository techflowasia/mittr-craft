import { describe, expect, it } from 'vitest';
import { describeModelRefusal } from './model-refusal.js';

describe('describeModelRefusal', () => {
  it('sends an entitlement refusal to an admin', () => {
    expect(describeModelRefusal({ error: 'desktop_entitlement_required' })).toEqual({
      reason: 'entitlement',
      messageKey: 'mittr.model.refused.entitlement',
      canResync: false,
    });
  });

  it('offers a re-sync when the platform no longer grants the model', () => {
    expect(describeModelRefusal({ error: 'agent_not_granted' })).toEqual({
      reason: 'stale-catalog',
      messageKey: 'mittr.model.refused.staleCatalog',
      canResync: true,
    });
  });

  it('falls back without inventing a cause', () => {
    expect(describeModelRefusal({ error: 'something_else' }).reason).toBe('unknown');
    expect(describeModelRefusal(null).reason).toBe('unknown');
  });

  it('never offers a re-sync for an entitlement problem, which re-syncing cannot fix', () => {
    expect(describeModelRefusal({ error: 'desktop_entitlement_required' }).canResync).toBe(false);
  });
});
