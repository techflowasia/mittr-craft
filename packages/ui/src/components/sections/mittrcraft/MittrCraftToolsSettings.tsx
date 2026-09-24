import * as React from 'react';

import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SETTINGS_HELPER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fetchChromeProfiles, removeChromeApprovedHost, type ChromeProfile } from '@/lib/chromeProfilesApi';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/**
 * Which MittrCraft capabilities agents are given.
 *
 * Each entry is one tool the managed OpenCode child is handed, so the choices
 * belong together and not under the CLI's own configuration — the binary path
 * is about which OpenCode runs, these are about what it can do.
 *
 * A toggle is written immediately but only reaches agents once OpenCode
 * restarts, so each one records a pending restart rather than implying the
 * change is already live.
 */
export const MittrCraftToolsSettings: React.FC = () => {
  const { t } = useI18n();
  const agentControlToolEnabled = useUIStore((state) => state.agentControlToolEnabled);
  const setAgentControlToolEnabled = useUIStore((state) => state.setAgentControlToolEnabled);
  const agentWebToolEnabled = useUIStore((state) => state.agentWebToolEnabled);
  const setAgentWebToolEnabled = useUIStore((state) => state.setAgentWebToolEnabled);
  const agentComputerToolEnabled = useUIStore((state) => state.agentComputerToolEnabled);
  const setAgentComputerToolEnabled = useUIStore((state) => state.setAgentComputerToolEnabled);
  const agentChromeToolEnabled = useUIStore((state) => state.agentChromeToolEnabled);
  const setAgentChromeToolEnabled = useUIStore((state) => state.setAgentChromeToolEnabled);
  const agentChromeProfile = useUIStore((state) => state.agentChromeProfile);
  const setAgentChromeProfile = useUIStore((state) => state.setAgentChromeProfile);
  const agentChromeApprovedHosts = useUIStore((state) => state.agentChromeApprovedHosts);
  const setAgentChromeApprovedHosts = useUIStore((state) => state.setAgentChromeApprovedHosts);
  const agentChromeHeaded = useUIStore((state) => state.agentChromeHeaded);
  const setAgentChromeHeaded = useUIStore((state) => state.setAgentChromeHeaded);
  const [profiles, setProfiles] = React.useState<ChromeProfile[]>([]);

  React.useEffect(() => {
    if (!agentChromeToolEnabled) return;
    let cancelled = false;
    void fetchChromeProfiles().then((list) => {
      if (!cancelled) setProfiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, [agentChromeToolEnabled]);

  const handleAgentControlToolChange = React.useCallback((enabled: boolean) => {
    setAgentControlToolEnabled(enabled);
    void updateDesktopSettings({ agentControlToolEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-control-tool' });
  }, [setAgentControlToolEnabled]);

  const handleAgentWebToolChange = React.useCallback((enabled: boolean) => {
    setAgentWebToolEnabled(enabled);
    void updateDesktopSettings({ agentWebToolEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-web-tool' });
  }, [setAgentWebToolEnabled]);

  const handleAgentComputerToolChange = React.useCallback((enabled: boolean) => {
    setAgentComputerToolEnabled(enabled);
    void updateDesktopSettings({ agentComputerToolEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-computer-tool' });
  }, [setAgentComputerToolEnabled]);

  const handleAgentChromeToolChange = React.useCallback((enabled: boolean) => {
    setAgentChromeToolEnabled(enabled);
    void updateDesktopSettings({ agentChromeToolEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-chrome-tool' });
  }, [setAgentChromeToolEnabled]);

  const handleChromeProfileChange = React.useCallback((directory: string) => {
    setAgentChromeProfile(directory);
    void updateDesktopSettings({ agentChromeProfile: directory });
  }, [setAgentChromeProfile]);

  const handleChromeHeadedChange = React.useCallback((headed: boolean) => {
    setAgentChromeHeaded(headed);
    void updateDesktopSettings({ agentChromeHeaded: headed });
  }, [setAgentChromeHeaded]);

  const handleRemoveChromeHost = React.useCallback((host: string) => {
    void removeChromeApprovedHost(host).then((hosts) => {
      if (hosts) setAgentChromeApprovedHosts(hosts);
    });
  }, [setAgentChromeApprovedHosts]);

  return (
    <SettingsSection title={t('settings.mittrcraft.tools.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          settingsItem="sessions.agent-control-tool"
          checked={agentControlToolEnabled}
          onChange={handleAgentControlToolChange}
          label={t('settings.mittrcraft.tools.field.agentControlTool')}
          ariaLabel={t('settings.mittrcraft.tools.field.agentControlToolAria')}
          info={t('settings.mittrcraft.tools.field.agentControlToolInfo')}
        />

        <SettingsCheckboxRow
          settingsItem="sessions.agent-web-tool"
          checked={agentWebToolEnabled}
          onChange={handleAgentWebToolChange}
          label={t('settings.mittrcraft.tools.field.agentWebTool')}
          ariaLabel={t('settings.mittrcraft.tools.field.agentWebToolAria')}
          info={t('settings.mittrcraft.tools.field.agentWebToolInfo')}
        />

        <SettingsCheckboxRow
          settingsItem="sessions.agent-computer-tool"
          checked={agentComputerToolEnabled}
          onChange={handleAgentComputerToolChange}
          label={t('settings.mittrcraft.tools.field.agentComputerTool')}
          ariaLabel={t('settings.mittrcraft.tools.field.agentComputerToolAria')}
          info={t('settings.mittrcraft.tools.field.agentComputerToolInfo')}
        />

        <SettingsCheckboxRow
          settingsItem="sessions.agent-chrome-tool"
          checked={agentChromeToolEnabled}
          onChange={handleAgentChromeToolChange}
          label={t('settings.mittrcraft.tools.field.agentChromeTool')}
          ariaLabel={t('settings.mittrcraft.tools.field.agentChromeToolAria')}
          info={t('settings.mittrcraft.tools.field.agentChromeToolInfo')}
        />
        {agentChromeToolEnabled && (
          <>
            <SettingsFieldRow settingsItem="sessions.agent-chrome-profile" label={t('settings.mittrcraft.tools.field.agentChromeProfile')}>
              <Select value={agentChromeProfile || undefined} onValueChange={handleChromeProfileChange}>
                <SelectTrigger
                  size={SETTINGS_SELECT_SIZE}
                  className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                  aria-label={t('settings.mittrcraft.tools.field.agentChromeProfile')}
                >
                  <SelectValue placeholder={t('settings.mittrcraft.tools.field.agentChromeProfilePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.directory} value={profile.directory}>{profile.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsFieldRow>
            <SettingsCheckboxRow
              settingsItem="sessions.agent-chrome-headed"
              checked={agentChromeHeaded}
              onChange={handleChromeHeadedChange}
              label={t('settings.mittrcraft.tools.field.agentChromeHeaded')}
              ariaLabel={t('settings.mittrcraft.tools.field.agentChromeHeaded')}
            />
            <SettingsFieldRow settingsItem="sessions.agent-chrome-sites" label={t('settings.mittrcraft.tools.field.agentChromeSites')}>
              {agentChromeApprovedHosts.length === 0 ? (
                <span className={SETTINGS_HELPER_CLASS}>{t('settings.mittrcraft.tools.field.agentChromeSitesEmpty')}</span>
              ) : (
                <ul className="w-full space-y-1">
                  {agentChromeApprovedHosts.map((host) => (
                    <li key={host} className="flex min-w-0 items-center justify-between gap-2">
                      <span className="typography-meta min-w-0 [overflow-wrap:anywhere]">{host}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleRemoveChromeHost(host)}
                        aria-label={t('settings.mittrcraft.tools.field.agentChromeSiteRemove', { host })}
                      >
                        {t('settings.mittrcraft.tools.field.agentChromeSiteRemoveShort')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </SettingsFieldRow>
          </>
        )}
      </div>
    </SettingsSection>
  );
};
