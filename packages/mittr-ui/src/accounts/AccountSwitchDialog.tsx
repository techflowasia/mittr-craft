import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Button } from '../../../ui/src/components/ui/button';
import { Dialog, DialogContent } from '../../../ui/src/components/ui/dialog';
import type { MittrKey } from '../strings/mittrT';
import { useMittrT } from '../strings/mittrT';
import type { AccountSwitchState } from './accountSwitch';

type ShownState = Exclude<AccountSwitchState, 'idle'>;

const STATE_TEXT = {
  switching: 'mittr.accounts.switch.waiting',
  'not-restarted': 'mittr.accounts.switch.notRestarted',
  failed: 'mittr.accounts.switch.failed',
} satisfies Record<ShownState, MittrKey>;

export type AccountSwitchStatusProps = {
  state: ShownState;
  onRetry: () => void;
  onDismiss: () => void;
  retryRef?: React.Ref<HTMLButtonElement>;
};

export function AccountSwitchStatus({ state, onRetry, onDismiss, retryRef }: AccountSwitchStatusProps): React.ReactNode {
  const t = useMittrT();
  if (state === 'switching') {
    return (
      <div role="status" className="flex items-center justify-center gap-2 typography-ui-label text-muted-foreground">
        <Icon name="loader" className="size-4 animate-spin" />
        <span>{t(STATE_TEXT.switching)}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex flex-col gap-1">
        <p role="alert" className="typography-ui-label text-foreground">{t(STATE_TEXT[state])}</p>
        {state === 'not-restarted' ? (
          <p className="typography-meta text-muted-foreground">{t('mittr.accounts.switch.quitHint')}</p>
        ) : null}
      </div>
      <div className="flex items-center justify-center gap-2">
        <Button ref={retryRef} size="sm" onClick={onRetry}>{t('mittr.accounts.switch.retry')}</Button>
        {state === 'failed' ? (
          <Button size="sm" variant="outline" onClick={onDismiss}>{t('mittr.accounts.switch.close')}</Button>
        ) : null}
      </div>
    </div>
  );
}

export type AccountSwitchDialogProps = Omit<AccountSwitchStatusProps, 'state' | 'retryRef'> & { state: AccountSwitchState };

export function AccountSwitchDialog({ state, onRetry, onDismiss }: AccountSwitchDialogProps): React.ReactNode {
  const t = useMittrT();
  const retryRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (state === 'not-restarted' || state === 'failed') retryRef.current?.focus();
  }, [state]);

  return (
    <Dialog open={state !== 'idle'} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-xs"
        aria-label={state === 'idle' ? undefined : t(STATE_TEXT[state])}
      >
        {state === 'idle' ? null : <AccountSwitchStatus state={state} onRetry={onRetry} onDismiss={onDismiss} retryRef={retryRef} />}
      </DialogContent>
    </Dialog>
  );
}
