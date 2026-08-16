import React from 'react';
import { useI18n } from '@/lib/i18n';
import mittrMark from '@/assets/mittr-mark.png';

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className = '',
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  const { t } = useI18n();

  return (
    <img
      src={mittrMark}
      width={width}
      height={height}
      alt=""
      role="img"
      aria-label={t('openChamberLogo.aria.logo')}
      className={`${className} object-contain${isAnimated ? ' animate-pulse motion-reduce:animate-none' : ''}`}
    />
  );
};
