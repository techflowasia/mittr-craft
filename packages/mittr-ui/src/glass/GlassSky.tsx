import React from 'react';

import './glass.css';
import { useGlassTheme } from './useGlassTheme';

export function GlassSky(): React.ReactNode {
  return useGlassTheme() ? <div className="mittr-glass-sky" aria-hidden="true" /> : null;
}
