import { describe, expect, test } from 'bun:test';
import type { Theme } from '@/types/theme';
import { CSSVariableGenerator } from './cssGenerator';
import mittrcraftDark from './themes/mittrcraft-dark.json';
import mittrcraftLight from './themes/mittrcraft-light.json';

const readVar = (css: string, name: string): string | undefined => {
  const line = css.split('\n').find((entry) => entry.trim().startsWith(`${name}:`));
  return line?.trim().slice(name.length + 1).replace(/;$/, '').trim();
};

const generate = (theme: Theme): string => new CSSVariableGenerator().generate(theme);

const withoutDesignTokens = (theme: Theme): Theme => {
  const colors = { ...theme.colors };
  delete colors.elevation;
  delete colors.gradients;
  return { ...theme, colors };
};

describe('elevation tokens', () => {
  test('emits the declared elevation steps for the dark theme', () => {
    const css = generate(mittrcraftDark as Theme);

    expect(readVar(css, '--elev-1')).toBe('0 1px 2px rgb(9 20 36 / .40)');
    expect(readVar(css, '--elev-2')).toBe('0 4px 14px rgb(9 20 36 / .50)');
    expect(readVar(css, '--elev-3')).toBe('0 16px 40px rgb(9 20 36 / .62)');
  });

  test('emits the declared elevation steps for the light theme', () => {
    const css = generate(mittrcraftLight as Theme);

    expect(readVar(css, '--elev-1')).toBe('0 1px 2px rgb(9 20 36 / .06)');
    expect(readVar(css, '--elev-2')).toBe('0 4px 14px rgb(9 20 36 / .10)');
    expect(readVar(css, '--elev-3')).toBe('0 16px 40px rgb(9 20 36 / .18)');
  });

  test('falls back to variant-appropriate elevation when a theme declares none', () => {
    const darkCss = generate(withoutDesignTokens(mittrcraftDark as Theme));
    const lightCss = generate(withoutDesignTokens(mittrcraftLight as Theme));

    expect(readVar(darkCss, '--elev-2')).toBe('0 4px 14px rgb(9 20 36 / .50)');
    expect(readVar(lightCss, '--elev-2')).toBe('0 4px 14px rgb(9 20 36 / .10)');
  });
});

describe('gradient tokens', () => {
  test('emits the declared gradients for both MittrCraft themes', () => {
    const darkCss = generate(mittrcraftDark as Theme);
    const lightCss = generate(mittrcraftLight as Theme);

    expect(readVar(darkCss, '--grad-accent')).toBe(
      'linear-gradient(140deg, #7fd7ff 0%, #38bdf8 52%, #6f8cff 100%)',
    );
    expect(readVar(darkCss, '--grad-accent-hover')).toBe(
      'linear-gradient(140deg, #9ce2ff 0%, #55c8fa 52%, #869dff 100%)',
    );
    expect(readVar(darkCss, '--grad-brand')).toBe('linear-gradient(145deg, #7fd7ff 0%, #7c6bff 100%)');
    expect(readVar(darkCss, '--grad-sheen')).toBe('linear-gradient(180deg, #ffffff17, #fff0 42%)');

    expect(readVar(lightCss, '--grad-accent')).toBe(
      'linear-gradient(140deg, #0a689e 0%, #086193 52%, #05486e 100%)',
    );
    expect(readVar(lightCss, '--grad-brand')).toBe('linear-gradient(145deg, #086193 0%, #5b4bd6 100%)');
  });

  test('derives gradients from the primary ramp when a theme declares none', () => {
    const css = generate(withoutDesignTokens(mittrcraftDark as Theme));

    expect(readVar(css, '--grad-accent')).toBe(
      'linear-gradient(140deg, #7fd7ff 0%, #38bdf8 52%, #a8e2ff 100%)',
    );
    expect(readVar(css, '--grad-sheen')).toBe('linear-gradient(180deg, #ffffff17, #fff0 42%)');
  });
});

test('elevation is the only shadow mechanism the theme emits', () => {
  const css = generate(mittrcraftDark as Theme);

  expect(css).not.toContain('--shadow-');
  expect(css).not.toContain('--spacing-');
});
