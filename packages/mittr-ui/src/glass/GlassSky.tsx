import React from 'react';

import './design.css';
import './glass.css';
import './readable.css';
import { useGlassTheme } from './useGlassTheme';

export function GlassSky(): React.ReactNode {
  return useGlassTheme() ? <div className="mittr-glass-sky" aria-hidden="true" /> : null;
}
