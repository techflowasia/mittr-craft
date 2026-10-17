import React from 'react';

import { announceAccountChanged, holdGate, reloadOrDefer } from '../sign-in/accountChange';
import { accountsApi, HttpError, type SwitchOutcome } from './accountsApi';

export type AccountSwitchState = 'idle' | 'switching' | 'not-restarted' | 'failed';

type SwitchRequest = () => Promise<SwitchOutcome>;

type FailedRequest = 'refused' | 'lost';

export type AccountSwitchDeps = {
  retrySwitch: SwitchRequest;
  reload: () => void;
  announce: () => void;
  holdGate: () => () => void;
};

export type AccountSwitch = {
  state: () => AccountSwitchState;
  subscribe: (listener: () => void) => () => void;
  run: (request: SwitchRequest, onDone?: (outcome: SwitchOutcome) => void) => Promise<void>;
  retry: () => Promise<void>;
  dismiss: () => Promise<void>;
  attach: () => () => void;
};

export const reloadWindow = (): void => {
  window.location.reload();
};

export const resyncThenReload = (): void => {
  void accountsApi.retrySwitch().catch(() => undefined).finally(reloadWindow);
};

const ACCOUNT_SWITCH_DEPS: AccountSwitchDeps = {
  retrySwitch: () => accountsApi.retrySwitch(),
  reload: () => reloadOrDefer(reloadWindow, resyncThenReload),
  announce: announceAccountChanged,
  holdGate,
};

export function createAccountSwitch({ retrySwitch, reload, announce, holdGate: hold }: AccountSwitchDeps = ACCOUNT_SWITCH_DEPS): AccountSwitch {
  let current: AccountSwitchState = 'idle';
  let lastRequest: SwitchRequest | null = null;
  let failed: FailedRequest | null = null;
  let outcomeUnknown = false;
  let attached = true;
  let finish: ((outcome: SwitchOutcome) => void) | null = null;
  let releaseGate: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const show = (next: AccountSwitchState) => {
    if (next === current) return;
    current = next;
    if (next === 'idle') {
      releaseGate?.();
      releaseGate = null;
    } else if (!releaseGate && attached) {
      releaseGate = hold();
    }
    for (const listener of listeners) listener();
  };

  const forget = () => {
    finish = null;
    lastRequest = null;
    failed = null;
    outcomeUnknown = false;
  };

  const succeed = (outcome: SwitchOutcome) => {
    announce();
    const done = finish;
    if (!done) {
      reload();
      return;
    }
    forget();
    try {
      done(outcome);
    } finally {
      show('idle');
    }
  };

  const settle = (outcome: SwitchOutcome) => {
    if (outcome.engineRestarted === false) show('not-restarted');
    else succeed(outcome);
  };

  const send = async (request: SwitchRequest) => {
    lastRequest = request;
    failed = null;
    show('switching');
    let outcome: SwitchOutcome;
    try {
      outcome = await request();
    } catch (error) {
      failed = error instanceof HttpError ? 'refused' : 'lost';
      if (failed === 'lost') outcomeUnknown = true;
      show('failed');
      return;
    }
    if (request === retrySwitch) outcomeUnknown = false;
    settle(outcome);
  };

  return {
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    run: async (request, onDone) => {
      if (current !== 'idle') return;
      finish = onDone ?? null;
      await send(request);
    },
    retry: async () => {
      if (current === 'not-restarted') await send(retrySwitch);
      else if (current === 'failed') await send(failed === 'refused' && lastRequest ? lastRequest : retrySwitch);
    },
    dismiss: async () => {
      if (current !== 'failed') return;
      if (failed === 'refused' && !outcomeUnknown) {
        forget();
        show('idle');
        return;
      }
      show('switching');
      let outcome: SwitchOutcome;
      try {
        outcome = await retrySwitch();
      } catch {
        reload();
        return;
      }
      outcomeUnknown = false;
      settle(outcome);
    },
    attach: () => {
      attached = true;
      if (current !== 'idle' && !releaseGate) releaseGate = hold();
      return () => {
        attached = false;
        releaseGate?.();
        releaseGate = null;
      };
    },
  };
}

export type SignOutDeps = {
  signOutActive: () => Promise<SwitchOutcome>;
  onSignedOut: (signedIn: boolean) => void;
  accountSwitch?: AccountSwitch;
};

export function runSignOut({ signOutActive, onSignedOut, accountSwitch = createAccountSwitch() }: SignOutDeps): Promise<void> {
  return accountSwitch.run(signOutActive, (outcome) => onSignedOut(outcome.signedIn));
}

export type AccountSwitchBinding = { accountSwitch: AccountSwitch; state: AccountSwitchState };

export function useAccountSwitch(): AccountSwitchBinding {
  const [accountSwitch] = React.useState(() => createAccountSwitch());
  React.useEffect(() => accountSwitch.attach(), [accountSwitch]);
  const state = React.useSyncExternalStore(accountSwitch.subscribe, accountSwitch.state, accountSwitch.state);
  return { accountSwitch, state };
}
