import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./projectActions.css', import.meta.url), 'utf8');
const upstream = readFileSync(new URL('../../../ui/src/components/session/sidebar/projects/sortableItems.tsx', import.meta.url), 'utf8');

const rule = (selector: string): string => {
  const start = css.indexOf(selector);
  if (start === -1) return '';
  return css.slice(start, css.indexOf('}', start));
};

describe('project header actions', () => {
  test('upstream still hides the actions behind these hover classes, so the overrides keep matching', () => {
    for (const name of ['group-hover/project:opacity-100', 'group-hover/project:pr-20', 'group-hover/project:pr-14', 'group/project']) {
      expect(upstream.includes(name)).toBe(true);
    }
  });

  test('the new chat and menu buttons show without hovering, and can be clicked', () => {
    const shown = rule('[class~="group-hover/project:opacity-100"]:not(.inset-0)');
    expect(/opacity:\s*1/.test(shown)).toBe(true);
    expect(/pointer-events:\s*auto/.test(shown)).toBe(true);
  });

  test('the collapse chevron that sits over the folder icon is left to hover, so the two never overlap', () => {
    expect(css.includes(':not(.inset-0)')).toBe(true);
  });

  test('the title keeps room for the buttons that are now always there', () => {
    expect(/padding-right:\s*5rem/.test(rule('[class~="group-hover/project:pr-20"]'))).toBe(true);
    expect(/padding-right:\s*3\.5rem/.test(rule('[class~="group-hover/project:pr-14"]'))).toBe(true);
  });

  test('the buttons use a stronger colour than the faint muted one', () => {
    expect(/color:\s*color-mix\(in srgb, var\(--foreground\) 72%, transparent\)/.test(css)).toBe(true);
  });
});
