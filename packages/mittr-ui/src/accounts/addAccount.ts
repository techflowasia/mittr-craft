import { TRANSACTION_TTL_MS, type GateSchedule } from '../sign-in/signInGateController';

export type AddAccountDeps = {
  startAddAccount: () => Promise<boolean>;
  beginWait: () => (handled: boolean) => void;
  schedule: GateSchedule;
  onWaiting: () => void;
  onStartFailed: () => void;
  onFailed: () => void;
  onAdded: () => void;
};

export type AddAccountFlow = {
  start: () => Promise<void>;
  signedIn: () => void;
  signInFailed: () => void;
  dispose: () => void;
};

export function createAddAccountFlow({
  startAddAccount,
  beginWait,
  schedule,
  onWaiting,
  onStartFailed,
  onFailed,
  onAdded,
}: AddAccountDeps): AddAccountFlow {
  let endWait: ((handled: boolean) => void) | null = null;
  let cancelTimer: () => void = () => {};

  const finish = (handled: boolean): boolean => {
    const end = endWait;
    if (!end) return false;
    endWait = null;
    cancelTimer();
    cancelTimer = () => {};
    end(handled);
    return true;
  };

  return {
    start: async () => {
      if (!(await startAddAccount())) {
        onStartFailed();
        return;
      }
      endWait ??= beginWait();
      cancelTimer();
      cancelTimer = schedule(() => { finish(false); }, TRANSACTION_TTL_MS);
      onWaiting();
    },
    signedIn: () => {
      if (finish(true)) onAdded();
    },
    signInFailed: () => {
      if (finish(false)) onFailed();
    },
    dispose: () => {
      finish(false);
    },
  };
}
