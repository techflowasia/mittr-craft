import React from 'react';

import { registerProductUiPlugin } from '../../ui/src/lib/product-plugins';
import { MittrAccountMenu } from './accounts/MittrAccountMenu';
import { AboutSettingsSignOut, SignOutButton } from './accounts/SignOutButton';
import { MittrCraftLogo } from './MittrCraftLogo';
import { OtherProvidersSwitch } from './providers/OtherProvidersSwitch';
import { useMittrPickerDecorations } from './providers/useMittrPickerFilter';
import { AnsweredByNotice } from './quota/AnsweredByNotice';
import { QuotaRetryButton } from './quota/QuotaRetryButton';
import { mittrMessageError } from './quota/quotaError';
import './quota/registerMittrUsage';
import { SelectMittrUsage } from './quota/SelectMittrUsage';
import { MittrSignInGate } from './sign-in/MittrSignInGate';
import { strings } from './strings/en';
import { AdSignIn } from './ui-auth/AdSignIn';
import { SidebarProfile } from './ui-auth/SidebarProfile';

export function MittrRoot({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <MittrSignInGate>
      <SelectMittrUsage />
      {children}
    </MittrSignInGate>
  );
}

// Registered on import, which the entry points do before their first render:
// the model picker takes its decorations once and keeps them.
registerProductUiPlugin({
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
    'sidebar-footer': [MittrAccountMenu, SidebarProfile],
    'session-auth-methods': AdSignIn,
    'about-dialog': SignOutButton,
    'about-settings': AboutSettingsSignOut,
    'assistant-message-footer': [AnsweredByNotice, QuotaRetryButton],
  },
  modelPicker: { useDecorations: useMittrPickerDecorations },
  messageError: mittrMessageError,
  // Mittr models come from the Mittr catalog; models.dev is a third party.
  remoteModelCatalog: false,
});
