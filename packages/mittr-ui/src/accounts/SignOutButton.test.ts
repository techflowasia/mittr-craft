import { describe, expect, test } from 'bun:test';

import { createAccountSwitch, runSignOut } from './accountSwitch';

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

  test('a sign-out whose engine did not restart waits for the retry before it says anything', async () => {
    const signedOut: boolean[] = [];
    const accountSwitch = createAccountSwitch({ retrySwitch: async () => ({ signedIn: false }) });
    await runSignOut({
      signOutActive: async () => ({ signedIn: false, engineRestarted: false }),
      onSignedOut: (signedIn) => signedOut.push(signedIn),
      accountSwitch,
    });
    expect(signedOut).toEqual([]);
    expect(accountSwitch.state()).toBe('not-restarted');

    await accountSwitch.retry();
    expect(signedOut).toEqual([false]);
  });

  test('a sign-out the server refused says nothing and can be tried again', async () => {
    const signedOut: boolean[] = [];
    const accountSwitch = createAccountSwitch({ retrySwitch: async () => ({ signedIn: false }) });
    await runSignOut({ signOutActive: async () => { throw new Error('HTTP 503'); }, onSignedOut: (signedIn) => signedOut.push(signedIn), accountSwitch });
    expect(signedOut).toEqual([]);
    expect(accountSwitch.state()).toBe('failed');
  });
});
