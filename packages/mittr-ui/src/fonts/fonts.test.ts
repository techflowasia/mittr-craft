import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODE_FONT_OPTION_MAP, CODE_FONT_OPTIONS, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, isMonoFontOption, isUiFontOption, UI_FONT_OPTION_MAP, UI_FONT_OPTIONS } from '../../../ui/src/lib/fontOptions';
import { loadMonoFont, loadUiFont } from '../../../ui/src/lib/fontLoader';
import '../product-ui-plugin';
import { createFontChoices, plexClassesFor } from './defaultFonts';

const here = dirname(fileURLToPath(import.meta.url));
const pins: {
  files: Array<{ name: string; version: string; sha256: string; bytes: number }>;
  licence: { sha256: string };
  notice: { heading: string; sha256: string };
} = JSON.parse(readFileSync(join(here, 'fonts.json'), 'utf8'));
const css = readFileSync(join(here, 'plex.css'), 'utf8');
const notices = readFileSync(join(here, '../../../../brand/THIRD_PARTY_NOTICES.md'), 'utf8');
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

const section = (heading: string): string => {
  const start = notices.indexOf(`\n## ${heading}\n`);
  const next = notices.indexOf('\n## ', start + heading.length + 4);
  return notices.slice(start + 1, next === -1 ? notices.length : next + 1);
};

describe('the bundled IBM Plex files', () => {
  test('are exactly the pinned files from @ibm/plex 6.4.1, and nothing else sits beside them', () => {
    for (const file of pins.files) {
      const bytes = readFileSync(join(here, file.name));
      expect([file.name, file.version, sha256(bytes), bytes.length]).toEqual([file.name, '6.4.1', file.sha256, file.bytes]);
    }
    const woff2 = readdirSync(here).filter((name) => name.endsWith('.woff2')).sort();
    expect(woff2).toEqual(pins.files.map((file) => file.name).sort());
  });

  test('the notice carries the package\'s own licence text, and its section is pinned', () => {
    const text = section(pins.notice.heading);
    expect(sha256(text)).toBe(pins.notice.sha256);
    const marker = 'with its CRLF line ends written as LF.\n\n';
    const licence = text.slice(text.indexOf(marker) + marker.length, -1);
    expect(sha256(licence.replace(/\n/g, '\r\n'))).toBe(pins.licence.sha256);
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
    for (const file of pins.files) expect(text).toContain(`\`${file.name}\``);
  });

  test('plex.css loads every file from beside it, never from the network, at the weights 1.22 used', () => {
    expect(/url\(\s*['"]?(?:https?:)?\/\//i.test(css)).toBe(false);
    expect(css).not.toContain('@import');
    const urls = [...css.matchAll(/url\("\.\/([^"]+)"\) format\("woff2"\)/g)].map((match) => match[1]).sort();
    expect(urls).toEqual(pins.files.map((file) => file.name).sort());
    const weights = [...css.matchAll(/font-weight:\s*(\d+);/g)].map((match) => Number(match[1]));
    expect([...new Set(weights)].sort()).toEqual([400, 500, 600]);
    expect(css.match(/font-display:\s*swap;/g)?.length).toBe(pins.files.length);
  });

  test('Thai text falls to IBM Plex Sans Thai, then the system\'s Thai face, in both stacks', () => {
    expect(/font-family: "IBM Plex Sans Thai";[^}]*unicode-range: U\+0E00-0E7F/.test(css)).toBe(true);
    const sans = /--font-sans: ([^;]+) !important;/.exec(css)?.[1] ?? '';
    const mono = /--font-mono: ([^;]+) !important;/.exec(css)?.[1] ?? '';
    expect(sans.startsWith('"IBM Plex Sans", "IBM Plex Sans Thai",')).toBe(true);
    expect(mono.startsWith('"IBM Plex Mono",')).toBe(true);
    for (const stack of [sans, mono]) {
      expect(stack).toContain('"IBM Plex Sans Thai"');
      expect(stack).toContain('Thonburi');
    }
  });

  test('the faces apply only while their class is on the page', () => {
    const selectors = [...css.replace(/@font-face\s*\{[^}]*\}/g, '').matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim());
    expect(selectors.length).toBe(3);
    for (const selector of selectors) expect(selector.startsWith('html.mittr-plex-')).toBe(true);
  });
});

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
};

describe('when Plex is the font', () => {
  test('the upstream defaults get Plex, and any other choice keeps its own font', () => {
    const choices = createFontChoices(memoryStorage());
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT }, choices)).toEqual(['mittr-plex-sans', 'mittr-plex-mono']);
    expect(plexClassesFor({ uiFont: 'inter', monoFont: DEFAULT_MONO_FONT }, choices)).toEqual(['mittr-plex-mono']);
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: 'jetbrains-mono' }, choices)).toEqual(['mittr-plex-sans']);
    expect(plexClassesFor({ uiFont: 'inter', monoFont: 'fira-code' }, choices)).toEqual([]);
  });

  test('a person who picks the system font from another font keeps the system font, after a restart too', () => {
    const storage = memoryStorage();
    const choices = createFontChoices(storage);
    choices.observe({ uiFont: 'inter', monoFont: DEFAULT_MONO_FONT }, { uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT });
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT }, choices)).toEqual(['mittr-plex-mono']);
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT }, createFontChoices(storage))).toEqual(['mittr-plex-mono']);
    choices.observe({ uiFont: DEFAULT_UI_FONT, monoFont: 'fira-code' }, { uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT });
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT }, choices)).toEqual([]);
  });

  test('without storage the defaults still get Plex', () => {
    const choices = createFontChoices(null);
    choices.observe({ uiFont: 'inter', monoFont: DEFAULT_MONO_FONT }, { uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT });
    expect(plexClassesFor({ uiFont: 'inter', monoFont: DEFAULT_MONO_FONT }, createFontChoices(null))).toEqual(['mittr-plex-mono']);
  });
});

const UI_STACK = '"IBM Plex Sans", "IBM Plex Sans Thai", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO_STACK = '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, "IBM Plex Sans Thai", Thonburi, monospace';

describe('IBM Plex in the font pickers', () => {
  test('both faces are listed first, in the pickers and in the lookups, with the stacks that put Plex before the Thai face', () => {
    expect(UI_FONT_OPTIONS[0]).toEqual(UI_FONT_OPTION_MAP['ibm-plex-sans']);
    expect(CODE_FONT_OPTIONS[0]).toEqual(CODE_FONT_OPTION_MAP['ibm-plex-mono']);
    expect(UI_FONT_OPTION_MAP['ibm-plex-sans'].label).toBe('IBM Plex Sans');
    expect(CODE_FONT_OPTION_MAP['ibm-plex-mono'].label).toBe('IBM Plex Mono');
    expect(UI_FONT_OPTION_MAP['ibm-plex-sans'].stack).toBe(UI_STACK);
    expect(CODE_FONT_OPTION_MAP['ibm-plex-mono'].stack).toBe(MONO_STACK);
    expect(isUiFontOption('ibm-plex-sans')).toBe(true);
    expect(isMonoFontOption('ibm-plex-mono')).toBe(true);
  });

  test('their families are the ones plex.css loads from beside it, and choosing them loads nothing from the network', async () => {
    for (const family of ['IBM Plex Sans', 'IBM Plex Sans Thai', 'IBM Plex Mono']) expect(css).toContain(`font-family: "${family}";`);
    expect(UI_FONT_OPTION_MAP['ibm-plex-sans'].source).toBeUndefined();
    expect(CODE_FONT_OPTION_MAP['ibm-plex-mono'].source).toBeUndefined();
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = { FontFace: scope.FontFace, document: scope.document };
    const created: string[] = [];
    scope.FontFace = class { constructor(family: string) { created.push(family); } load() { return Promise.resolve(this); } };
    scope.document = { fonts: { add: () => undefined, delete: () => undefined } };
    try {
      await loadUiFont('ibm-plex-sans');
      await loadMonoFont('ibm-plex-mono');
    } finally {
      scope.FontFace = previous.FontFace;
      scope.document = previous.document;
    }
    expect(created).toEqual([]);
  });

  test('picking one is a choice of its own: the default-only Plex class steps aside and the picked stack applies', () => {
    const choices = createFontChoices(memoryStorage());
    expect(plexClassesFor({ uiFont: 'ibm-plex-sans', monoFont: 'ibm-plex-mono' }, choices)).toEqual([]);
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: 'ibm-plex-mono' }, choices)).toEqual(['mittr-plex-sans']);
    expect(plexClassesFor({ uiFont: 'ibm-plex-sans', monoFont: DEFAULT_MONO_FONT }, choices)).toEqual(['mittr-plex-mono']);
    choices.observe({ uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT }, { uiFont: 'ibm-plex-sans', monoFont: 'ibm-plex-mono' });
    choices.observe({ uiFont: 'ibm-plex-sans', monoFont: 'ibm-plex-mono' }, { uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT });
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT }, choices)).toEqual([]);
  });

  test('while the setting is untouched the defaults are still the upstream ones and still get Plex', () => {
    expect(DEFAULT_UI_FONT).toBe('system');
    expect(DEFAULT_MONO_FONT).toBe('system-mono');
    expect(plexClassesFor({ uiFont: DEFAULT_UI_FONT, monoFont: DEFAULT_MONO_FONT }, createFontChoices(null))).toEqual(['mittr-plex-sans', 'mittr-plex-mono']);
  });
});
