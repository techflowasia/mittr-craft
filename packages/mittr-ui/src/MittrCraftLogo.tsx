import React from 'react';

import { useI18n } from '../../ui/src/lib/i18n/useI18n';
import { ACCENT_PATHS, MARK_PATHS, MITTR_ACCENT_BLUE, MITTR_VIEWBOX } from './mittrMark';

type MittrCraftLogoProps = React.SVGProps<SVGSVGElement> & {
  isAnimated?: boolean;
  variant?: 'default' | 'splash';
};

const GLOW_STYLE = '@keyframes oc-logo-glow{0%,100%{filter:drop-shadow(0 0 0 transparent)}50%{filter:drop-shadow(0 0 4px var(--oc-glow-color))}}.oc-logo-glow{animation:oc-logo-glow 1.8s ease-in-out infinite}@media (prefers-reduced-motion:reduce){.oc-logo-glow{animation:none}}';

/**
 * The Mittr symbol, which MittrCraft shares with the rest of the family — the
 * product name does the distinguishing, not the mark.
 *
 * The strokes take `currentColor`, so the logo inherits whatever it is placed
 * on; the startup splash takes the pre-paint stroke colour instead, because
 * the app theme has not hydrated yet. The blue accents keep their own colour
 * deliberately: they read as the data marks they are in every theme, and they
 * are the one part of the mark that is not monochrome.
 *
 * The props match how the shared UI calls `OpenChamberLogo`.
 */
export const MittrCraftLogo: React.FC<MittrCraftLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
  variant = 'default',
}) => {
  const { t } = useI18n();
  const markColor = variant === 'splash' ? 'var(--splash-stroke, currentColor)' : 'currentColor';

  return (
    <svg
      width={width}
      height={height}
      viewBox={MITTR_VIEWBOX}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={t('openChamberLogo.aria.logo')}
      className={className}
    >
      {isAnimated ? <style>{GLOW_STYLE}</style> : null}
      {MARK_PATHS.map((d) => (
        <path
          key={d.slice(0, 24)}
          d={d}
          fill={markColor}
          fillRule="evenodd"
          className={isAnimated ? 'oc-logo-glow' : undefined}
          // SAFETY: a CSS custom property is a valid style key that React.CSSProperties does not list.
          style={isAnimated ? ({ '--oc-glow-color': markColor } as React.CSSProperties) : undefined}
        />
      ))}
      {ACCENT_PATHS.map((d) => (
        <path key={d.slice(0, 24)} d={d} fill={MITTR_ACCENT_BLUE} />
      ))}
    </svg>
  );
};
