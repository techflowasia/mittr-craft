import { describe, expect, test } from 'bun:test';

import { beginSignInWait, reloadDeferred, reloadOrDefer } from '../sign-in/accountChange';
import { createAccountSwitch } from './accountSwitch';
import { HttpError, type AccountList, type MittrAccount, type SwitchOutcome } from './accountsApi';
import { addedAccountOutcome, createAddAccountFlow, type AddAccountDeps } from './addAccount';

const harness = (opened = true) => {
  const log: string[] = [];
  const timers = new Set<() => void>();
  const deps: AddAccountDeps = {
    startAddAccount: async () => opened,
    cancelAddAccount: () => log.push('cancel at server'),
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
    onAdded: () => {
      log.push('added');
      return true;
    },
    resyncThenReload: () => log.push('resync and reload'),
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
    expect(log).toEqual(['wait', 'waiting', 'added', 'end handled']);
    expect(timers.size).toBe(0);
  });

  test('a finished sign-in whose own resync could not start falls back to one resync and reload, then ends the wait', async () => {
    const log: string[] = [];
    const fallback = createAddAccountFlow({
      startAddAccount: async () => true,
      cancelAddAccount: () => {},
      beginWait: () => (handled) => log.push(handled ? 'end handled' : 'end'),
      schedule: () => () => {},
      onWaiting: () => {},
      onStartFailed: () => {},
      onFailed: () => {},
      onAdded: () => {
        log.push('not idle');
        return false;
      },
      resyncThenReload: () => log.push('resync and reload'),
    });
    await fallback.start();
    fallback.signedIn();
    expect(log).toEqual(['not idle', 'resync and reload', 'end handled']);
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

  test('cancelling ends the wait unhandled with no failure, and a sign-in that finishes later is not taken as the add', async () => {
    const { flow, log, timers } = harness();
    const seen: boolean[] = [];
    flow.subscribe(() => seen.push(flow.waiting()));
    await flow.start();
    flow.cancel();
    flow.cancel();
    flow.signedIn();
    flow.signInFailed();
    expect(log).toEqual(['wait', 'waiting', 'cancel at server', 'end']);
    expect(timers.size).toBe(0);
    expect(flow.waiting()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test('a cancelled add lets a reload that waited on it run', async () => {
    const reloads: string[] = [];
    const flow = createAddAccountFlow({
      startAddAccount: async () => true,
      cancelAddAccount: () => {},
      beginWait: beginSignInWait,
      schedule: () => () => {},
      onWaiting: () => {},
      onStartFailed: () => {},
      onFailed: () => {},
      onAdded: () => true,
      resyncThenReload: () => {},
    });
    await flow.start();
    reloadOrDefer(() => reloads.push('now'), () => reloads.push('deferred'));
    expect(reloads).toEqual([]);
    flow.cancel();
    expect(reloads).toEqual(['deferred']);
  });

  test('cancel with no wait asks the server for nothing', async () => {
    const { flow, log } = harness();
    flow.cancel();
    expect(log).toEqual([]);
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

const A: MittrAccount = { userId: 'u-a', displayName: 'Ann Lee', active: true };
const B: MittrAccount = { userId: 'u-b', displayName: 'Bo', active: false };
const V1 = { code: 'MITTR_ENGINE_V1_HISTORY', message: 'Open MittrCraft 2.1.1 once.' };

describe('an account added but not switched to', () => {
  const flush = async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };

  const asked = (list: () => Promise<AccountList>, reloadOwed = false) => {
    const log: string[] = [];
    const listed: MittrAccount[][] = [];
    const outcome = addedAccountOutcome({
      fetchAccountList: list,
      retrySwitch: async () => { log.push('retry-switch'); return { signedIn: true, userId: 'u-b' }; },
      reloadOwed,
      onAccounts: (accounts) => listed.push(accounts),
    });
    return { outcome, log, listed };
  };

  test('the refusal in the account list ends the add with its reason and the list, and asks for no switch', async () => {
    const refused = asked(async () => ({ accounts: [A, B], switchRefused: V1 }));
    expect(await refused.outcome).toEqual({ signedIn: true, switchRefused: V1 });
    expect(refused.listed).toEqual([[A, B]]);
    expect(refused.log).toEqual([]);

    expect(await asked(async () => ({ accounts: [A, B], switchRefused: V1 }), true).outcome).toEqual({ signedIn: true, switchRefused: V1, reloadOwed: true });
  });

  test('without a refusal, or with a list that cannot be read, the add resyncs as before', async () => {
    for (const list of [async () => ({ accounts: [A, B], switchRefused: null }), () => Promise.reject(new HttpError(500))]) {
      const added = asked(list);
      expect(await added.outcome).toEqual({ signedIn: true, userId: 'u-b' });
      expect(added.log).toEqual(['retry-switch']);
      expect(added.listed).toEqual([]);
    }
  });

  const window = () => {
    const reloads: string[] = [];
    const listed: MittrAccount[][] = [];
    let timers = 0;
    const retrySwitch = async (): Promise<SwitchOutcome> => ({ signedIn: true });
    const accountSwitch = createAccountSwitch({
      retrySwitch,
      reload: () => reloadOrDefer(() => reloads.push('reload'), () => reloads.push('deferred')),
      announce: () => {},
      holdGate: () => () => {},
    });
    const flow = createAddAccountFlow({
      startAddAccount: async () => true,
      cancelAddAccount: () => {},
      beginWait: beginSignInWait,
      schedule: () => { timers += 1; return () => { timers -= 1; }; },
      onWaiting: () => {},
      onStartFailed: () => {},
      onFailed: () => { throw new Error('the sign-in did not fail'); },
      reloadDeferred,
      onAdded: (reloadOwed) => {
        void accountSwitch.run(() => addedAccountOutcome({
          fetchAccountList: async () => ({ accounts: [A, B], switchRefused: V1 }),
          retrySwitch,
          reloadOwed,
          onAccounts: (accounts) => listed.push(accounts),
        }));
        return true;
      },
      resyncThenReload: () => reloads.push('fallback'),
    });
    return { flow, accountSwitch, reloads, listed, timers: () => timers };
  };

  test('the wait ends at once, the reason is shown, and closing it leaves the window running without a reload', async () => {
    const { flow, accountSwitch, reloads, listed, timers } = window();
    await flow.start();
    flow.signedIn();
    expect(flow.waiting()).toBe(false);
    expect(timers()).toBe(0);
    await flush();
    expect(accountSwitch.state()).toBe('failed');
    expect(accountSwitch.problem()).toEqual({ ...V1, added: true });
    expect(listed).toEqual([[A, B]]);

    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('idle');
    expect(reloads).toEqual([]);
  });

  test('a reload that waited on the add still happens, after the reason is closed', async () => {
    const { flow, accountSwitch, reloads } = window();
    await flow.start();
    reloadOrDefer(() => reloads.push('now'), () => reloads.push('deferred'));
    flow.signedIn();
    await flush();
    expect(accountSwitch.state()).toBe('failed');
    expect(reloads).toEqual([]);
    await accountSwitch.dismiss();
    expect(reloads).toEqual(['reload']);
  });
});

describe('adding an account while a switch is under way in the same window', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('a switch whose reload waits on the add, then the sign-in finishing, reloads exactly once and leaves nothing held', async () => {
    const reloads: string[] = [];
    let holds = 0;
    const reloadWindow = () => reloads.push('reload');
    const resyncThenReload = () => { void Promise.resolve().then(reloadWindow); };
    const accountSwitch = createAccountSwitch({
      retrySwitch: async () => ({ signedIn: true, userId: 'u-c' }),
      reload: () => reloadOrDefer(reloadWindow, resyncThenReload),
      announce: () => {},
      holdGate: () => {
        holds += 1;
        return () => { holds -= 1; };
      },
    });
    const flow = createAddAccountFlow({
      startAddAccount: async () => true,
      cancelAddAccount: () => {},
      beginWait: beginSignInWait,
      schedule: () => () => {},
      onWaiting: () => {},
      onStartFailed: () => {},
      onFailed: () => {},
      onAdded: () => {
        if (accountSwitch.state() !== 'idle') return false;
        void accountSwitch.run(async () => ({ signedIn: true, userId: 'u-c' }));
        return true;
      },
      resyncThenReload: () => {
        accountSwitch.abandon();
        resyncThenReload();
      },
    });

    await flow.start();
    expect(flow.waiting()).toBe(true);
    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-b' }));
    expect(reloads).toEqual([]);
    expect(accountSwitch.state()).toBe('switching');
    expect(holds).toBe(1);

    flow.signedIn();
    await flush();
    await flush();
    expect(reloads).toEqual(['reload']);
    expect(accountSwitch.state()).toBe('idle');
    expect(holds).toBe(0);
    expect(flow.waiting()).toBe(false);
  });

  test('with the switch idle, the sign-in finishing runs one resync and one reload through the switch', async () => {
    const reloads: string[] = [];
    const accountSwitch = createAccountSwitch({
      retrySwitch: async () => ({ signedIn: true }),
      reload: () => reloadOrDefer(() => reloads.push('reload'), () => reloads.push('deferred')),
      announce: () => {},
      holdGate: () => () => {},
    });
    const fallbacks: string[] = [];
    const flow = createAddAccountFlow({
      startAddAccount: async () => true,
      cancelAddAccount: () => {},
      beginWait: beginSignInWait,
      schedule: () => () => {},
      onWaiting: () => {},
      onStartFailed: () => {},
      onFailed: () => {},
      onAdded: () => {
        if (accountSwitch.state() !== 'idle') return false;
        void accountSwitch.run(async () => ({ signedIn: true, userId: 'u-c' }));
        return true;
      },
      resyncThenReload: () => fallbacks.push('fallback'),
    });
    await flow.start();
    flow.signedIn();
    await flush();
    expect(reloads).toEqual(['reload']);
    expect(fallbacks).toEqual([]);
  });

  test('while the add waits, its subscribers hear the wait start and end', async () => {
    const { flow } = harness();
    const seen: boolean[] = [];
    flow.subscribe(() => seen.push(flow.waiting()));
    await flow.start();
    flow.signInFailed();
    expect(seen).toEqual([true, false]);
  });
});
