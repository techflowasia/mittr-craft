import React from 'react';

import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
} from '../../../ui/src/components/sections/shared/SettingsSection';
import { toast } from '../../../ui/src/components/ui';
import { Button } from '../../../ui/src/components/ui/button';
import { NumberInput } from '../../../ui/src/components/ui/number-input';
import { cn } from '../../../ui/src/lib/utils';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { useMittrT, type MittrKey } from '../strings/mittrT';
import { browserPlayer, voiceFetch } from './MittrVoiceRoot';
import { createUpstreamSpeech, mittrDictationOn, mittrReadAloudOn } from './upstreamSpeech';
import { createVoiceApi, type VoiceReadinessReason } from './voiceApi';
import {
  createVoiceSettingsController,
  VOICE_SETTINGS_LOADING,
  type VoiceSettingsController,
  type VoiceSettingsControllerState,
  type VoiceSettingsOutcome,
} from './voiceSettingsController';
import { createVoiceSettingsApi, REPLY_MAX_CHARS_RANGE, STEP_CAP_RANGE } from './voiceSettingsApi';

export type VoiceSettingsActions = {
  retry: () => void;
  setDictation: (on: boolean) => void;
  setReadAloud: (on: boolean) => void;
  setStepCap: (value: number) => void;
  setReplyMaxChars: (value: number) => void;
  preview: () => void;
};

const ALERT_CLASS = 'rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error)]';

const REASON_KEY = {
  not_signed_in: 'mittr.voice.settings.mittr.reason.not_signed_in',
  not_configured: 'mittr.voice.settings.mittr.reason.not_configured',
  unreachable: 'mittr.voice.settings.mittr.reason.unreachable',
} satisfies Record<VoiceReadinessReason, MittrKey>;

function LoadFailure({ text, onRetry }: { text: string; onRetry: () => void }): React.ReactNode {
  const t = useMittrT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className={ALERT_CLASS}>{text}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('mittr.voice.settings.actions.retry')}</Button>
    </div>
  );
}

type LimitsProps = {
  stepCap: number;
  replyMaxChars: number;
  canChange: boolean;
  actions: VoiceSettingsActions;
};

function LimitsRows({ stepCap, replyMaxChars, canChange, actions }: LimitsProps): React.ReactNode {
  const t = useMittrT();
  const stepLabel = t('mittr.voice.settings.assistant.stepCap');
  const replyLabel = t('mittr.voice.settings.assistant.replyMaxChars');
  return (
    <div className={SETTINGS_FIELDS_STACK_CLASS}>
      <SettingsFieldRow label={stepLabel} info={t('mittr.voice.settings.assistant.stepCapHint')}>
        {canChange ? (
          <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
            <NumberInput
              value={stepCap}
              onValueChange={actions.setStepCap}
              min={STEP_CAP_RANGE.min}
              max={STEP_CAP_RANGE.max}
              step={STEP_CAP_RANGE.step}
              aria-label={stepLabel}
              className="w-16 tabular-nums"
            />
          </div>
        ) : (
          <span className={SETTINGS_HELPER_CLASS}>{stepCap}</span>
        )}
      </SettingsFieldRow>
      <SettingsFieldRow label={replyLabel}>
        {canChange ? (
          <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
            <NumberInput
              value={replyMaxChars}
              onValueChange={actions.setReplyMaxChars}
              min={REPLY_MAX_CHARS_RANGE.min}
              max={REPLY_MAX_CHARS_RANGE.max}
              step={REPLY_MAX_CHARS_RANGE.step}
              aria-label={replyLabel}
              className="w-20 tabular-nums"
            />
          </div>
        ) : (
          <span className={SETTINGS_HELPER_CLASS}>{replyMaxChars}</span>
        )}
      </SettingsFieldRow>
    </div>
  );
}

type MittrVoiceSectionViewProps = {
  state: VoiceSettingsControllerState;
  dictationOn: boolean;
  readAloudOn: boolean;
  actions: VoiceSettingsActions;
};

export function MittrVoiceSectionView({ state, dictationOn, readAloudOn, actions }: MittrVoiceSectionViewProps): React.ReactNode {
  const t = useMittrT();
  const { load, previewing } = state;
  if (load.status === 'loading') return null;
  if (load.status === 'ready' && (!load.offer.offered || !load.limits)) return null;
  const body = (): React.ReactNode => {
    if (load.status === 'error') return <LoadFailure text={load.error} onRetry={actions.retry} />;
    const { limits, readiness } = load;
    if (!limits) return null;
    if (!limits.canChange) {
      return (
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <p className={SETTINGS_HELPER_CLASS}>{t('mittr.voice.settings.changeOnThisMac')}</p>
          <LimitsRows stepCap={limits.stepCap} replyMaxChars={limits.replyMaxChars} canChange={false} actions={actions} />
        </div>
      );
    }
    return (
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <p className={SETTINGS_HELPER_CLASS}>{t('mittr.voice.settings.mittr.description')}</p>
          <SettingsCheckboxRow
            checked={dictationOn}
            onChange={actions.setDictation}
            label={t('mittr.voice.settings.dictation.label')}
            ariaLabel={t('mittr.voice.settings.dictation.label')}
          />
          <SettingsCheckboxRow
            checked={readAloudOn}
            onChange={actions.setReadAloud}
            label={t('mittr.voice.settings.readAloud.label')}
            ariaLabel={t('mittr.voice.settings.readAloud.label')}
          />
          {readiness?.reason ? (
            <p role="status" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-warning)]')}>{t(REASON_KEY[readiness.reason])}</p>
          ) : null}
          <p className={SETTINGS_HELPER_CLASS}>{t('mittr.voice.settings.keyNote')}</p>
          {readiness?.speak ? (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={actions.preview}>
                {previewing ? t('mittr.voice.settings.previewStop') : t('mittr.voice.settings.preview')}
              </Button>
            </div>
          ) : null}
        </div>
        <LimitsRows stepCap={limits.stepCap} replyMaxChars={limits.replyMaxChars} canChange actions={actions} />
      </div>
    );
  };
  return (
    <SettingsSection title={t('mittr.voice.title')} info={t('mittr.voice.info')}>
      {body()}
    </SettingsSection>
  );
}

const subscribeNothing = (): (() => void) => () => {};

const showOutcome = (outcome: VoiceSettingsOutcome): void => {
  if (outcome) toast.error(outcome.text);
};

const NO_ACTIONS: VoiceSettingsActions = {
  retry: () => {},
  setDictation: () => {},
  setReadAloud: () => {},
  setStepCap: () => {},
  setReplyMaxChars: () => {},
  preview: () => {},
};

const actionsOf = (controller: VoiceSettingsController): VoiceSettingsActions => ({
  retry: () => { void controller.load(); },
  setDictation: (on) => { void controller.setDictation(on).then(showOutcome); },
  setReadAloud: (on) => { void controller.setReadAloud(on).then(showOutcome); },
  setStepCap: (value) => { void controller.setStepCap(value).then(showOutcome); },
  setReplyMaxChars: (value) => { void controller.setReplyMaxChars(value).then(showOutcome); },
  preview: () => { void controller.preview().then(showOutcome); },
});

function browserController(): VoiceSettingsController {
  const voice = createVoiceApi(voiceFetch);
  return createVoiceSettingsController({
    api: createVoiceSettingsApi(),
    speech: createUpstreamSpeech({ config: () => useConfigStore.getState(), fetch: voiceFetch }),
    readiness: () => voice.readiness(),
    synthesize: voice.synthesize,
    createPlayer: browserPlayer,
  });
}

function useVoiceSettingsController(): VoiceSettingsController | null {
  const [controller, setController] = React.useState<VoiceSettingsController | null>(null);
  React.useEffect(() => {
    const created = browserController();
    setController(created);
    void created.load();
    return () => created.dispose();
  }, []);
  return controller;
}

export function MittrVoiceSection(): React.ReactNode {
  const controller = useVoiceSettingsController();
  const read = React.useCallback(() => controller?.state() ?? VOICE_SETTINGS_LOADING, [controller]);
  const state = React.useSyncExternalStore(controller ? controller.subscribe : subscribeNothing, read, read);
  const actions = React.useMemo(() => (controller ? actionsOf(controller) : NO_ACTIONS), [controller]);
  const dictationOn = useConfigStore((config) => mittrDictationOn(config));
  const readAloudOn = useConfigStore((config) => mittrReadAloudOn(config));
  return <MittrVoiceSectionView state={state} dictationOn={dictationOn} readAloudOn={readAloudOn} actions={actions} />;
}

export function MittrVoiceSettingsItem(): React.ReactNode {
  return (
    <MittrErrorBoundary fallback={null}>
      <MittrVoiceSection />
    </MittrErrorBoundary>
  );
}
