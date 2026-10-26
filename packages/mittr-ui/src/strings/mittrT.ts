import { mittrEn } from './mittr.en';

export type MittrKey = keyof typeof mittrEn;

export type MittrParams = Readonly<Partial<Record<string, string | number>>>;

export function mittrT(key: MittrKey, vars?: MittrParams): string {
  const template = mittrEn[key];
  if (!vars) return template;
  return template.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    const value = vars[name.trim()];
    return value === undefined ? match : String(value);
  });
}

// Mittr text does not follow the UI locale, so there is nothing to re-render
// on a locale change; the hook exists so components read it the same way.
export function useMittrT(): typeof mittrT {
  return mittrT;
}
