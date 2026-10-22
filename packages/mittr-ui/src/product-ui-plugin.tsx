import { registerProductUiPlugin, type ProductUiPlugin } from '../../ui/src/lib/product-plugins';
import { AboutSettingsSignOut, SignOutButton } from './accounts/SignOutButton';
import { INTEGRATIONS_PAGE } from './integrationsPage';
import { MittrCraftLogo } from './MittrCraftLogo';
import { MittrRoot } from './MittrRoot';
import { OtherProvidersSwitch } from './providers/OtherProvidersSwitch';
import { useMittrPickerDecorations } from './providers/useMittrPickerFilter';
import { AnsweredByNotice } from './quota/AnsweredByNotice';
import { QuotaRetryButton } from './quota/QuotaRetryButton';
import { mittrMessageError } from './quota/quotaError';
import './quota/registerMittrUsage';
import { TodayPage } from './today/TodayPage';
import { SIDEBAR_FOOTER } from './sidebarFooter';
import { strings } from './strings/en';
import { mittrT } from './strings/mittrT';
import { AdSignIn } from './ui-auth/AdSignIn';
import { ComposerVoiceActions } from './voice/ComposerVoiceActions';
import { useMittrDictationBlock } from './voice/useMittrDictationBlock';

// Registered on import, which the entry points do before their first render:
// the model picker takes its decorations once and keeps them.
export const MITTRCRAFT_UI_PLUGIN: ProductUiPlugin = {
  id: 'mittrcraft',
  substitutions: [
    ['OpenChamber', 'MittrCraft'],
    ['OpenCode', 'MittrCraft'],
  ],
  dictionaries: { en: strings },
  logo: MittrCraftLogo,
  rootWrapper: MittrRoot,
  slots: {
    'providers-page': OtherProvidersSwitch,
    'integrations-page': INTEGRATIONS_PAGE,
    'sidebar-footer': SIDEBAR_FOOTER,
    'session-auth-methods': AdSignIn,
    'about-dialog': SignOutButton,
    'about-settings': AboutSettingsSignOut,
    'assistant-message-footer': [AnsweredByNotice, QuotaRetryButton],
    'composer-actions': ComposerVoiceActions,
    'main-surface': TodayPage,
  },
  composer: { useDictationBlock: useMittrDictationBlock },
  modelPicker: { useDecorations: useMittrPickerDecorations },
  messageError: mittrMessageError,
  sessionAuthDescription: ({ passwordEnabled, runtime }) => (passwordEnabled || runtime === 'desktop-local' ? null : mittrT('mittr.uiAuth.gateDescription')),
  // Mittr models come from the Mittr catalog; models.dev is a third party.
  remoteModelCatalog: false,
};

registerProductUiPlugin(MITTRCRAFT_UI_PLUGIN);
