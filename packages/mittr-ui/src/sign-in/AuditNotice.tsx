import React from 'react';

import { useMittrT } from '../strings/mittrT';

// Shown before first use, not in a settings page somebody may never open.
// Both halves matter: without the second, the notice reads as though
// everything is captured.
export function AuditNotice({ className = '' }: { className?: string }): React.ReactNode {
  const t = useMittrT();
  return (
    <p role="note" className={`typography-micro text-muted-foreground ${className}`.trim()}>
      {t('mittr.audit.notice')}
    </p>
  );
}
