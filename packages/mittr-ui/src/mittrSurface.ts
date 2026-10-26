import React from 'react';

export type MittrSurface = 'main' | 'mini-chat';

export const MittrSurfaceContext = React.createContext<MittrSurface | null>(null);

export function useMittrSurface(): MittrSurface | null {
  return React.useContext(MittrSurfaceContext);
}
