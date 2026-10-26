import React from 'react';

import { useUIStore } from '../../../ui/src/stores/useUIStore';
import { createFontChoices, plexClassesFor, type FontChoices } from './defaultFonts';
import './plex.css';

const browserStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function MittrDefaultFonts({ createChoices = () => createFontChoices(browserStorage()) }: { createChoices?: () => FontChoices }): null {
  const [choices] = React.useState(createChoices);
  const [, recount] = React.useReducer((count: number) => count + 1, 0);
  const uiFont = useUIStore((state) => state.uiFont);
  const monoFont = useUIStore((state) => state.monoFont);

  React.useLayoutEffect(() => useUIStore.subscribe((next, previous) => {
    if (next.uiFont === previous.uiFont && next.monoFont === previous.monoFont) return;
    choices.observe(previous, next);
    recount();
  }), [choices]);

  const classes = plexClassesFor({ uiFont, monoFont }, choices).join(' ');

  React.useLayoutEffect(() => {
    if (!classes) return undefined;
    const names = classes.split(' ');
    const page = document.documentElement;
    page.classList.add(...names);
    return () => page.classList.remove(...names);
  }, [classes]);

  return null;
}
