import { afterEach, describe, expect, test } from 'bun:test';

import {
  CODE_FONT_OPTIONS,
  CODE_FONT_OPTION_MAP,
  DEFAULT_MONO_FONT,
  DEFAULT_UI_FONT,
  UI_FONT_OPTIONS,
  UI_FONT_OPTION_MAP,
  isMonoFontOption,
  isUiFontOption,
} from './fontOptions';
import { loadMonoFont, loadUiFont } from './fontLoader';
import { registerProductUiPlugin, resetProductUiPluginsForTests } from './product-plugins';

const builtInUi = UI_FONT_OPTIONS.map((option) => option.id);
const builtInMono = CODE_FONT_OPTIONS.map((option) => option.id);

const extra = {
  ui: [{ id: 'acme-sans', label: 'Acme Sans', description: 'A sans face a product bundles.', stack: '"Acme Sans", sans-serif' }],
  mono: [{ id: 'acme-mono', label: 'Acme Mono', description: 'A mono face a product bundles.', stack: '"Acme Mono", monospace' }],
};

afterEach(() => {
  resetProductUiPluginsForTests();
});

describe('font options a product plugin contributes', () => {
  test('without a plugin the lists are the built-in ones', () => {
    expect(UI_FONT_OPTIONS.map((option) => option.id)).toEqual(builtInUi);
    expect(CODE_FONT_OPTIONS.map((option) => option.id)).toEqual(builtInMono);
    expect(isUiFontOption('acme-sans')).toBe(false);
    expect(isMonoFontOption('acme-mono')).toBe(false);
  });

  test('a registered plugin adds its options to the pickers, the lookups and the guards', () => {
    registerProductUiPlugin({ id: 'acme', fontOptions: extra });
    expect(UI_FONT_OPTIONS.map((option) => option.id)).toEqual(['acme-sans', ...builtInUi]);
    expect(CODE_FONT_OPTIONS.map((option) => option.id)).toEqual(['acme-mono', ...builtInMono]);
    expect(UI_FONT_OPTION_MAP['acme-sans'].stack).toBe('"Acme Sans", sans-serif');
    expect(CODE_FONT_OPTION_MAP['acme-mono'].stack).toBe('"Acme Mono", monospace');
    expect(isUiFontOption('acme-sans')).toBe(true);
    expect(isMonoFontOption('acme-mono')).toBe(true);
    expect(isUiFontOption('acme-mono')).toBe(false);
    expect(DEFAULT_UI_FONT).toBe('system');
    expect(DEFAULT_MONO_FONT).toBe('system-mono');
  });

  test('registering a plugin again replaces its options, and they go when the plugin does', () => {
    registerProductUiPlugin({ id: 'acme', fontOptions: extra });
    registerProductUiPlugin({ id: 'acme', fontOptions: { ui: [] } });
    expect(UI_FONT_OPTIONS.map((option) => option.id)).toEqual(builtInUi);
    expect(CODE_FONT_OPTIONS.map((option) => option.id)).toEqual(builtInMono);
    registerProductUiPlugin({ id: 'acme', fontOptions: extra });
    resetProductUiPluginsForTests();
    expect(UI_FONT_OPTIONS.map((option) => option.id)).toEqual(builtInUi);
    expect(UI_FONT_OPTION_MAP['acme-sans' as never]).toBeUndefined();
  });

  test('a plugin cannot replace a built-in option, repeat an id or add one with no id or stack', () => {
    registerProductUiPlugin({
      id: 'first',
      fontOptions: {
        ui: [
          { id: 'inter', label: 'Not Inter', description: '', stack: 'serif' },
          { id: 'dup', label: 'One', description: '', stack: 'serif' },
          { id: 'dup', label: 'Two', description: '', stack: 'serif' },
          { id: '', label: 'Empty', description: '', stack: 'serif' },
          { id: 'no-stack', label: 'No stack', description: '', stack: '' },
        ],
      },
    });
    registerProductUiPlugin({ id: 'second', fontOptions: { ui: [{ id: 'dup', label: 'Three', description: '', stack: 'serif' }] } });
    expect(UI_FONT_OPTIONS.map((option) => option.id)).toEqual(['dup', ...builtInUi]);
    expect(UI_FONT_OPTION_MAP.inter.label).toBe('Inter');
    expect(UI_FONT_OPTION_MAP['dup' as never].label).toBe('One');
  });

  test('a contributed option has no source, so choosing it loads nothing from the network', async () => {
    const created: string[] = [];
    const added: unknown[] = [];
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = { FontFace: scope.FontFace, document: scope.document };
    scope.FontFace = class { constructor(family: string) { created.push(family); } load() { return Promise.resolve(this); } };
    scope.document = { fonts: { add: (face: unknown) => added.push(face), delete: () => undefined } };
    try {
      registerProductUiPlugin({ id: 'acme', fontOptions: extra });
      expect(UI_FONT_OPTION_MAP['acme-sans' as never].source).toBeUndefined();
      expect(CODE_FONT_OPTION_MAP['acme-mono' as never].source).toBeUndefined();
      await loadUiFont('acme-sans');
      await loadMonoFont('acme-mono');
      expect(created).toEqual([]);
      expect(added).toEqual([]);
      void loadUiFont('inter');
      expect(created.length).toBeGreaterThan(0);
    } finally {
      scope.FontFace = previous.FontFace;
      scope.document = previous.document;
    }
  });
});
