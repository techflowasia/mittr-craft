import { describe, expect, test } from 'bun:test';

import { HttpError, type SwitchOutcome } from './accountsApi';
import { createAccountSwitch, type AccountSwitchDeps } from './accountSwitch';

const held = () => {
  let settle: (outcome: SwitchOutcome) => void = () => {};
  const promise = new Promise<SwitchOutcome>((resolve) => { settle = resolve; });
  return { promise, settle };
};

const V1 = { code: 'MITTR_ENGINE_V1_HISTORY', message: 'Open MittrCraft 2.1.1 once.' };

const lost = () => Promise.reject(new Error('offline'));

const harness = (retrySwitch: AccountSwitchDeps['retrySwitch'] = async () => ({ signedIn: true })) => {
  const log: string[] = [];
  let holds = 0;
  const accountSwitch = createAccountSwitch({
    retrySwitch: () => {
      log.push('retry-switch');
      return retrySwitch();
    },
    reload: () => log.push('reload'),
    announce: () => log.push('announce'),
    holdGate: () => {
      holds += 1;
      log.push('hold');
      return () => {
        holds -= 1;
        log.push('release');
      };
    },
  });
  return { accountSwitch, log, holds: () => holds };
};

describe('account switch', () => {
  test('waits for the server, tells the other windows and reloads, and nothing can start a second switch meanwhile', async () => {
    const answer = held();
    const { accountSwitch, log, holds } = harness();
    let requests = 0;
    const request = () => { requests += 1; return answer.promise; };

    const running = accountSwitch.run(request);
    void accountSwitch.run(request);
    expect(accountSwitch.state()).toBe('switching');
    expect(requests).toBe(1);
    expect(holds()).toBe(1);

    answer.settle({ signedIn: true, userId: 'u-b' });
    await running;
    expect(log).toEqual(['hold', 'announce', 'reload']);
    expect(accountSwitch.state()).toBe('switching');
    expect(holds()).toBe(1);
  });

  test('a caller that handles the answer itself gets it once, and the switch goes back to idle', async () => {
    const { accountSwitch, log, holds } = harness();
    const done: SwitchOutcome[] = [];
    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-b' }), (outcome) => done.push(outcome));
    expect(done).toEqual([{ signedIn: true, userId: 'u-b' }]);
    expect(accountSwitch.state()).toBe('idle');
    expect(holds()).toBe(0);
    expect(log).toEqual(['hold', 'announce', 'release']);
  });

  test('an engine that did not restart is shown with a retry, which asks the server to finish the switch', async () => {
    const answers: SwitchOutcome[] = [{ signedIn: true, userId: 'u-b', engineRestarted: false }, { signedIn: true, userId: 'u-b' }];
    const { accountSwitch, log, holds } = harness(async () => answers.shift() ?? { signedIn: false });

    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-b', engineRestarted: false }));
    expect(accountSwitch.state()).toBe('not-restarted');
    expect(holds()).toBe(1);

    await accountSwitch.retry();
    expect(accountSwitch.state()).toBe('not-restarted');
    await accountSwitch.retry();
    expect(log).toEqual(['hold', 'retry-switch', 'retry-switch', 'announce', 'reload']);
    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('switching');
  });

  test('a sign-out whose answer was lost is never sent twice: Retry asks the server where it ended', async () => {
    const { accountSwitch, log } = harness(async () => ({ signedIn: false }));
    let signOuts = 0;
    await accountSwitch.run(() => { signOuts += 1; return lost(); });
    expect(accountSwitch.state()).toBe('failed');

    await accountSwitch.retry();
    expect(signOuts).toBe(1);
    expect(log).toEqual(['hold', 'retry-switch', 'announce', 'reload']);
  });

  test('a switch whose answer was lost resyncs through retry-switch, and so does Close', async () => {
    const retry = harness(async () => ({ signedIn: true, userId: 'u-b' }));
    let activations = 0;
    await retry.accountSwitch.run(() => { activations += 1; return lost(); });
    await retry.accountSwitch.retry();
    expect(activations).toBe(1);
    expect(retry.log).toEqual(['hold', 'retry-switch', 'announce', 'reload']);

    const close = harness(async () => ({ signedIn: true, userId: 'u-b' }));
    await close.accountSwitch.run(lost);
    await close.accountSwitch.dismiss();
    expect(close.log).toEqual(['hold', 'retry-switch', 'announce', 'reload']);

    const stillLost = harness(lost);
    await stillLost.accountSwitch.run(lost);
    await stillLost.accountSwitch.dismiss();
    expect(stillLost.log).toEqual(['hold', 'retry-switch', 'reload']);
  });

  test('a resync that is lost too can be retried, and repeats only the resync', async () => {
    let resyncs = 0;
    const { accountSwitch, log } = harness(() => {
      resyncs += 1;
      return resyncs === 1 ? lost() : Promise.resolve({ signedIn: true });
    });
    let activations = 0;
    await accountSwitch.run(() => { activations += 1; return lost(); });
    await accountSwitch.retry();
    expect(accountSwitch.state()).toBe('failed');
    await accountSwitch.retry();
    expect(activations).toBe(1);
    expect(log).toEqual(['hold', 'retry-switch', 'retry-switch', 'announce', 'reload']);
  });

  test('a request the server refused changed nothing: Retry repeats it and Close goes back to idle', async () => {
    const { accountSwitch, log, holds } = harness();
    let activations = 0;
    const activate = async (): Promise<SwitchOutcome> => {
      activations += 1;
      if (activations < 3) throw new HttpError(500);
      return { signedIn: true, userId: 'u-b' };
    };

    await accountSwitch.run(activate);
    expect(accountSwitch.state()).toBe('failed');
    await accountSwitch.retry();
    expect(activations).toBe(2);
    expect(accountSwitch.state()).toBe('failed');

    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('idle');
    expect(holds()).toBe(0);
    expect(log).toEqual(['hold', 'release']);

    await accountSwitch.run(activate);
    expect(activations).toBe(3);
    expect(log).toEqual(['hold', 'release', 'hold', 'announce', 'reload']);
  });

  test('a lost answer whose resync is refused stays unknown: Close resyncs and reloads, never plain idle', async () => {
    let resyncs = 0;
    const { accountSwitch, log } = harness(() => {
      resyncs += 1;
      return resyncs === 1 ? Promise.reject(new HttpError(503)) : Promise.resolve({ signedIn: true });
    });
    await accountSwitch.run(lost);
    await accountSwitch.retry();
    expect(accountSwitch.state()).toBe('failed');

    await accountSwitch.dismiss();
    expect(log).toEqual(['hold', 'retry-switch', 'retry-switch', 'announce', 'reload']);
    expect(accountSwitch.state()).toBe('switching');

    const refusedTwice = harness(() => Promise.reject(new HttpError(503)));
    await refusedTwice.accountSwitch.run(lost);
    await refusedTwice.accountSwitch.retry();
    await refusedTwice.accountSwitch.dismiss();
    expect(refusedTwice.log).toEqual(['hold', 'retry-switch', 'retry-switch', 'reload']);
  });

  test('a resync that answers clears the unknown outcome', async () => {
    const answers: Array<() => Promise<SwitchOutcome>> = [
      () => Promise.resolve({ signedIn: true, engineRestarted: false }),
      () => Promise.reject(new HttpError(503)),
    ];
    const { accountSwitch, log, holds } = harness(() => (answers.shift() ?? (() => Promise.resolve({ signedIn: true })))());
    await accountSwitch.run(lost);
    await accountSwitch.retry();
    expect(accountSwitch.state()).toBe('not-restarted');
    await accountSwitch.retry();
    expect(accountSwitch.state()).toBe('failed');
    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('idle');
    expect(holds()).toBe(0);
    expect(log).toEqual(['hold', 'retry-switch', 'retry-switch', 'release']);
  });

  test('a caller whose callback throws still gets the switch back to idle and the gate released', async () => {
    const { accountSwitch, holds } = harness();
    await expect(accountSwitch.run(async () => ({ signedIn: false }), () => { throw new Error('callback broke'); })).rejects.toThrow('callback broke');
    expect(accountSwitch.state()).toBe('idle');
    expect(holds()).toBe(0);
  });

  test('detaching in the not-restarted or failed state releases the gate, and attaching again holds it', async () => {
    const stuck = harness();
    const detach = stuck.accountSwitch.attach();
    await stuck.accountSwitch.run(async () => ({ signedIn: true, engineRestarted: false }));
    expect(stuck.holds()).toBe(1);
    detach();
    expect(stuck.holds()).toBe(0);
    const detachAgain = stuck.accountSwitch.attach();
    expect(stuck.holds()).toBe(1);
    detachAgain();
    expect(stuck.holds()).toBe(0);

    const failing = harness();
    const detachFailing = failing.accountSwitch.attach();
    await failing.accountSwitch.run(lost);
    expect(failing.accountSwitch.state()).toBe('failed');
    detachFailing();
    expect(failing.holds()).toBe(0);
    await failing.accountSwitch.retry();
    expect(failing.holds()).toBe(0);
  });

  test('a switch the server refused says why; closing it returns to the account still running, with no reload', async () => {
    const { accountSwitch, log, holds } = harness();
    await accountSwitch.run(() => Promise.reject(new HttpError(409, { error: V1.message, code: V1.code })));
    expect(accountSwitch.state()).toBe('failed');
    expect(accountSwitch.problem()).toEqual(V1);

    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('idle');
    expect(accountSwitch.problem()).toBeNull();
    expect(holds()).toBe(0);
    expect(log).toEqual(['hold', 'release']);
  });

  test('a lost answer and a refusal without words carry no reason', async () => {
    const { accountSwitch } = harness();
    await accountSwitch.run(lost);
    expect(accountSwitch.problem()).toBeNull();

    const silent = harness();
    await silent.accountSwitch.run(() => Promise.reject(new HttpError(500)));
    expect(silent.accountSwitch.problem()).toBeNull();
  });

  test('an engine that did not start says why, and a new attempt forgets it', async () => {
    const answer = held();
    const { accountSwitch } = harness(() => answer.promise);
    await accountSwitch.run(async () => ({ signedIn: true, engineRestarted: false, engineError: V1 }));
    expect(accountSwitch.state()).toBe('not-restarted');
    expect(accountSwitch.problem()).toEqual(V1);

    const retrying = accountSwitch.retry();
    expect(accountSwitch.state()).toBe('switching');
    expect(accountSwitch.problem()).toBeNull();
    answer.settle({ signedIn: true, engineRestarted: false });
    await retrying;
    expect(accountSwitch.state()).toBe('not-restarted');
    expect(accountSwitch.problem()).toBeNull();
  });

  test('from an engine that did not start, another account can be switched to instead', async () => {
    const { accountSwitch, log } = harness();
    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-b', engineRestarted: false, engineError: V1 }));
    await accountSwitch.instead(async () => ({ signedIn: true, userId: 'u-a' }));
    expect(log).toEqual(['hold', 'announce', 'reload']);

    const idle = harness();
    let asked = 0;
    await idle.accountSwitch.instead(async () => { asked += 1; return { signedIn: true }; });
    expect(asked).toBe(0);
    expect(idle.accountSwitch.state()).toBe('idle');
  });

  test('when that account is refused too, closing goes back to the engine that did not start, never to the app', async () => {
    const { accountSwitch, log, holds } = harness();
    const busy = { code: 'MITTR_ENGINE_DATABASE_BUSY', message: 'Another copy is open.' };
    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-b', engineRestarted: false, engineError: V1 }));
    await accountSwitch.instead(() => Promise.reject(new HttpError(409, { error: busy.message, code: busy.code })));
    expect(accountSwitch.state()).toBe('failed');
    expect(accountSwitch.problem()).toEqual(busy);

    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('not-restarted');
    expect(accountSwitch.problem()).toEqual(V1);
    expect(holds()).toBe(1);
    expect(log).toEqual(['hold']);
  });

  test('an account added but not switched to stays on the current one: no announcement, no reload, and closing is idle', async () => {
    const { accountSwitch, log } = harness();
    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-a', switchRefused: V1 }));
    expect(accountSwitch.state()).toBe('failed');
    expect(accountSwitch.problem()).toEqual({ ...V1, added: true });
    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('idle');
    expect(log).toEqual(['hold', 'release']);
  });

  test('an account added but not switched to, in a window that still owes a reload, resyncs and reloads once it is closed', async () => {
    const { accountSwitch, log } = harness();
    await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-a', switchRefused: V1, reloadOwed: true }));
    expect(accountSwitch.state()).toBe('failed');
    expect(log).toEqual(['hold']);
    await accountSwitch.dismiss();
    expect(log).toEqual(['hold', 'retry-switch', 'announce', 'reload']);
  });

  test('only a failed request can be closed: a switch under way stays', async () => {
    const answer = held();
    const { accountSwitch } = harness();
    const running = accountSwitch.run(() => answer.promise);
    await accountSwitch.dismiss();
    expect(accountSwitch.state()).toBe('switching');
    answer.settle({ signedIn: true, engineRestarted: false });
    await running;
    expect(accountSwitch.state()).toBe('not-restarted');
  });
});
