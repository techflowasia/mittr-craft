import React from 'react';

import { MittrSurfaceContext, type MittrSurface } from './mittrSurface';
import { SelectMittrUsage } from './quota/SelectMittrUsage';
import { MittrSignInGate } from './sign-in/MittrSignInGate';
import { MittrVoiceMount } from './voice/MittrVoiceRoot';

export function MittrRoot({ children, surface }: { children: React.ReactNode; surface: MittrSurface }): React.ReactNode {
  return (
    <MittrSurfaceContext.Provider value={surface}>
      <MittrSignInGate>
        <SelectMittrUsage />
        <MittrVoiceMount surface={surface} />
        {children}
      </MittrSignInGate>
    </MittrSurfaceContext.Provider>
  );
}
