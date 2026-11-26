import React from 'react';

import { SETTINGS_FIELD_LABEL_CLASS } from '../../../ui/src/components/sections/shared/SettingsSection';
import { Button } from '../../../ui/src/components/ui/button';
import { useMittrT } from '../strings/mittrT';
import { AccountSwitchDialog } from './AccountSwitchDialog';
import { accountsApi } from './accountsApi';
import { runSignOut, useAccountSwitch } from './accountSwitch';

export type SignOutButtonProps = { onSignedOut?: (signedIn: boolean) => void };

export function SignOutButton({ onSignedOut }: SignOutButtonProps): React.ReactNode {
  const t = useMittrT();
  const switching = useAccountSwitch();
  const { accountSwitch, state } = switching;
  const signOut = () => (onSignedOut
    ? runSignOut({ signOutActive: accountsApi.signOutActive, onSignedOut, accountSwitch })
    : accountSwitch.run(accountsApi.signOutActive));
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={state !== 'idle'}
        onClick={() => { void signOut(); }}
      >
        {t('mittr.accounts.signOut')}
      </Button>
      <AccountSwitchDialog {...switching} />
    </>
  );
}

export function AboutSettingsSignOut(): React.ReactNode {
  const t = useMittrT();
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--surface-subtle)] px-4 py-3">
      <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('mittr.accounts.about.label')}</span>
      <SignOutButton />
    </div>
  );
}
