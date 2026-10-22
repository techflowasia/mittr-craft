import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'glass.css'), 'utf8');
const themeSurface = (id: string): { foreground: string; mutedForeground: string } =>
  JSON.parse(readFileSync(join(here, '../../../ui/src/lib/theme/themes', `${id}.json`), 'utf8')).colors.surface;

type Rule = { selectors: string[]; body: string; within: string[] };

const topLevel = (prelude: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < prelude.length; at += 1) {
    if (prelude[at] === '(') depth += 1;
    if (prelude[at] === ')') depth -= 1;
    if (prelude[at] === ',' && depth === 0) {
      parts.push(prelude.slice(from, at).trim());
      from = at + 1;
    }
  }
  parts.push(prelude.slice(from).trim());
  return parts;
};

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
    else rules.push({ selectors: topLevel(prelude), body, within });
    cursor = close;
  }
  return rules;
};

const rules = parse(css);

const REGIONS = [
  '[data-product-region="shell"] aside:has(+ [data-product-region="column"])',
  '[data-product-region="column"] > header',
  '[data-product-region="main"]',
  '[data-context-panel]',
  '[data-product-region="column"] > div > div > nav',
  'html.mittr-glass.mittr-glass-mini #root > :not(.mittr-glass-sky)',
  '.mittr-glass-panel',
];

const GUARD = ['@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))', '@media (prefers-reduced-transparency: no-preference)'];
const FALLBACKS = ['@media (prefers-reduced-transparency: reduce)', '@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))'];
const guarded = (rule: Rule): boolean => GUARD.every((condition) => rule.within.includes(condition));
const VEIL = /background-color:\s*var\(--mittr-glass-veil\)/;
const BLUR = /(^|[^-])backdrop-filter:\s*blur\(/;

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
        const covering = inside.filter((rule) => rule.selectors.some((selector) => selector === region || selector.endsWith(` ${region}`)));
        expect(covering.some((rule) => /background-color:\s*var\(--mittr-glass-solid\)/.test(rule.body))).toBe(true);
        expect(covering.some((rule) => /(^|[^-])backdrop-filter:\s*none/.test(rule.body))).toBe(true);
      }
      expect(inside.some((rule) => rule.selectors.some((selector) => selector.endsWith('.mittr-glass-sky')) && /display:\s*none/.test(rule.body))).toBe(true);
    });
  }

  test('I4: whatever turns the background see-through exists only while blur works and transparency is welcome', () => {
    const clearing = rules.filter((rule) => /--background:\s*transparent/.test(rule.body) || /background-color:\s*transparent/.test(rule.body));
    expect(clearing.length).toBeGreaterThan(0);
    for (const rule of clearing) expect(guarded(rule)).toBe(true);
    for (const rule of rules.filter((entry) => FALLBACKS.some((condition) => entry.within.includes(condition)))) {
      expect(/--background\s*:/.test(rule.body)).toBe(false);
    }
  });

  test('I3: the background is cleared only for the main window shell and the mini-chat, and every other part of the app keeps it opaque', () => {
    const cleared = rules.filter((rule) => /--background:\s*transparent/.test(rule.body)).flatMap((rule) => rule.selectors);
    expect(cleared.sort()).toEqual([
      'html.mittr-glass #root',
      'html.mittr-glass #root > :not(.mittr-glass-sky)',
      'html.mittr-glass #root [data-product-region="shell"]',
      'html.mittr-glass [role="dialog"] > *',
      'html.mittr-glass.mittr-glass-mini #root > :not(.mittr-glass-sky)',
    ]);
    const restored = rules.filter((rule) => /--background:\s*var\(--surface-background\)/.test(rule.body) && guarded(rule)).flatMap((rule) => rule.selectors);
    for (const cover of [
      'html.mittr-glass #root :is(.fixed.inset-0, [class*="bg-background/"], [class*="text-background"])',
      'html.mittr-glass [data-product-region="main"] > .bg-background',
      'html.mittr-glass [data-context-panel] .absolute.inset-0.bg-background',
      'html.mittr-glass.mittr-glass-mini #root :is(.fixed.inset-0, [class*="bg-background/"], [class*="text-background"])',
    ]) {
      expect(restored).toContain(cover);
    }
  });

  test('I5: with Today open only the main area drops its frost; the context panel and the rail keep theirs', () => {
    const dropped = rules.filter((rule) => /background-color:\s*transparent/.test(rule.body)).flatMap((rule) => rule.selectors);
    expect(dropped.sort()).toEqual(['html.mittr-glass .mittr-today', 'html.mittr-glass [data-product-region="main"]:has(> .mittr-today)']);
    for (const region of ['[data-product-region="main"]', '[data-context-panel]', '[data-product-region="column"] > div > div > nav']) {
      const frosted = rules.filter((rule) => rule.within.length === 0 && rule.selectors.includes(`html.mittr-glass ${region}`));
      expect(frosted.some((rule) => VEIL.test(rule.body) && BLUR.test(rule.body))).toBe(true);
    }
    expect(rules.some((rule) => rule.selectors.some((selector) => selector.startsWith('html.mittr-glass [data-product-region="column"]') && !selector.includes('>') && !selector.includes('.border-border')))).toBe(false);
  });

  test('I6: the mini-chat window is frosted, not raw sky', () => {
    const mini = rules.filter((rule) => rule.within.length === 0 && rule.selectors.includes('html.mittr-glass.mittr-glass-mini #root > :not(.mittr-glass-sky)'));
    expect(mini.some((rule) => VEIL.test(rule.body) && BLUR.test(rule.body))).toBe(true);
  });

  test('buttons, selects and text inputs are pills everywhere under glass, and dialogs and menus are rounded glass', () => {
    const rounded = rules.filter((rule) => /border-radius:\s*999px/.test(rule.body)).flatMap((rule) => rule.selectors);
    for (const selector of [
      'html.mittr-glass [data-slot="button"]',
      'html.mittr-glass [data-slot="select-trigger"]',
      'html.mittr-glass [data-slot="input"]',
    ]) {
      expect(rounded).toContain(selector);
    }
    const dialog = rules.find((rule) => rule.within.length === 0 && rule.selectors.includes('html.mittr-glass [role="dialog"]'));
    expect(dialog?.body).toMatch(/border-radius:\s*26px/);
    expect(rules.some((rule) => rule.selectors.some((selector) => selector.includes('[role="dialog"]')) && /overflow\s*:/.test(rule.body))).toBe(false);
    expect(dialog?.body).toMatch(BLUR);
    expect(rules.some((rule) => rule.selectors.some((selector) => selector.includes('[role="menu"]')) && /border-radius:\s*16px/.test(rule.body))).toBe(true);
  });

  test('the solid fallback colours are opaque in both modes', () => {
    const solids = [...css.matchAll(/--mittr-glass-solid:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(solids.length).toBe(2);
    for (const solid of solids) expect(/^#[0-9a-f]{6}$/i.test(solid)).toBe(true);
  });

  test('defines the display font from serif faces macOS ships, with Thai after Latin so Latin never falls to a Thai sans', () => {
    expect(css).toContain('--mittr-font-display: "Iowan Old Style", Charter, Georgia, "Noto Serif Thai", Thonburi, serif;');
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

type Colours = Record<'primary' | 'error' | 'warning' | 'success' | 'info', string>;

const glassColours = (selector: string): Colours => {
  const rule = rules.find((entry) => entry.within.length === 0 && entry.selectors.includes(selector));
  const read = (name: string): string => {
    const found = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(rule?.body ?? '');
    if (!found) throw new Error(`${selector} sets no --${name}`);
    return found[1];
  };
  for (const name of ['primary-base', 'markdown-link']) expect(read(name)).toBe(read('primary'));
  return { primary: read('primary'), error: read('status-error'), warning: read('status-warning'), success: read('status-success'), info: read('status-info') };
};

const STATUS_TINT = 0.125;

test('I7: Today and widget text is coloured with the status and primary colours the glass checks, never with the on-colour foregrounds', () => {
  for (const file of ['../today/today.css', '../widgets/widgets.css']) {
    const source = readFileSync(join(here, file), 'utf8');
    const colours = [...source.matchAll(/(?:^|[\s;{])color:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) expect(/--status-[a-z]+-foreground/.test(colour)).toBe(false);
  }
});

describe('glass text contrast (WCAG AA, 4.5:1)', () => {
  for (const mode of MODES) {
    const { foreground, mutedForeground } = themeSurface(mode.theme);
    const texts = [hex(foreground), hex(mutedForeground)];
    const colours = glassColours(mode.name === 'dark' ? 'html.mittr-glass.mittr-glass-dark body' : 'html.mittr-glass body');
    const raised = mode.name === 'dark' ? { rgb: hex('#1f2430'), alpha: 0.82 } : { rgb: hex('#ffffff'), alpha: 0.72 };

    test(`${mode.name}: the tints in the test are the ones in the CSS`, () => {
      for (const tint of mode.tints) expect(css).toContain(tint.css);
      expect(css).toContain(mode.solid);
      expect(css).toContain(mode.name === 'dark' ? '--mittr-glass-raised: rgb(31 36 48 / 0.82);' : '--mittr-glass-raised: rgb(255 255 255 / 0.72);');
    });

    test(`${mode.name}: body and muted text pass on every frosted surface over every sky colour`, () => {
      for (const tint of mode.tints) {
        for (const sky of mode.sky) {
          const surface = over(tint.rgb, tint.alpha, hex(sky));
          for (const text of texts) expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    test(`${mode.name}: I7 links and status text pass on the panels, the frosted chat, context panel and rail and a raised card, and text passes on an alert pill`, () => {
      const failures: string[] = [];
      for (const sky of mode.sky) {
        const surfaces: Array<[string, Rgb]> = mode.tints.map((tint) => [tint.css.slice(0, tint.css.indexOf(':')), over(tint.rgb, tint.alpha, hex(sky))]);
        const panel = surfaces[0][1];
        surfaces.push(['raised card', over(raised.rgb, raised.alpha, panel)]);
        for (const [name, colour] of Object.entries(colours) as Array<[keyof Colours, string]>) {
          for (const [surfaceName, surface] of surfaces) {
            const ratio = contrast(hex(colour), surface);
            if (ratio < 4.5) failures.push(`${name} ${colour} on ${surfaceName} over ${sky}: ${ratio.toFixed(2)}`);
          }
        }
        for (const colour of [colours.warning, colours.error]) {
          const pill = over(hex(colour), STATUS_TINT, panel);
          const ratio = contrast(texts[0], pill);
          if (ratio < 4.5) failures.push(`text on a ${colour} pill over ${sky}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
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
