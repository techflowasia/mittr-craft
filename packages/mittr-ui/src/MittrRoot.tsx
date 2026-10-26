import React from 'react';

import { MittrLastPick } from './composer/lastPick';
import { MittrDefaultFonts } from './fonts/MittrDefaultFonts';
import { GlassSky } from './glass/GlassSky';
import { MittrSurfaceContext, type MittrSurface } from './mittrSurface';
import { MittrProjectFolderNotice } from './projectFolder/MittrProjectFolderNotice';
import { SelectMittrUsage } from './quota/SelectMittrUsage';
import { MittrSignInGate } from './sign-in/MittrSignInGate';
import { MittrSmallModelRefresh } from './smallModel/smallModelRefresh';
import { MittrVoiceMount } from './voice/MittrVoiceRoot';
import { MittrRecentSectionDefault } from './sidebar/recentSectionDefault';
import './sidebar/projectActions.css';

export function MittrRoot({ children, surface }: { children: React.ReactNode; surface: MittrSurface }): React.ReactNode {
  return (
    <MittrSurfaceContext.Provider value={surface}>
      <GlassSky />
      <MittrDefaultFonts />
      <MittrSmallModelRefresh />
      <MittrRecentSectionDefault />
      <MittrSignInGate>
        <SelectMittrUsage />
        <MittrProjectFolderNotice surface={surface} />
        <MittrVoiceMount />
        {surface === 'main' ? <MittrLastPick /> : null}
        {children}
      </MittrSignInGate>
    </MittrSurfaceContext.Provider>
  );
}
