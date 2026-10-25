import React from 'react';

import { GlassSky } from './glass/GlassSky';
import { MittrSurfaceContext, type MittrSurface } from './mittrSurface';
import { MittrProjectFolderNotice } from './projectFolder/MittrProjectFolderNotice';
import { SelectMittrUsage } from './quota/SelectMittrUsage';
import { MittrSignInGate } from './sign-in/MittrSignInGate';
import { MittrSmallModelRefresh } from './smallModel/smallModelRefresh';
import { MittrVoiceMount } from './voice/MittrVoiceRoot';

export function MittrRoot({ children, surface }: { children: React.ReactNode; surface: MittrSurface }): React.ReactNode {
  return (
    <MittrSurfaceContext.Provider value={surface}>
      <GlassSky />
      <MittrSmallModelRefresh />
      <MittrSignInGate>
        <SelectMittrUsage />
        <MittrProjectFolderNotice surface={surface} />
        <MittrVoiceMount surface={surface} />
        {children}
      </MittrSignInGate>
    </MittrSurfaceContext.Provider>
  );
}
