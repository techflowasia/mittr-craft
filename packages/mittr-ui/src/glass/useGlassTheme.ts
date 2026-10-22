import React from 'react';

import { ThemeSystemContext } from '../../../ui/src/contexts/theme-system-context';
import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '../../../ui/src/lib/theme/themes';
import { useMittrSurface } from '../mittrSurface';

const GLASS = 'mittr-glass';
const GLASS_DARK = 'mittr-glass-dark';
const GLASS_MINI = 'mittr-glass-mini';

type GlassLook = { on: boolean; dark: boolean };

const glassLookFor = (themeId: string | undefined, variant: string | undefined): GlassLook => {
  if (themeId === DEFAULT_LIGHT_THEME_ID && variant === 'light') return { on: true, dark: false };
  if (themeId === DEFAULT_DARK_THEME_ID && variant === 'dark') return { on: true, dark: true };
  return { on: false, dark: false };
};

export function useGlassTheme(): boolean {
  const metadata = React.useContext(ThemeSystemContext)?.currentTheme.metadata;
  const mini = useMittrSurface() === 'mini-chat';
  const { on, dark } = glassLookFor(metadata?.id, metadata?.variant);

  React.useLayoutEffect(() => {
    if (!on) return undefined;
    const names = [GLASS, ...(dark ? [GLASS_DARK] : []), ...(mini ? [GLASS_MINI] : [])];
    const root = document.documentElement;
    root.classList.add(...names);
    return () => root.classList.remove(...names);
  }, [on, dark, mini]);

  return on;
}
