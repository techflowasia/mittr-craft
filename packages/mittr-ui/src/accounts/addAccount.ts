import { TRANSACTION_TTL_MS, type GateSchedule } from '../sign-in/signInGateController';

export type AddAccountDeps = {
  startAddAccount: () => Promise<boolean>;
  cancelAddAccount: () => void;
  beginWait: () => (handled: boolean) => void;
  schedule: GateSchedule;
  onWaiting: () => void;
  onStartFailed: () => void;
  onFailed: () => void;
  onAdded: () => boolean;
  resyncThenReload: () => void;
};

export type AddAccountFlow = {
  start: () => Promise<void>;
  signedIn: () => void;
  signInFailed: () => void;
  cancel: () => void;
  dispose: () => void;
  waiting: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

export function createAddAccountFlow({
  startAddAccount,
  cancelAddAccount,
  beginWait,
  schedule,
  onWaiting,
  onStartFailed,
  onFailed,
  onAdded,
  resyncThenReload,
}: AddAccountDeps): AddAccountFlow {
  let endWait: ((handled: boolean) => void) | null = null;
  let cancelTimer: () => void = () => {};
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  const finish = (handled: boolean): boolean => {
    const end = endWait;
    if (!end) return false;
    endWait = null;
    cancelTimer();
    cancelTimer = () => {};
    end(handled);
    changed();
    return true;
  };

  return {
    start: async () => {
      if (!(await startAddAccount())) {
        onStartFailed();
        return;
      }
      if (!endWait) {
        endWait = beginWait();
        changed();
      }
      cancelTimer();
      cancelTimer = schedule(() => { finish(false); }, TRANSACTION_TTL_MS);
      onWaiting();
    },
    signedIn: () => {
      if (!endWait) return;
      if (!onAdded()) resyncThenReload();
      finish(true);
    },
    signInFailed: () => {
      if (finish(false)) onFailed();
    },
    cancel: () => {
      if (!endWait) return;
      cancelAddAccount();
      finish(false);
    },
    dispose: () => {
      finish(false);
    },
    waiting: () => endWait !== null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
