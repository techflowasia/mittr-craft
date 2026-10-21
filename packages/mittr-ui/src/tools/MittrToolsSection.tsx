import React from 'react';

import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
} from '../../../ui/src/components/sections/shared/SettingsSection';
import { toast } from '../../../ui/src/components/ui';
import { Button } from '../../../ui/src/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/src/components/ui/select';
import { useI18n } from '../../../ui/src/lib/i18n';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { useMittrT } from '../strings/mittrT';
import { createToolsApi, type ChromeProfile, type MittrTools } from './toolsApi';
import {
  createToolsController,
  TOOLS_LOADING,
  type ProfilesLoad,
  type ToolsController,
  type ToolsLoad,
  type ToolsOutcome,
} from './toolsController';

export type ToolsActions = {
  retry: () => void;
  setComputer: (on: boolean) => void;
  setChrome: (on: boolean) => void;
  setProfile: (directory: string) => void;
  setHeaded: (on: boolean) => void;
  removeHost: (host: string) => void;
};

type ChromeProps = { chrome: MittrTools['chrome']; profiles: ProfilesLoad; actions: ToolsActions };

const ALERT_CLASS = 'rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-[var(--status-error)]';

function LoadFailure({ text, onRetry }: { text: string; onRetry: () => void }): React.ReactNode {
  const t = useMittrT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className={ALERT_CLASS}>{text}</p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t('mittr.tools.actions.retry')}</Button>
    </div>
  );
}

const nameOf = (list: readonly ChromeProfile[], directory: string | undefined): string | null =>
  list.find((profile) => profile.directory === directory)?.name ?? null;

function ProfileRow({ chrome, profiles, actions }: ChromeProps): React.ReactNode {
  const { t } = useI18n();
  const mt = useMittrT();
  const label = mt('mittr.tools.chrome.profile');
  const body = (): React.ReactNode => {
    if (profiles.status === 'error') return <LoadFailure text={profiles.error} onRetry={actions.retry} />;
    if (profiles.status !== 'ready') return <span className={SETTINGS_HELPER_CLASS}>{t('common.loading')}</span>;
    if (profiles.list.length === 0) return <span className={SETTINGS_HELPER_CLASS}>{mt('mittr.tools.chrome.noProfiles')}</span>;
    const listed = nameOf(profiles.list, chrome.profile ?? undefined) !== null;
    return (
      <Select value={listed && chrome.profile ? chrome.profile : undefined} onValueChange={actions.setProfile}>
        <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
          <SelectValue>{(value) => nameOf(profiles.list, value) ?? mt('mittr.tools.chrome.profilePlaceholder')}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {profiles.list.map((profile) => (
            <SelectItem key={profile.directory} value={profile.directory}>{profile.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };
  return (
    <SettingsFieldRow label={label} description={mt('mittr.tools.chrome.profileCopy')}>
      {body()}
    </SettingsFieldRow>
  );
}

function SitesRow({ chrome, actions }: Omit<ChromeProps, 'profiles'>): React.ReactNode {
  const t = useMittrT();
  return (
    <SettingsFieldRow label={t('mittr.tools.chrome.sites')} description={t('mittr.tools.chrome.sitesScope')}>
      {chrome.approvedHosts.length === 0 ? (
        <span className={SETTINGS_HELPER_CLASS}>{t('mittr.tools.chrome.sitesEmpty')}</span>
      ) : (
        <ul className="w-full space-y-1">
          {chrome.approvedHosts.map((host) => (
            <li key={host} className="flex min-w-0 items-center justify-between gap-2">
              <span className="typography-meta min-w-0 [overflow-wrap:anywhere]">{host}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => actions.removeHost(host)}
                aria-label={t('mittr.tools.chrome.siteRemove', { host })}
              >
                {t('mittr.tools.chrome.siteRemoveShort')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsFieldRow>
  );
}

function ChromeTool({ chrome, profiles, actions }: ChromeProps): React.ReactNode {
  const t = useMittrT();
  if (!chrome.chromeInstalled) return <p className={SETTINGS_HELPER_CLASS}>{t('mittr.tools.chrome.notInstalled')}</p>;
  return (
    <>
      <SettingsCheckboxRow
        checked={chrome.enabled}
        onChange={actions.setChrome}
        label={t('mittr.tools.chrome.label')}
        ariaLabel={t('mittr.tools.chrome.aria')}
        info={t('mittr.tools.chrome.info')}
        description={t('mittr.tools.chrome.taskNote')}
      />
      {chrome.enabled ? (
        <>
          <ProfileRow chrome={chrome} profiles={profiles} actions={actions} />
          <SettingsCheckboxRow
            checked={chrome.headed}
            onChange={actions.setHeaded}
            label={t('mittr.tools.chrome.headed')}
            ariaLabel={t('mittr.tools.chrome.headed')}
          />
          <SitesRow chrome={chrome} actions={actions} />
        </>
      ) : null}
    </>
  );
}

type MittrToolsSectionViewProps = { state: ToolsLoad; profiles: ProfilesLoad; actions: ToolsActions };

export function MittrToolsSectionView({ state, profiles, actions }: MittrToolsSectionViewProps): React.ReactNode {
  const t = useMittrT();
  if (state.status === 'loading') return null;
  if (state.status === 'ready' && !state.tools.computer.offered && !state.tools.chrome.offered) return null;
  return (
    <SettingsSection title={t('mittr.tools.title')} info={t('mittr.tools.info')}>
      {state.status === 'error' ? (
        <LoadFailure text={state.error} onRetry={actions.retry} />
      ) : !state.tools.canChange ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('mittr.tools.changeOnThisMac')}</p>
      ) : (
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          {state.tools.computer.offered ? (
            <SettingsCheckboxRow
              checked={state.tools.computer.enabled}
              onChange={actions.setComputer}
              label={t('mittr.tools.computer.label')}
              ariaLabel={t('mittr.tools.computer.aria')}
              info={t('mittr.tools.computer.info')}
            />
          ) : null}
          {state.tools.chrome.offered ? <ChromeTool chrome={state.tools.chrome} profiles={profiles} actions={actions} /> : null}
        </div>
      )}
    </SettingsSection>
  );
}

const subscribeNothing = (): (() => void) => () => {};

const showOutcome = (outcome: ToolsOutcome): void => {
  if (outcome) toast.error(outcome.text);
};

const NO_ACTIONS: ToolsActions = {
  retry: () => {},
  setComputer: () => {},
  setChrome: () => {},
  setProfile: () => {},
  setHeaded: () => {},
  removeHost: () => {},
};

const actionsOf = (controller: ToolsController): ToolsActions => ({
  retry: () => { void controller.load(); },
  setComputer: (on) => { void controller.setComputer(on).then(showOutcome); },
  setChrome: (on) => { void controller.setChrome(on).then(showOutcome); },
  setProfile: (directory) => { void controller.setProfile(directory).then(showOutcome); },
  setHeaded: (on) => { void controller.setHeaded(on).then(showOutcome); },
  removeHost: (host) => { void controller.removeHost(host).then(showOutcome); },
});

function useToolsController(): ToolsController | null {
  const [controller, setController] = React.useState<ToolsController | null>(null);
  React.useEffect(() => {
    const created = createToolsController({ api: createToolsApi() });
    setController(created);
    void created.load();
    return () => created.dispose();
  }, []);
  return controller;
}

export function MittrToolsSection(): React.ReactNode {
  const controller = useToolsController();
  const read = React.useCallback(() => controller?.state() ?? TOOLS_LOADING, [controller]);
  const state = React.useSyncExternalStore(controller ? controller.subscribe : subscribeNothing, read, read);
  const actions = React.useMemo(() => (controller ? actionsOf(controller) : NO_ACTIONS), [controller]);
  return <MittrToolsSectionView state={state.tools} profiles={state.profiles} actions={actions} />;
}

export function MittrToolsSettingsItem(): React.ReactNode {
  return (
    <MittrErrorBoundary fallback={null}>
      <MittrToolsSection />
    </MittrErrorBoundary>
  );
}
