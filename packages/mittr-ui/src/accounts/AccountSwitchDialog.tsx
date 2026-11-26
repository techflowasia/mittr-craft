import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Button } from '../../../ui/src/components/ui/button';
import { Dialog, DialogContent } from '../../../ui/src/components/ui/dialog';
import type { MittrKey } from '../strings/mittrT';
import { useMittrT } from '../strings/mittrT';
import { accountName, accountsApi, isEngineRefusal, type AccountsApi, type MittrAccount } from './accountsApi';
import type { AccountSwitchBinding, AccountSwitchProblem, AccountSwitchState } from './accountSwitch';

type ShownState = Exclude<AccountSwitchState, 'idle'>;

const STATE_TEXT = {
  switching: 'mittr.accounts.switch.waiting',
  'not-restarted': 'mittr.accounts.switch.notRestarted',
  failed: 'mittr.accounts.switch.failed',
} satisfies Record<ShownState, MittrKey>;

const titleKey = (state: ShownState, problem: AccountSwitchProblem | null): MittrKey => (
  state === 'failed' && problem?.added ? 'mittr.accounts.add.notSwitched' : STATE_TEXT[state]
);

export type AccountSwitchStatusProps = {
  state: ShownState;
  problem?: AccountSwitchProblem | null;
  others?: MittrAccount[];
  onRetry: () => void;
  onDismiss: () => void;
  onContinueAs?: (userId: string) => void;
  firstActionRef?: React.Ref<HTMLButtonElement>;
};

const NO_ACCOUNTS: MittrAccount[] = [];

export function AccountSwitchStatus({ state, problem = null, others = NO_ACCOUNTS, onRetry, onDismiss, onContinueAs, firstActionRef }: AccountSwitchStatusProps): React.ReactNode {
  const t = useMittrT();
  if (state === 'switching') {
    return (
      <div role="status" className="flex items-center justify-center gap-2 typography-ui-label text-muted-foreground">
        <Icon name="loader" className="size-4 animate-spin" />
        <span>{t(STATE_TEXT.switching)}</span>
      </div>
    );
  }
  const refusal = isEngineRefusal(problem) ? problem.message : null;
  const canRetry = state === 'not-restarted' || (refusal === null && !problem?.added);
  const ways = state === 'not-restarted' && refusal !== null && onContinueAs ? others : NO_ACCOUNTS;
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div role="alert" className="flex flex-col gap-1">
        <p className="typography-ui-label text-foreground">{t(titleKey(state, problem))}</p>
        {refusal !== null ? <p className="typography-meta text-muted-foreground [overflow-wrap:anywhere]">{refusal}</p> : null}
        {state === 'not-restarted' && refusal === null ? (
          <p className="typography-meta text-muted-foreground">{t('mittr.accounts.switch.quitHint')}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {ways.map((account) => (
          <Button key={account.userId} size="sm" variant="outline" onClick={() => onContinueAs?.(account.userId)}>
            {t('mittr.signIn.continueAs', { name: accountName(account) })}
          </Button>
        ))}
        {canRetry ? <Button ref={firstActionRef} size="sm" onClick={onRetry}>{t('mittr.accounts.switch.retry')}</Button> : null}
        {state === 'failed' ? (
          <Button ref={canRetry ? undefined : firstActionRef} size="sm" variant="outline" onClick={onDismiss}>{t('mittr.accounts.switch.close')}</Button>
        ) : null}
      </div>
    </div>
  );
}

export type AccountSwitchDialogProps = AccountSwitchBinding & { api?: Pick<AccountsApi, 'fetchAccounts' | 'activateAccount'> };

export function AccountSwitchDialog({ accountSwitch, state, problem, api = accountsApi }: AccountSwitchDialogProps): React.ReactNode {
  const t = useMittrT();
  const firstActionRef = React.useRef<HTMLButtonElement>(null);
  const [others, setOthers] = React.useState(NO_ACCOUNTS);
  const offersWayBack = state === 'not-restarted' && isEngineRefusal(problem);

  React.useEffect(() => {
    if (state === 'not-restarted' || state === 'failed') firstActionRef.current?.focus();
  }, [state]);

  React.useEffect(() => {
    if (!offersWayBack) return undefined;
    let current = true;
    api.fetchAccounts().then(
      (accounts) => { if (current) setOthers(accounts.filter((account) => !account.active)); },
      () => {},
    );
    return () => {
      current = false;
      setOthers(NO_ACCOUNTS);
    };
  }, [api, offersWayBack]);

  return (
    <Dialog open={state !== 'idle'} onOpenChange={(open) => { if (!open) void accountSwitch.dismiss(); }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-sm"
        aria-label={state === 'idle' ? undefined : t(titleKey(state, problem))}
      >
        {state === 'idle' ? null : (
          <AccountSwitchStatus
            state={state}
            problem={problem}
            others={others}
            onRetry={() => { void accountSwitch.retry(); }}
            onDismiss={() => { void accountSwitch.dismiss(); }}
            onContinueAs={(userId) => { void accountSwitch.instead(() => api.activateAccount(userId)); }}
            firstActionRef={firstActionRef}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
