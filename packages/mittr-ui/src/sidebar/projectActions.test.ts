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
    for (const name of ['group-hover/project:opacity-100', 'group-hover/project:oc-actions-mask', 'group-hover/project:opacity-0', 'group/project', "'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground', headerCoveredFadeClass", "'ms-auto', headerCoveredFadeClass"]) {
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

  test('the header keeps the room the buttons take free, so the title and the marks end before them', () => {
    const reserved = rule('[class*="[--oc-actions-reserve:"] {');
    expect(reserved.includes('padding-inline-end: calc(var(--oc-actions-reserve, 0px) * var(--padding-scale, 1))')).toBe(true);
    for (const name of ["'[--oc-actions-reserve:4.125rem]'", "'[--oc-actions-reserve:2.375rem]'", "'[--oc-actions-reserve:0.75rem]'", ': headerActionsReserveClass,']) {
      expect(upstream.includes(name)).toBe(true);
    }
  });

  test('with that room kept free, the title is not faded a second time on hover', () => {
    const unmasked = rule('> [class*="oc-actions-mask"]');
    expect(/(^|[^-])mask-image:\s*none/.test(unmasked)).toBe(true);
    expect(/padding-inline-start:\s*0/.test(unmasked)).toBe(true);
  });

  test('the folder-missing alert, the status mark, the running action mark and the picker chevron stay visible, hovered or with the menu open', () => {
    expect(/opacity:\s*0/.test(css)).toBe(false);
    const shown = rule('> :is([class~="group-hover/project:opacity-0"], [class~="opacity-0"])');
    expect(/opacity:\s*1/.test(shown)).toBe(true);
    for (const mark of ["'inline-flex flex-shrink-0 items-center text-status-warning', headerCoveredFadeClass", "'ms-1 inline-flex flex-shrink-0 items-center', headerCoveredFadeClass", "className={cn('ms-auto', headerCoveredFadeClass)}", "'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground', headerCoveredFadeClass"]) {
      expect(upstream.includes(mark)).toBe(true);
    }
  });

  test('the buttons use a stronger colour than the faint muted one', () => {
    expect(/color:\s*color-mix\(in srgb, var\(--foreground\) 72%, transparent\)/.test(css)).toBe(true);
  });
});
