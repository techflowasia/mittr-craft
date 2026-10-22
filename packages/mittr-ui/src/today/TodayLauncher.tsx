import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { toast } from '../../../ui/src/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../../ui/src/components/ui/dropdown-menu';
import { useI18n } from '../../../ui/src/lib/i18n';
import { formatDirectoryName } from '../../../ui/src/lib/utils';
import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useInputStore } from '../../../ui/src/sync/input-store';
import * as sessionActions from '../../../ui/src/sync/session-actions';
import { useSessionUIStore } from '../../../ui/src/sync/session-ui-store';
import { useQuotaMe } from '../quota/quotaMeStore';
import { mittrT, useMittrT } from '../strings/mittrT';
import { mittrAvailable, mittrCatalogAliases, type GoWorkProject } from '../work/goWork';
import { captureSendSelection } from '../work/sendSelection';
import { planLaunch, runLaunch, type LaunchDeps } from './todayLaunch';

const projectName = (project: GoWorkProject): string => project.label?.trim() || formatDirectoryName(project.path);

type TodayLauncherViewProps = {
  projects: readonly GoWorkProject[];
  project: GoWorkProject | null;
  onProject: (project: GoWorkProject) => void;
  onLaunch: (text: string) => void;
};

export function TodayLauncherView({ projects, project, onProject, onLaunch }: TodayLauncherViewProps): React.ReactNode {
  const t = useMittrT();
  const [text, setText] = React.useState('');
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    onLaunch(trimmed);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return (
    <form
      className="mittr-today-launcher mittr-glass-panel mittr-glass-pill"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="mittr-today-project" aria-label={t('mittr.today.launcher.project')}>
            <Icon name="folder" className="size-4 shrink-0" aria-hidden="true" />
            <span className="mittr-today-project-name">{project ? projectName(project) : t('mittr.today.launcher.noProjects')}</span>
            <Icon name="arrow-down-s" className="size-4 shrink-0" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t('mittr.today.launcher.project')}</DropdownMenuLabel>
          {projects.length === 0 ? (
            <DropdownMenuItem disabled>{t('mittr.today.launcher.noProjects')}</DropdownMenuItem>
          ) : projects.map((entry) => (
            <DropdownMenuItem key={entry.id} onClick={() => onProject(entry)}>
              <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 truncate" title={entry.path}>{projectName(entry)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <textarea
        className="mittr-today-input"
        rows={1}
        value={text}
        aria-label={t('mittr.today.launcher.label')}
        placeholder={t('mittr.today.launcher.placeholder')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="mittr-today-send" aria-label={t('mittr.today.launcher.send')} disabled={!text.trim()}>
        <Icon name="send-plane-2" className="size-4" aria-hidden="true" />
      </button>
    </form>
  );
}

const sessionLaunchDeps = (hide: () => void): LaunchDeps => ({
  createSession: (directory, selection) => sessionActions.createSession(
    undefined,
    directory,
    undefined,
    undefined,
    { model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant }, agent: selection.agentName },
    'open',
  ),
  initialize: (sessionId) => {
    useSessionUIStore.getState().initializeNewOpenChamberSession(sessionId, useConfigStore.getState().agents);
  },
  sendMessage: (text, selection, sessionId, directory) => useSessionUIStore.getState().sendMessage(
    text,
    selection.providerID,
    selection.modelID,
    selection.agentName,
    undefined,
    undefined,
    undefined,
    selection.variant,
    undefined,
    { sessionId, directory },
  ),
  openDraft: (text, project) => {
    useSessionUIStore.getState().openNewSessionDraft(project
      ? { initialPrompt: text, selectedProjectId: project.id, directoryOverride: project.path, target: 'project' }
      : { initialPrompt: text });
  },
  keepText: (text) => { useInputStore.getState().setPendingInputText(text); },
  hide,
  refuse: (message) => { toast.error(message); },
  fail: (message, description) => { toast.error(message, description ? { description } : undefined); },
});

type TodayLauncherProps = {
  projects: readonly GoWorkProject[];
  project: GoWorkProject | null;
  onProject: (project: GoWorkProject) => void;
  hide: () => void;
};

export function TodayLauncher({ projects, project, onProject, hide }: TodayLauncherProps): React.ReactNode {
  const { t } = useI18n();
  const quota = useQuotaMe(true);
  const agentStatus = quota.status === 'ok' ? quota.quota.agentStatus : null;
  const launch = (text: string) => {
    const selection = captureSendSelection();
    const available = mittrAvailable(selection, mittrCatalogAliases(useConfigStore.getState().providers), agentStatus);
    void runLaunch(planLaunch({ text, project, selection, available }), sessionLaunchDeps(hide), {
      'no-project': mittrT('mittr.today.launcher.noProject'),
      'no-model': t('chat.chatInput.toast.noModelSelected'),
      'no-mittr-model': mittrT('mittr.work.error.noMittrModel'),
      failed: t('chat.chatInput.toast.messageSendFailed'),
    });
  };
  return <TodayLauncherView projects={projects} project={project} onProject={onProject} onLaunch={launch} />;
}
