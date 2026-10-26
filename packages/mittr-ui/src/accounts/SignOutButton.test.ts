import { describe, expect, test } from 'bun:test';

import { createAccountSwitch, runSignOut } from './accountSwitch';

const quietSwitch = (retrySwitch = async () => ({ signedIn: false })) => {
  const reloads: string[] = [];
  const accountSwitch = createAccountSwitch({
    retrySwitch,
    reload: () => reloads.push('reload'),
    announce: () => {},
    holdGate: () => () => {},
  });
  return { accountSwitch, reloads };
};

describe('sign out', () => {
  test('sign out of the last account returns to the gate', async () => {
    const signedOut: boolean[] = [];
    await runSignOut({ signOutActive: async () => ({ signedIn: false }), onSignedOut: (signedIn) => signedOut.push(signedIn) });
    expect(signedOut).toEqual([false]);
  });

  test('signing out of one of two accounts says another is still signed in', async () => {
    const signedOut: boolean[] = [];
    await runSignOut({ signOutActive: async () => ({ signedIn: true, userId: 'u-b' }), onSignedOut: (signedIn) => signedOut.push(signedIn) });
    expect(signedOut).toEqual([true]);
  });

  test('a callback that does not reload leaves the button ready again', async () => {
    const { accountSwitch, reloads } = quietSwitch();
    await runSignOut({ signOutActive: async () => ({ signedIn: true, userId: 'u-b' }), onSignedOut: () => {}, accountSwitch });
    expect(accountSwitch.state()).toBe('idle');
    expect(reloads).toEqual([]);
  });

  test('a sign-out whose engine did not restart waits for the retry before it says anything', async () => {
    const signedOut: boolean[] = [];
    const { accountSwitch } = quietSwitch();
    await runSignOut({
      signOutActive: async () => ({ signedIn: false, engineRestarted: false }),
      onSignedOut: (signedIn) => signedOut.push(signedIn),
      accountSwitch,
    });
    expect(signedOut).toEqual([]);
    expect(accountSwitch.state()).toBe('not-restarted');

    await accountSwitch.retry();
    expect(signedOut).toEqual([false]);
    expect(accountSwitch.state()).toBe('idle');
  });

  test('a sign-out whose answer was lost is never sent twice', async () => {
    const signedOut: boolean[] = [];
    let signOuts = 0;
    const { accountSwitch } = quietSwitch(async () => ({ signedIn: false }));
    await runSignOut({
      signOutActive: () => { signOuts += 1; return Promise.reject(new Error('offline')); },
      onSignedOut: (signedIn) => signedOut.push(signedIn),
      accountSwitch,
    });
    expect(accountSwitch.state()).toBe('failed');
    await accountSwitch.retry();
    expect(signOuts).toBe(1);
    expect(signedOut).toEqual([false]);
  });
});
