import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/src/components/ui/tooltip';
import { FOOTER_BUTTON_CLASS } from '../accounts/footerButtonClass';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { useMittrT } from '../strings/mittrT';
import { MyWorkDialog } from './MyWorkDialog';

export function MyWorkButton(): React.ReactNode {
  const t = useMittrT();
  const [open, setOpen] = React.useState(false);
  const label = t('mittr.work.open');
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className={FOOTER_BUTTON_CLASS} aria-label={label} onClick={() => setOpen(true)}>
            <Icon name="briefcase" className="h-4.5 w-4.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}><p>{label}</p></TooltipContent>
      </Tooltip>
      <MyWorkDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function MyWorkFooterItem(): React.ReactNode {
  return (
    <MittrErrorBoundary fallback={null}>
      <MyWorkButton />
    </MittrErrorBoundary>
  );
}
