import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const designCss = readFileSync(join(here, 'design.css'), 'utf8');
const glass = readFileSync(join(here, 'glass.css'), 'utf8');
const sky = readFileSync(join(here, 'GlassSky.tsx'), 'utf8');
const button = readFileSync(join(here, '../../../ui/src/components/ui/button.tsx'), 'utf8');

type Rule = { selectors: string[]; body: string };

const splitSelectors = (prelude: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = '';
  let from = 0;
  for (let at = 0; at < prelude.length; at += 1) {
    const char = prelude[at];
    if (quoted) {
      if (char === quoted) quoted = '';
      continue;
    }
    if (char === '"' || char === "'") quoted = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(prelude.slice(from, at).trim());
      from = at + 1;
    }
  }
  parts.push(prelude.slice(from).trim());
  return parts;
};

const rulesOf = (css: string): Rule[] => {
  const rules: Rule[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open < 0) break;
    const prelude = css.slice(cursor, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === '{') depth += 1;
      if (css[close] === '}') depth -= 1;
      close += 1;
    }
    if (!prelude.startsWith('@')) rules.push({ selectors: splitSelectors(prelude), body: css.slice(open + 1, close - 1) });
    cursor = close;
  }
  return rules;
};

const designRules = rulesOf(designCss);
const glassRules = rulesOf(glass);
const bodyOf = (selector: string): string => designRules.find((rule) => rule.selectors.includes(selector))?.body ?? '';
const value = (selector: string, property: string): string | undefined =>
  new RegExp(`(?:^|[\\s;])${property.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(bodyOf(selector))?.[1].trim();

const PRIMARY_TINT = 'bg-[color-mix(in_srgb,var(--primary-base)_10%,var(--background))]';

describe('design.css, 1.22\'s design-system shape on the default themes', () => {
  test('every rule is scoped to the glass, and nothing loads from the network', () => {
    expect(designRules.length).toBeGreaterThan(0);
    for (const selector of designRules.flatMap((rule) => rule.selectors)) expect(selector.startsWith('html.mittr-glass')).toBe(true);
    expect(/url\(/i.test(designCss)).toBe(false);
    expect(designCss).not.toContain('@import');
  });

  test('the corner radius follows Studio\'s scale, 6/10/14/18px', () => {
    expect([['sm', '6px'], ['md', '10px'], ['lg', '14px'], ['xl', '18px']].map(([step]) => value(`html.mittr-glass .rounded-${step}`, 'border-radius'))).toEqual(['6px', '10px', '14px', '18px']);
  });

  test('the type scale is 1.22\'s six real steps, set where it outranks the sizes upstream writes on :root and :root:not(.dark)', () => {
    const scale = 'html.mittr-glass:root';
    expect(Object.fromEntries(['markdown', 'code', 'ui-header', 'ui-label', 'meta', 'micro', 'settings-page-title'].map((name) => [name, value(scale, `--text-${name}`)]))).toEqual({
      markdown: '0.9375rem',
      code: '0.8125rem',
      'ui-header': '0.9375rem',
      'ui-label': '0.8125rem',
      meta: '0.8125rem',
      micro: '0.75rem',
      'settings-page-title': '1.25rem',
    });
  });

  test('the default button, and only it, takes the sheen and the first elevation step', () => {
    expect(button).toContain(`"${PRIMARY_TINT}",`);
    const selector = `html.mittr-glass [data-slot="button"][class*="${PRIMARY_TINT}"]`;
    expect(value(selector, 'background-image')).toBe('var(--mittr-sheen)');
    expect(value(selector, 'box-shadow')).toBe('var(--mittr-elev-1)');
    expect(designRules.filter((rule) => /background-image|box-shadow/.test(rule.body)).flatMap((rule) => rule.selectors)).toEqual([selector]);
  });

  test('dark elevation is heavier than light, as 1.22 measured', () => {
    const alphaOf = (selector: string, step: number) => Number(/\/\s*([\d.]+)\)/.exec(value(selector, `--mittr-elev-${step}`) ?? '')?.[1]);
    for (const step of [1, 2, 3]) {
      expect(alphaOf('html.mittr-glass.mittr-glass-dark', step)).toBeGreaterThan(alphaOf('html.mittr-glass', step));
    }
    expect(value('html.mittr-glass', '--mittr-sheen')).toBe('linear-gradient(180deg, #ffffff14, #fff0 42%)');
    expect(value('html.mittr-glass.mittr-glass-dark', '--mittr-sheen')).toBe('linear-gradient(180deg, #ffffff17, #fff0 42%)');
  });

  test('glass wins where they overlap: it loads after design.css, and design.css leaves the dialog and every corner and shadow glass sets alone', () => {
    expect(sky.indexOf("import './design.css';")).toBeGreaterThan(-1);
    expect(sky.indexOf("import './design.css';")).toBeLessThan(sky.indexOf("import './glass.css';"));
    const glassCornersAndShadows = glassRules.filter((rule) => /border-radius|box-shadow/.test(rule.body)).flatMap((rule) => rule.selectors);
    expect(glassCornersAndShadows).toContain('html.mittr-glass [role="dialog"]');
    for (const selector of designRules.flatMap((rule) => rule.selectors)) expect(glassCornersAndShadows.includes(selector)).toBe(false);
    expect(designCss.includes('dialog')).toBe(false);
  });
});
