import type { AccountsApi, SwitchOutcome } from './accountsApi';
import type { AddAccountFlow } from './addAccount';

export type MenuActions = {
  onActivate: (userId: string) => void;
  onAddAccount: () => void;
  onCancelAddAccount: () => void;
  onSignOut: () => void;
};

export function menuActions({ addAccount, runSwitch, api }: {
  addAccount: Pick<AddAccountFlow, 'start' | 'cancel'>;
  runSwitch: (change: () => Promise<SwitchOutcome>) => void;
  api: Pick<AccountsApi, 'activateAccount' | 'signOutActive'>;
}): MenuActions {
  return {
    onActivate: (userId) => { runSwitch(() => api.activateAccount(userId)); },
    onAddAccount: () => { void addAccount.start(); },
    onCancelAddAccount: () => { addAccount.cancel(); },
    onSignOut: () => { runSwitch(api.signOutActive); },
  };
}
