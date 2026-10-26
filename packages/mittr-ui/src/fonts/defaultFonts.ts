import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, isMonoFontOption, isUiFontOption, type MonoFontOption, type UiFontOption } from '../../../ui/src/lib/fontOptions';

export type FontPicks = { uiFont: UiFontOption; monoFont: MonoFontOption };

type FontKind = 'sans' | 'mono';

const CHOSEN_KEY = {
  sans: 'mittr.fonts.systemSansChosen',
  mono: 'mittr.fonts.systemMonoChosen',
} satisfies Record<FontKind, string>;

const PLEX_CLASS = { sans: 'mittr-plex-sans', mono: 'mittr-plex-mono' } satisfies Record<FontKind, string>;

export type FontChoices = {
  systemChosen: (kind: FontKind) => boolean;
  observe: (previous: FontPicks, next: FontPicks) => void;
};

export function createFontChoices(storage: Storage | null): FontChoices {
  const remembered = new Map<FontKind, boolean>();
  const systemChosen = (kind: FontKind): boolean => {
    const known = remembered.get(kind);
    if (known !== undefined) return known;
    try {
      return storage?.getItem(CHOSEN_KEY[kind]) === '1';
    } catch {
      return false;
    }
  };
  const remember = (kind: FontKind, chosen: boolean): void => {
    remembered.set(kind, chosen);
    try {
      if (chosen) storage?.setItem(CHOSEN_KEY[kind], '1');
      else storage?.removeItem(CHOSEN_KEY[kind]);
    } catch {
      return;
    }
  };
  return {
    systemChosen,
    observe: (previous, next) => {
      if (previous.uiFont !== next.uiFont) remember('sans', next.uiFont === DEFAULT_UI_FONT);
      if (previous.monoFont !== next.monoFont) remember('mono', next.monoFont === DEFAULT_MONO_FONT);
    },
  };
}

const onDefaultSans = (font: UiFontOption): boolean => font === DEFAULT_UI_FONT || !isUiFontOption(font);
const onDefaultMono = (font: MonoFontOption): boolean => font === DEFAULT_MONO_FONT || !isMonoFontOption(font);

export function plexClassesFor(picks: FontPicks, choices: FontChoices): string[] {
  return [
    ...(onDefaultSans(picks.uiFont) && !choices.systemChosen('sans') ? [PLEX_CLASS.sans] : []),
    ...(onDefaultMono(picks.monoFont) && !choices.systemChosen('mono') ? [PLEX_CLASS.mono] : []),
  ];
}
