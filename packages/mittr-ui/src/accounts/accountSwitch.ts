import React from 'react';

import { announceAccountChanged, holdGate, reloadOrDefer } from '../sign-in/accountChange';
import { accountsApi, HttpError, type SwitchOutcome, type SwitchProblem } from './accountsApi';

export type AccountSwitchState = 'idle' | 'switching' | 'not-restarted' | 'failed';

export type AccountSwitchProblem = SwitchProblem & { added?: true };

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
  problem: () => AccountSwitchProblem | null;
  subscribe: (listener: () => void) => () => void;
  run: (request: SwitchRequest, onDone?: (outcome: SwitchOutcome) => void) => Promise<void>;
  retry: () => Promise<void>;
  instead: (request: SwitchRequest) => Promise<void>;
  dismiss: () => Promise<void>;
  attach: () => () => void;
  abandon: () => void;
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
  let problem: AccountSwitchProblem | null = null;
  let unfinished: { problem: AccountSwitchProblem | null } | null = null;
  let lastRequest: SwitchRequest | null = null;
  let failed: FailedRequest | null = null;
  let outcomeUnknown = false;
  let attached = true;
  let generation = 0;
  let finish: ((outcome: SwitchOutcome) => void) | null = null;
  let releaseGate: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const show = (next: AccountSwitchState, why: AccountSwitchProblem | null = null) => {
    if (next === current) return;
    current = next;
    problem = why;
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
    unfinished = null;
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
    if (outcome.switchRefused) {
      failed = 'refused';
      if (outcome.reloadOwed) outcomeUnknown = true;
      show('failed', { ...outcome.switchRefused, added: true });
      return;
    }
    unfinished = null;
    if (outcome.engineRestarted === false) show('not-restarted', outcome.engineError ?? null);
    else succeed(outcome);
  };

  const send = async (request: SwitchRequest) => {
    lastRequest = request;
    failed = null;
    show('switching');
    const sent = generation;
    let outcome: SwitchOutcome;
    try {
      outcome = await request();
    } catch (error) {
      if (sent !== generation) return;
      failed = error instanceof HttpError ? 'refused' : 'lost';
      if (failed === 'lost') outcomeUnknown = true;
      show('failed', error instanceof HttpError && error.error ? { code: error.code, message: error.error } : null);
      return;
    }
    if (sent !== generation) return;
    if (request === retrySwitch) outcomeUnknown = false;
    settle(outcome);
  };

  return {
    state: () => current,
    problem: () => problem,
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
    instead: async (request) => {
      if (current !== 'not-restarted') return;
      unfinished = { problem };
      await send(request);
    },
    dismiss: async () => {
      if (current !== 'failed') return;
      if (failed === 'refused' && !outcomeUnknown) {
        if (unfinished) {
          show('not-restarted', unfinished.problem);
          unfinished = null;
          return;
        }
        forget();
        show('idle');
        return;
      }
      show('switching');
      const sent = generation;
      let outcome: SwitchOutcome;
      try {
        outcome = await retrySwitch();
      } catch {
        if (sent === generation) reload();
        return;
      }
      if (sent !== generation) return;
      outcomeUnknown = false;
      settle(outcome);
    },
    abandon: () => {
      generation += 1;
      forget();
      show('idle');
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

export type AccountSwitchBinding = { accountSwitch: AccountSwitch; state: AccountSwitchState; problem: AccountSwitchProblem | null };

export function useAccountSwitch(): AccountSwitchBinding {
  const [accountSwitch] = React.useState(() => createAccountSwitch());
  React.useEffect(() => accountSwitch.attach(), [accountSwitch]);
  const state = React.useSyncExternalStore(accountSwitch.subscribe, accountSwitch.state, accountSwitch.state);
  const problem = React.useSyncExternalStore(accountSwitch.subscribe, accountSwitch.problem, accountSwitch.problem);
  return { accountSwitch, state, problem };
}
