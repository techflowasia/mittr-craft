import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { toast } from '../../../ui/src/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../ui/src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/src/components/ui/tooltip';
import { beginSignInWait } from '../sign-in/accountChange';
import { desktopBridge, scheduleWithTimers, type GateListen } from '../sign-in/signInGateController';
import { SIGN_IN_COMPLETED_EVENT, SIGN_IN_FAILED_EVENT } from '../sign-in/signInGateState';
import { mittrT, useMittrT } from '../strings/mittrT';
import { AccountSwitchDialog } from './AccountSwitchDialog';
import { accountName, accountsApi, initialsOf, type MittrAccount } from './accountsApi';
import { resyncThenReload, useAccountSwitch } from './accountSwitch';
import { createAddAccountFlow } from './addAccount';
import { FOOTER_BUTTON_CLASS } from './footerButtonClass';

type MenuActions = {
  onActivate: (userId: string) => void;
  onAddAccount: () => void;
  onSignOut: () => void;
};

export type MittrAccountMenuItemsProps = MenuActions & {
  accounts: MittrAccount[] | null;
  loadFailed: boolean;
  finishingSignIn: boolean;
};

export function MittrAccountMenuItems({ accounts, loadFailed, finishingSignIn, onActivate, onAddAccount, onSignOut }: MittrAccountMenuItemsProps): React.ReactNode {
  const t = useMittrT();
  return (
    <>
      {finishingSignIn ? <DropdownMenuLabel>{t('mittr.accounts.add.finishing')}</DropdownMenuLabel> : null}
      {loadFailed && !accounts ? <DropdownMenuLabel>{t('mittr.accounts.menu.loadFailed')}</DropdownMenuLabel> : null}
      {(accounts ?? []).map((account) => (
        <DropdownMenuItem
          key={account.userId}
          disabled={finishingSignIn && !account.active}
          onClick={account.active ? undefined : () => onActivate(account.userId)}
          className="flex items-center justify-between gap-2"
        >
          <span className="truncate">{accountName(account)}</span>
          {account.active ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onAddAccount}>{t('mittr.accounts.menu.add')}</DropdownMenuItem>
      <DropdownMenuItem disabled={finishingSignIn} onClick={onSignOut}>{t('mittr.accounts.signOut')}</DropdownMenuItem>
    </>
  );
}

export type MittrAccountMenuViewProps = MittrAccountMenuItemsProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MittrAccountMenuView({ open, onOpenChange, ...items }: MittrAccountMenuViewProps): React.ReactNode {
  const t = useMittrT();
  const active = items.accounts?.find((account) => account.active) ?? null;
  const initials = active ? initialsOf(accountName(active)) : '';
  const label = active ? t('mittr.accounts.menu.labelFor', { name: accountName(active) }) : t('mittr.accounts.menu.label');
  return (
    <DropdownMenu open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className={FOOTER_BUTTON_CLASS} aria-label={label}>
              {initials ? (
                <span className="flex size-6 items-center justify-center rounded-full border border-border typography-micro font-medium">{initials}</span>
              ) : (
                <Icon name="user" className="h-4.5 w-4.5" />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}><p>{active ? accountName(active) : label}</p></TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
        <MittrAccountMenuItems {...items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const subscribeDesktopEvent = (listen: GateListen, event: string, handler: () => void, keep: (stop: () => void) => void) => {
  try {
    void Promise.resolve(listen(event, handler)).then(keep, () => {});
  } catch {
    return;
  }
};

export function MittrAccountMenu(): React.ReactNode {
  const [open, setOpen] = React.useState(false);
  const [accounts, setAccounts] = React.useState<MittrAccount[] | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const { accountSwitch, state } = useAccountSwitch();
  const [addAccount] = React.useState(() => createAddAccountFlow({
    startAddAccount: () => accountsApi.startAddAccount(),
    beginWait: beginSignInWait,
    schedule: scheduleWithTimers,
    onWaiting: () => { toast.info(mittrT('mittr.accounts.add.waiting')); },
    onStartFailed: () => { toast.error(mittrT('mittr.accounts.add.startFailed')); },
    onFailed: () => { toast.error(mittrT('mittr.accounts.add.failed')); },
    onAdded: () => {
      if (accountSwitch.state() !== 'idle') return false;
      void accountSwitch.run(accountsApi.retrySwitch);
      return true;
    },
    resyncThenReload: () => {
      accountSwitch.abandon();
      resyncThenReload();
    },
  }));
  const finishingSignIn = React.useSyncExternalStore(addAccount.subscribe, addAccount.waiting, addAccount.waiting);

  React.useEffect(() => () => addAccount.dispose(), [addAccount]);

  const load = React.useCallback(() => {
    accountsApi.fetchAccounts().then(
      (list) => {
        setAccounts(list);
        setLoadFailed(false);
      },
      () => setLoadFailed(true),
    );
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    const listen = desktopBridge()?.listen;
    if (!listen) return undefined;
    let disposed = false;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (disposed) stop();
      else stops.push(stop);
    };
    subscribeDesktopEvent(listen, SIGN_IN_COMPLETED_EVENT, addAccount.signedIn, keep);
    subscribeDesktopEvent(listen, SIGN_IN_FAILED_EVENT, addAccount.signInFailed, keep);
    return () => {
      disposed = true;
      for (const stop of stops.splice(0)) stop();
    };
  }, [addAccount]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) load();
  };

  const onAddAccount = () => {
    void addAccount.start();
  };

  return (
    <>
      <MittrAccountMenuView
        accounts={accounts}
        loadFailed={loadFailed}
        finishingSignIn={finishingSignIn}
        open={open}
        onOpenChange={onOpenChange}
        onActivate={(userId) => { void accountSwitch.run(() => accountsApi.activateAccount(userId)); }}
        onAddAccount={onAddAccount}
        onSignOut={() => { void accountSwitch.run(accountsApi.signOutActive); }}
      />
      <AccountSwitchDialog
        state={state}
        onRetry={() => { void accountSwitch.retry(); }}
        onDismiss={() => { void accountSwitch.dismiss(); }}
      />
    </>
  );
}
