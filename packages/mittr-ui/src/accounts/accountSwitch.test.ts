import { describe, expect, test } from 'bun:test';

import { HttpError, type SwitchOutcome } from './accountsApi';
import { createAccountSwitch, type AccountSwitchDeps } from './accountSwitch';

const held = () => {
  let settle: (outcome: SwitchOutcome) => void = () => {};
  const promise = new Promise<SwitchOutcome>((resolve) => { settle = resolve; });
  return { promise, settle };
};

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
