import type { ProductFontOptions } from '../../../ui/src/lib/product-plugins';

export const PLEX_FONT_OPTIONS = {
  ui: [
    {
      id: 'ibm-plex-sans',
      label: 'IBM Plex Sans',
      description: 'The interface face MITTR Studio uses, so the two products read as one family.',
      stack: '"IBM Plex Sans", "IBM Plex Sans Thai", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    },
  ],
  mono: [
    {
      id: 'ibm-plex-mono',
      label: 'IBM Plex Mono',
      description: 'Monospace companion to IBM Plex Sans, matching MITTR Studio.',
      stack: '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "IBM Plex Sans Thai", Thonburi, monospace',
    },
  ],
} satisfies ProductFontOptions;
