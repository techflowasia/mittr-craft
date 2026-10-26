import React from 'react';

import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
} from '../../../ui/src/components/sections/shared/SettingsSection';
import { toast } from '../../../ui/src/components/ui';
import { Button } from '../../../ui/src/components/ui/button';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { useMittrT, type MittrKey } from '../strings/mittrT';
import type { SidebarSide } from './sidebarSideApi';
import { SIDEBAR_SIDE_SOURCE } from './sidebarSideSource';
import type { SidebarSideState } from './sidebarSideStore';

const ALERT_CLASS = 'rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error)]';

const OPTIONS: ReadonlyArray<{ side: SidebarSide; label: MittrKey }> = [
  { side: 'left', label: 'mittr.sidebarSide.left' },
  { side: 'right', label: 'mittr.sidebarSide.right' },
];

type SidebarSideSectionViewProps = {
  state: SidebarSideState;
  onChoose: (side: SidebarSide) => void;
  onRetry: () => void;
};

export function SidebarSideSectionView({ state, onChoose, onRetry }: SidebarSideSectionViewProps): React.ReactNode {
  const t = useMittrT();
  if (state.status === 'loading') return null;
  const body = (): React.ReactNode => {
    if (state.status === 'error') {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={ALERT_CLASS}>{state.error}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('mittr.sidebarSide.retry')}</Button>
        </div>
      );
    }
    const locked = !state.canChange || state.saving;
    return (
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        {state.canChange ? null : <p className={SETTINGS_HELPER_CLASS}>{t('mittr.sidebarSide.changeOnThisMac')}</p>}
        <SettingsRadioGroup aria-label={t('mittr.sidebarSide.title')}>
          {OPTIONS.map(({ side, label }) => (
            <SettingsRadioOption
              key={side}
              selected={state.sidebarSide === side}
              onSelect={() => onChoose(side)}
              label={t(label)}
              ariaLabel={t(label)}
              disabled={locked}
            />
          ))}
        </SettingsRadioGroup>
      </div>
    );
  };
  return (
    <SettingsSection title={t('mittr.sidebarSide.title')} info={t('mittr.sidebarSide.info')}>
      {body()}
    </SettingsSection>
  );
}

export function SidebarSideSection(): React.ReactNode {
  const store = SIDEBAR_SIDE_SOURCE;
  const state = React.useSyncExternalStore(store.subscribe, store.state, store.state);
  const onChoose = React.useCallback((side: SidebarSide) => {
    void store.choose(side).then((error) => {
      if (error) toast.error(error);
    });
  }, [store]);
  const onRetry = React.useCallback(() => { void store.load(); }, [store]);
  return <SidebarSideSectionView state={state} onChoose={onChoose} onRetry={onRetry} />;
}

export function SidebarSideSettingsItem(): React.ReactNode {
  return (
    <MittrErrorBoundary fallback={null}>
      <SidebarSideSection />
    </MittrErrorBoundary>
  );
}
