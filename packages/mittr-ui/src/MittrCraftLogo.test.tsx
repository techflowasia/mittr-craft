import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ACCENT_PATHS, MITTR_ACCENT_BLUE, mittrAccentFill } from './mittrMark';

// The logo only needs its aria label; the real i18n store pulls in the app's settings graph.
mock.module('../../ui/src/lib/i18n/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const { MittrCraftLogo } = await import('./MittrCraftLogo');

const realCss = globalThis.CSS;
const withColorMix = (supported: boolean) => {
  // SAFETY: the logo reads only CSS.supports; the rest of the CSS namespace is not used.
  globalThis.CSS = { supports: () => supported } as unknown as typeof CSS;
};

afterEach(() => {
  globalThis.CSS = realCss;
});

const render = (element: React.ReactElement): string => renderToStaticMarkup(element);

const accentFills = (markup: string): string[] => {
  const fills = [...markup.matchAll(/<path d="([^"]+)" fill="([^"]+)"/g)]
    .filter(([, d]) => ACCENT_PATHS.includes(d))
    .map(([, , fill]) => fill.replace(/&quot;/g, '"'));
  expect(fills).toHaveLength(ACCENT_PATHS.length);
  return [...new Set(fills)];
};

describe('MittrCraft logo accents', () => {
  test('the accents take brand blue mixed with the theme foreground', () => {
    withColorMix(true);
    expect(accentFills(render(<MittrCraftLogo />))).toEqual([
      `color-mix(in srgb, ${MITTR_ACCENT_BLUE} 70%, var(--surface-foreground, currentColor))`,
    ]);
  });

  test('on the splash the accents mix with the pre-paint stroke colour', () => {
    withColorMix(true);
    expect(accentFills(render(<MittrCraftLogo variant="splash" />))).toEqual([
      `color-mix(in srgb, ${MITTR_ACCENT_BLUE} 70%, var(--splash-stroke, currentColor))`,
    ]);
  });

  test('without color-mix the accents are plain brand blue', () => {
    withColorMix(false);
    expect(mittrAccentFill('#cecdc3')).toBe(MITTR_ACCENT_BLUE);
  });
});
