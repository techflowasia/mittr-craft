import * as React from 'react';

import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
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
      </div>
    </SettingsSection>
  );
};
