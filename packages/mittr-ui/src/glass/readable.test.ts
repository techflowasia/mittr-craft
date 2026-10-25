import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'readable.css'), 'utf8');
const LAYER_ORDER = '@layer theme, base, components, utilities;';
const LAYER_OPEN = '@layer utilities {';
const css = source.slice(source.indexOf(LAYER_OPEN) + LAYER_OPEN.length, source.lastIndexOf('}'));
const uiSource = join(here, '../../../ui/src');

const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return sourceFiles(path);
  return /\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
});

const FADED = /(?<![\w:-])((?:[a-z-]+:)*)text-(muted-foreground|foreground)\/(\d+)(?![\w/])/g;

const TEXT_LINE = { 'muted-foreground': 85, foreground: 65 };

type Token = keyof typeof TEXT_LINE;

const tokenOf = (value: string): Token => (value === 'foreground' ? 'foreground' : 'muted-foreground');

type Faded = { variants: string; token: Token; alpha: number; name: string };

const fadedInUpstream = (): Faded[] => {
  const found = new Map<string, Faded>();
  for (const file of sourceFiles(uiSource)) {
    for (const match of readFileSync(file, 'utf8').matchAll(FADED)) {
      found.set(match[0], { variants: match[1], token: tokenOf(match[2]), alpha: Number(match[3]), name: match[0] });
    }
  }
  return [...found.values()];
};

const escapeClass = (name: string): string => name.replace(/[/:]/g, (char) => `\\${char}`);

const ruleFor = (selectorPart: string): string | undefined => {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1].includes(selectorPart)) return `${match[1]}{${match[2]}}`;
  }
  return undefined;
};

describe('readable.css', () => {
  const faded = fadedInUpstream();

  test('finds the faded tiers upstream uses', () => {
    expect(faded.some((entry) => entry.name === 'text-muted-foreground/70')).toBe(true);
  });

  test('every faded text tier below the AA line gets its plain colour back, under the glass only', () => {
    const missing: string[] = [];
    for (const entry of faded) {
      if (entry.alpha >= TEXT_LINE[entry.token]) continue;
      if (!['', 'hover:', 'placeholder:'].includes(entry.variants)) continue;
      const rule = ruleFor(`.${escapeClass(entry.name)}`);
      if (!rule || !rule.includes(`color: var(--${entry.token});`)) missing.push(entry.name);
    }
    expect(missing).toEqual([]);
  });

  test('tiers at or above the line are left as upstream draws them', () => {
    for (const entry of faded.filter((item) => item.alpha >= TEXT_LINE[item.token])) {
      expect(css.includes(`.${escapeClass(entry.name)}`)).toBe(false);
    }
  });

  test('every rule is scoped under the glass, keeps icons at their own opacity, and stays low enough to lose to a hover or state colour', () => {
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith('html.mittr-glass :where(')).toBe(true);
      if (!selector.includes('::placeholder') && !selector.includes(':hover')) expect(selector.endsWith(':not(svg)')).toBe(true);
    }
  });

  test('the rules sit in the utilities layer, after Tailwind\'s own order, so a hover or state colour still wins', () => {
    expect(source.startsWith(`${LAYER_ORDER}\n\n${LAYER_OPEN}\n`)).toBe(true);
    expect(source.trimEnd().endsWith('}\n}')).toBe(true);
    expect(css.includes('@')).toBe(false);
  });

  test('placeholders and hover colours are restored on their own pseudo-classes', () => {
    expect(ruleFor('::placeholder')).toContain('color: var(--muted-foreground);');
    expect(ruleFor(':hover')).toContain('color: var(--muted-foreground);');
  });
});
