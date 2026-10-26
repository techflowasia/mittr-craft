import React from 'react';

import type { ModelEntryStatus } from '@/lib/product-plugins';
import { cn } from '@/lib/utils';

export const ModelEntryStatusPill: React.FC<{ status: ModelEntryStatus | null; isHighlighted: boolean }> = ({ status, isHighlighted }) => {
  if (!status) return null;
  return (
    <span
      role="img"
      data-model-status={status.tone}
      aria-label={status.title ?? status.pill}
      title={status.title}
      className={cn(
        'typography-micro flex-shrink-0 whitespace-nowrap rounded px-1.5 py-0.5',
        status.tone === 'near'
          ? 'bg-[var(--status-warning-background)] text-[var(--status-warning-text)]'
          : isHighlighted
            ? 'bg-interactive-selection-foreground/15 text-interactive-selection-foreground'
            : 'bg-[var(--surface-subtle)] text-muted-foreground',
      )}
    >
      {status.pill}
    </span>
  );
};
