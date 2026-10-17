import { describe, expect, test } from 'bun:test';

import { createAccountSwitch } from './accountSwitch';
import type { SwitchOutcome } from './accountsApi';

const held = () => {
  let settle: (outcome: SwitchOutcome) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const promise = new Promise<SwitchOutcome>((resolve, reject) => { settle = resolve; fail = reject; });
  return { promise, settle, fail };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('account switch', () => {
  test('waits for the server, then hands over its answer once, and nothing can start a second switch meanwhile', async () => {
    const answer = held();
    const done: SwitchOutcome[] = [];
    let actions = 0;
    const accountSwitch = createAccountSwitch({ retrySwitch: async () => ({ signedIn: true }) });
    const seen: string[] = [];
    accountSwitch.subscribe(() => seen.push(accountSwitch.state()));

    const running = accountSwitch.run(() => { actions += 1; return answer.promise; }, (outcome) => done.push(outcome));
    void accountSwitch.run(() => { actions += 1; return answer.promise; }, (outcome) => done.push(outcome));
    expect(accountSwitch.state()).toBe('switching');
    expect(actions).toBe(1);

    answer.settle({ signedIn: true, userId: 'u-b' });
    await running;
    expect(done).toEqual([{ signedIn: true, userId: 'u-b' }]);
    expect(accountSwitch.state()).toBe('switching');
    expect(seen).toEqual(['switching']);
  });

  test('an engine that did not restart is shown with a retry, which asks the server to finish the switch', async () => {
    const done: SwitchOutcome[] = [];
    const retries: SwitchOutcome[] = [{ signedIn: true, userId: 'u-b', engineRestarted: false }, { signedIn: true, userId: 'u-b' }];
    const accountSwitch = createAccountSwitch({ retrySwitch: async () => retries.shift() ?? { signedIn: false } });

    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-b', engineRestarted: false }), (outcome) => done.push(outcome));
    expect(accountSwitch.state()).toBe('not-restarted');
    expect(done).toEqual([]);

    await accountSwitch.retry();
    expect(accountSwitch.state()).toBe('not-restarted');
    await accountSwitch.retry();
    expect(done).toEqual([{ signedIn: true, userId: 'u-b' }]);
    expect(retries).toEqual([]);
  });

  test('a request that failed can be tried again or closed, and trying again repeats what failed', async () => {
    const done: SwitchOutcome[] = [];
    let activations = 0;
    let retries = 0;
    const accountSwitch = createAccountSwitch({
      retrySwitch: async () => {
        retries += 1;
        if (retries === 1) throw new Error('offline');
        return { signedIn: true, userId: 'u-b' };
      },
    });
    const activate = async (): Promise<SwitchOutcome> => {
      activations += 1;
      if (activations === 1) throw new Error('HTTP 500');
      return { signedIn: true, userId: 'u-b', engineRestarted: false };
    };

    await accountSwitch.run(activate, (outcome) => done.push(outcome));
    expect(accountSwitch.state()).toBe('failed');
    await accountSwitch.retry();
    expect(activations).toBe(2);
    expect(accountSwitch.state()).toBe('not-restarted');

    await accountSwitch.retry();
    expect(accountSwitch.state()).toBe('failed');
    await accountSwitch.retry();
    expect(activations).toBe(2);
    expect(retries).toBe(2);
    expect(done).toEqual([{ signedIn: true, userId: 'u-b' }]);

    const closing = createAccountSwitch({ retrySwitch: async () => ({ signedIn: true }) });
    await closing.run(async () => { throw new Error('HTTP 503'); }, () => {});
    closing.dismiss();
    expect(closing.state()).toBe('idle');
    await flush();
  });

  test('only a failed request can be closed: a switch under way or one waiting on a retry stays', async () => {
    const answer = held();
    const accountSwitch = createAccountSwitch({ retrySwitch: async () => ({ signedIn: true }) });
    const running = accountSwitch.run(() => answer.promise, () => {});
    accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('switching');
    answer.settle({ signedIn: true, engineRestarted: false });
    await running;
    accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('not-restarted');
  });
});
