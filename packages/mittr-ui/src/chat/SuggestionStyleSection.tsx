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
import { createSuggestionStyleApi, type SuggestionStyle } from './suggestionStyleApi';
import {
  createSuggestionStyleController,
  SUGGESTION_STYLE_LOADING,
  type SuggestionStyleController,
  type SuggestionStyleState,
} from './suggestionStyleController';

const ALERT_CLASS = 'rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error)]';

const OPTIONS: ReadonlyArray<{ style: SuggestionStyle; label: MittrKey }> = [
  { style: 'next-step', label: 'mittr.chat.suggestions.nextStep' },
  { style: 'unfinished-only', label: 'mittr.chat.suggestions.unfinishedOnly' },
];

type SuggestionStyleSectionViewProps = {
  state: SuggestionStyleState;
  onChoose: (style: SuggestionStyle) => void;
  onRetry: () => void;
};

export function SuggestionStyleSectionView({ state, onChoose, onRetry }: SuggestionStyleSectionViewProps): React.ReactNode {
  const t = useMittrT();
  if (state.status === 'loading') return null;
  const body = (): React.ReactNode => {
    if (state.status === 'error') {
      return (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className={ALERT_CLASS}>{state.error}</p>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('mittr.chat.suggestions.retry')}</Button>
        </div>
      );
    }
    const locked = !state.canChange || state.saving;
    return (
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        {state.canChange ? null : <p className={SETTINGS_HELPER_CLASS}>{t('mittr.chat.suggestions.changeOnThisMac')}</p>}
        <SettingsRadioGroup aria-label={t('mittr.chat.suggestions.label')}>
          {OPTIONS.map(({ style, label }) => (
            <SettingsRadioOption
              key={style}
              selected={state.suggestionStyle === style}
              onSelect={() => onChoose(style)}
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
    <SettingsSection title={t('mittr.chat.suggestions.title')} info={t('mittr.chat.suggestions.info')}>
      {body()}
    </SettingsSection>
  );
}

const subscribeNothing = (): (() => void) => () => {};

function useSuggestionStyleController(): SuggestionStyleController | null {
  const [controller, setController] = React.useState<SuggestionStyleController | null>(null);
  React.useEffect(() => {
    const created = createSuggestionStyleController({ api: createSuggestionStyleApi() });
    setController(created);
    void created.load();
    return () => created.dispose();
  }, []);
  return controller;
}

export function SuggestionStyleSection(): React.ReactNode {
  const controller = useSuggestionStyleController();
  const read = React.useCallback(() => controller?.state() ?? SUGGESTION_STYLE_LOADING, [controller]);
  const state = React.useSyncExternalStore(controller ? controller.subscribe : subscribeNothing, read, read);
  const onChoose = React.useCallback((style: SuggestionStyle) => {
    void controller?.choose(style).then((error) => {
      if (error) toast.error(error);
    });
  }, [controller]);
  const onRetry = React.useCallback(() => { void controller?.load(); }, [controller]);
  return <SuggestionStyleSectionView state={state} onChoose={onChoose} onRetry={onRetry} />;
}

export function SuggestionStyleSettingsItem(): React.ReactNode {
  return (
    <MittrErrorBoundary fallback={null}>
      <SuggestionStyleSection />
    </MittrErrorBoundary>
  );
}
