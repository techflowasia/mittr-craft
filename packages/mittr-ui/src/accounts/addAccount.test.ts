import { describe, expect, test } from 'bun:test';

import { createAddAccountFlow, type AddAccountDeps } from './addAccount';

const harness = (opened = true) => {
  const log: string[] = [];
  const timers = new Set<() => void>();
  const deps: AddAccountDeps = {
    startAddAccount: async () => opened,
    beginWait: () => {
      log.push('wait');
      return (handled) => log.push(handled ? 'end handled' : 'end');
    },
    schedule: (run) => {
      timers.add(run);
      return () => { timers.delete(run); };
    },
    onWaiting: () => log.push('waiting'),
    onStartFailed: () => log.push('start failed'),
    onFailed: () => log.push('failed'),
    onAdded: () => log.push('added'),
  };
  const fireTimers = () => { for (const run of [...timers]) { timers.delete(run); run(); } };
  return { flow: createAddAccountFlow(deps), log, fireTimers, timers };
};

describe('adding an account', () => {
  test('a sign-in that finishes ends the wait as handled, then the account is added', async () => {
    const { flow, log, timers } = harness();
    await flow.start();
    flow.signedIn();
    flow.signedIn();
    expect(log).toEqual(['wait', 'waiting', 'end handled', 'added']);
    expect(timers.size).toBe(0);
  });

  test('a sign-in that fails, or a wait that runs out, ends the wait unhandled, so a deferred reload can run', async () => {
    const failed = harness();
    await failed.flow.start();
    failed.flow.signInFailed();
    expect(failed.log).toEqual(['wait', 'waiting', 'end', 'failed']);

    const expired = harness();
    await expired.flow.start();
    expired.fireTimers();
    expired.flow.signedIn();
    expect(expired.log).toEqual(['wait', 'waiting', 'end']);
  });

  test('a browser that did not open starts no wait, and a sign-in event without a wait does nothing', async () => {
    const { flow, log } = harness(false);
    await flow.start();
    flow.signedIn();
    flow.signInFailed();
    expect(log).toEqual(['start failed']);
  });

  test('starting again while waiting keeps the one wait, and leaving ends it unhandled', async () => {
    const { flow, log, timers } = harness();
    await flow.start();
    await flow.start();
    expect(log).toEqual(['wait', 'waiting', 'waiting']);
    expect(timers.size).toBe(1);
    flow.dispose();
    flow.dispose();
    expect(log).toEqual(['wait', 'waiting', 'waiting', 'end']);
  });
});
