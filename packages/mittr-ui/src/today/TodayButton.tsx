import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/src/components/ui/tooltip';
import { FOOTER_BUTTON_CLASS } from '../accounts/footerButtonClass';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { useMittrT } from '../strings/mittrT';
import { useToday } from './todayStore';

export function TodayButton(): React.ReactNode {
  const t = useMittrT();
  const today = useToday();
  const label = t('mittr.today.open');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={FOOTER_BUTTON_CLASS} aria-label={label} aria-pressed={today.open} onClick={today.show}>
          <Icon name="home" className="h-4.5 w-4.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}><p>{label}</p></TooltipContent>
    </Tooltip>
  );
}

export function TodayFooterItem(): React.ReactNode {
  return (
    <MittrErrorBoundary fallback={null}>
      <TodayButton />
    </MittrErrorBoundary>
  );
}
