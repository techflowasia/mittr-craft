import React from 'react';
import { useI18n } from '@/lib/i18n';
import { ACCENT_PATHS, MARK_PATHS, MITTR_ACCENT_BLUE, MITTR_VIEWBOX } from './mittrMark';

interface MittrCraftLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

/**
 * The Mittr symbol, which MittrCraft shares with the rest of the family — the
 * product name does the distinguishing, not the mark.
 *
 * The strokes take `currentColor`, so the logo inherits whatever it is placed
 * on. The blue accents keep their own colour deliberately: they read as the
 * data marks they are in every theme, and they are the one part of the mark
 * that is not monochrome.
 */
export const MittrCraftLogo: React.FC<MittrCraftLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  const { t } = useI18n();

  return (
    <svg
      width={width}
      height={height}
      viewBox={MITTR_VIEWBOX}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={t('mittrCraftLogo.aria.logo')}
      className={className}
    >
      {MARK_PATHS.map((d) => (
        <path
          key={d.slice(0, 24)}
          d={d}
          fill="currentColor"
          fillRule="evenodd"
          className={isAnimated ? 'oc-logo-glow' : undefined}
          style={isAnimated ? ({ '--oc-glow-color': 'currentColor' } as React.CSSProperties) : undefined}
        />
      ))}
      {ACCENT_PATHS.map((d) => (
        <path key={d.slice(0, 24)} d={d} fill={MITTR_ACCENT_BLUE} />
      ))}
    </svg>
  );
};
