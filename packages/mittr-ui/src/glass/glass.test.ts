import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'glass.css'), 'utf8');
const themeSurface = (id: string): { foreground: string; mutedForeground: string } =>
  JSON.parse(readFileSync(join(here, '../../../ui/src/lib/theme/themes', `${id}.json`), 'utf8')).colors.surface;

type Rule = { selectors: string[]; body: string; within: string[] };

const parse = (source: string, within: string[] = []): Rule[] => {
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open < 0) break;
    const prelude = source.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < source.length && depth > 0) {
      if (source[close] === '{') depth += 1;
      if (source[close] === '}') depth -= 1;
      close += 1;
    }
    const body = source.slice(open + 1, close - 1);
    if (prelude.startsWith('@')) rules.push(...parse(body, [...within, prelude]));
    else rules.push({ selectors: prelude.split(',').map((selector) => selector.trim()), body, within });
    cursor = close;
  }
  return rules;
};

const rules = parse(css);

const REGIONS = [
  '[data-product-region="shell"] aside:has(+ [data-product-region="column"])',
  '[data-product-region="column"] > header',
  '[data-product-region="column"]',
  '[data-product-region="column"]:has(.mittr-today)',
  '.mittr-glass-panel',
];

describe('glass.css', () => {
  test('has rules, and every one is scoped under html.mittr-glass', () => {
    expect(rules.length).toBeGreaterThan(10);
    const loose = rules.flatMap((rule) => rule.selectors).filter((selector) => !selector.startsWith('html.mittr-glass'));
    expect(loose).toEqual([]);
  });

  for (const [name, condition] of [
    ['reduced transparency', '@media (prefers-reduced-transparency: reduce)'],
    ['no backdrop-filter support', '@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))'],
  ] as const) {
    test(`with ${name}, every frosted region is solid and unblurred`, () => {
      const inside = rules.filter((rule) => rule.within.includes(condition));
      expect(inside.length).toBeGreaterThan(0);
      for (const region of REGIONS) {
        const covering = inside.filter((rule) => rule.selectors.some((selector) => selector.endsWith(region)));
        expect(covering.some((rule) => /background-color:\s*var\(--mittr-glass-solid\)/.test(rule.body))).toBe(true);
        expect(covering.some((rule) => /(^|[^-])backdrop-filter:\s*none/.test(rule.body))).toBe(true);
      }
      expect(inside.some((rule) => rule.selectors.some((selector) => selector.endsWith('.mittr-glass-sky')) && /display:\s*none/.test(rule.body))).toBe(true);
    });
  }

  test('the solid fallback colours are opaque in both modes', () => {
    const solids = [...css.matchAll(/--mittr-glass-solid:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(solids.length).toBe(2);
    for (const solid of solids) expect(/^#[0-9a-f]{6}$/i.test(solid)).toBe(true);
  });

  test('defines the display font from the system serif stack', () => {
    expect(css).toContain('--mittr-font-display: ui-serif, "New York", "Noto Serif Thai", Thonburi, serif;');
  });

  test('loads nothing from the network', () => {
    expect(/url\(\s*['"]?https?:/i.test(css)).toBe(false);
    expect(css).not.toContain('@import');
  });

  test('styles the assistant bubble white in light and deep grey in dark', () => {
    expect(css).toContain('--mittr-bubble: #ffffff;');
    expect(css).toContain('--mittr-bubble: #1f2430;');
    expect(rules.some((rule) => rule.selectors.some((selector) => selector.endsWith('[data-assistant-bubble]')) && /background-color:\s*var\(--mittr-bubble\)/.test(rule.body))).toBe(true);
  });
});

type Rgb = [number, number, number];

const hex = (value: string): Rgb => {
  const channel = (at: number): number => parseInt(value.replace('#', '').slice(at, at + 2), 16);
  return [channel(0), channel(2), channel(4)];
};

const mix = (top: number, alpha: number, bottom: number): number => top * alpha + bottom * (1 - alpha);

const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb =>
  [mix(top[0], alpha, bottom[0]), mix(top[1], alpha, bottom[1]), mix(top[2], alpha, bottom[2])];

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

const LIGHT_SKY = ['#ffffff', '#a7bbdb', '#afc2df', '#b8c8e2', '#cfd8e6', '#e6e8ec', '#e4e7ec'];
const DARK_SKY = ['#30456f', '#1b2a4a', '#1e2f52', '#0c1427', '#111a30', '#161d2c', '#141c2e'];

const MODES = [
  {
    name: 'light',
    theme: 'openchamber-light',
    sky: LIGHT_SKY,
    tints: [
      { css: '--mittr-glass-tint: rgb(255 255 255 / 0.55);', rgb: hex('#ffffff'), alpha: 0.55 },
      { css: '--mittr-glass-veil: rgb(255 255 255 / 0.45);', rgb: hex('#ffffff'), alpha: 0.45 },
    ],
    bubble: '#ffffff',
    solid: '--mittr-glass-solid: #f4f6fa;',
  },
  {
    name: 'dark',
    theme: 'openchamber-dark',
    sky: DARK_SKY,
    tints: [
      { css: '--mittr-glass-tint: rgb(18 22 31 / 0.72);', rgb: hex('#12161f'), alpha: 0.72 },
      { css: '--mittr-glass-veil: rgb(14 18 28 / 0.68);', rgb: hex('#0e121c'), alpha: 0.68 },
    ],
    bubble: '#1f2430',
    solid: '--mittr-glass-solid: #151a24;',
  },
];

describe('glass text contrast (WCAG AA, 4.5:1)', () => {
  for (const mode of MODES) {
    const { foreground, mutedForeground } = themeSurface(mode.theme);
    const texts = [hex(foreground), hex(mutedForeground)];

    test(`${mode.name}: the tints in the test are the ones in the CSS`, () => {
      for (const tint of mode.tints) expect(css).toContain(tint.css);
      expect(css).toContain(mode.solid);
    });

    test(`${mode.name}: body and muted text pass on every frosted surface over every sky colour`, () => {
      for (const tint of mode.tints) {
        for (const sky of mode.sky) {
          const surface = over(tint.rgb, tint.alpha, hex(sky));
          for (const text of texts) expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    test(`${mode.name}: body text passes straight on the sky, and both pass on the bubble and the solid fallback`, () => {
      for (const sky of mode.sky) expect(contrast(texts[0], hex(sky))).toBeGreaterThanOrEqual(4.5);
      const solid = hex(mode.solid.match(/#[0-9a-f]{6}/i)?.[0] ?? '#000000');
      for (const text of texts) {
        expect(contrast(text, hex(mode.bubble))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(text, solid)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
