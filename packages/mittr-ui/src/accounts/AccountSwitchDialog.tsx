import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Button } from '../../../ui/src/components/ui/button';
import { Dialog, DialogContent } from '../../../ui/src/components/ui/dialog';
import { useMittrT } from '../strings/mittrT';
import type { AccountSwitchState } from './accountSwitch';

export type AccountSwitchStatusProps = {
  state: Exclude<AccountSwitchState, 'idle'>;
  onRetry: () => void;
  onDismiss: () => void;
};

export function AccountSwitchStatus({ state, onRetry, onDismiss }: AccountSwitchStatusProps): React.ReactNode {
  const t = useMittrT();
  if (state === 'switching') {
    return (
      <div role="status" className="flex items-center justify-center gap-2 typography-ui-label text-muted-foreground">
        <Icon name="loader" className="size-4 animate-spin" />
        <span>{t('mittr.accounts.switch.waiting')}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <p role="alert" className="typography-ui-label text-foreground">
        {t(state === 'failed' ? 'mittr.accounts.switch.failed' : 'mittr.accounts.switch.notRestarted')}
      </p>
      <div className="flex items-center justify-center gap-2">
        <Button size="sm" onClick={onRetry}>{t('mittr.accounts.switch.retry')}</Button>
        {state === 'failed' ? (
          <Button size="sm" variant="outline" onClick={onDismiss}>{t('mittr.accounts.switch.close')}</Button>
        ) : null}
      </div>
    </div>
  );
}

export type AccountSwitchDialogProps = Omit<AccountSwitchStatusProps, 'state'> & { state: AccountSwitchState };

export function AccountSwitchDialog({ state, onRetry, onDismiss }: AccountSwitchDialogProps): React.ReactNode {
  const t = useMittrT();
  return (
    <Dialog open={state !== 'idle'} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent showCloseButton={false} className="max-w-xs" aria-label={t('mittr.accounts.menu.label')}>
        {state === 'idle' ? null : <AccountSwitchStatus state={state} onRetry={onRetry} onDismiss={onDismiss} />}
      </DialogContent>
    </Dialog>
  );
}
