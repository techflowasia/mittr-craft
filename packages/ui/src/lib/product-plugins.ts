import React from 'react';

import type { Locale } from './i18n/runtime';
import type { I18nDictionary } from './i18n/store';
import type { Message, Part } from './opencode/model';

// A product plugin lets a build that bundles this UI rebrand it without
// editing UI source: it can overlay translation strings, rewrite words across
// every string it did not overlay, and replace the logo. It can also wrap the
// app root, render into named slots, decorate the model picker, reword
// message errors and keep the window from downloading the public model
// catalog itself. Plugins are collected at build time by the entry points and
// register themselves on import. With no plugin registered every function here
// is a pass-through and every slot renders nothing.

type ProductSurface = 'main' | 'mini-chat';

export type SessionAuthRuntime = 'web' | 'desktop-local' | 'desktop-remote';

export type SessionAuthMethodsProps = {
  isTunnelLocked: boolean;
  runtime: SessionAuthRuntime;
  onSignedIn: (clientToken?: string) => Promise<boolean>;
};

export type ProductSlotProps = {
  'sidebar-footer': Record<never, never>;
  'about-dialog': Record<never, never>;
  'about-settings': Record<never, never>;
  'providers-page': Record<never, never>;
  'integrations-page': Record<never, never>;
  'session-auth-methods': SessionAuthMethodsProps;
  'assistant-message-footer': { message: { info: Message; parts: Part[] }; isLatestTurn: boolean };
  'composer-actions': { isMobile: boolean; footerIconButtonClass: string; iconSizeClass: string; dictationActive: boolean };
  'main-surface': Record<never, never>;
};

export type ProductSlotName = keyof ProductSlotProps;

export type ProductSlotComponent<K extends ProductSlotName> = React.ComponentType<ProductSlotProps[K]>;

export type ModelEntryStatus = { pill: string; title?: string; tone: 'neutral' | 'near'; blocked: boolean };

export type ModelPickerDecorations = {
  isProviderShown(providerId: string): boolean;
  entryStatus(entry: { providerID: string; modelID: string; name: string }): ModelEntryStatus | null;
  // false hides the picker's "Add new provider" row.
  offersAddProvider?: boolean;
};

type UseModelPickerDecorations = (open: boolean) => ModelPickerDecorations;

export type DictationBlock = { blocked: boolean; reason?: string };

type UseDictationBlock = () => DictationBlock;

type ProductSessionAuthContext = { passwordEnabled: boolean; runtime: SessionAuthRuntime };

type ProductMessageError = { type: string; message: string; status?: number; responseBody?: string; providerID?: string };

export type ProductUiPlugin = {
  id: string;
  dictionaries?: Partial<Record<Locale, Partial<I18nDictionary>>>;
  substitutions?: ReadonlyArray<readonly [from: string, to: string]>;
  logo?: React.ComponentType<React.SVGProps<SVGSVGElement> & { className?: string }>;
  rootWrapper?: React.ComponentType<{ children: React.ReactNode; surface: ProductSurface }>;
  slots?: { [K in ProductSlotName]?: ProductSlotComponent<K> | ProductSlotComponent<K>[] };
  modelPicker?: { useDecorations: UseModelPickerDecorations };
  composer?: { useDictationBlock: UseDictationBlock };
  messageError?: (error: ProductMessageError) => string | null;
  sessionAuthDescription?: (context: ProductSessionAuthContext) => string | null;
  // false: the window never asks models.dev for model metadata or provider
  // logos; it uses what the server answers and the logos bundled with the UI.
  remoteModelCatalog?: boolean;
};

type Substitution = { pattern: RegExp; to: string };

const passThroughDecorations: ModelPickerDecorations = {
  isProviderShown: () => true,
  entryStatus: () => null,
};

const usePassThroughDecorations: UseModelPickerDecorations = () => passThroughDecorations;

const notBlocked: DictationBlock = { blocked: false };

const useNoDictationBlock: UseDictationBlock = () => notBlocked;

let plugins: ProductUiPlugin[] = [];
let substitutions: Substitution[] = [];
let pickerHooks: UseModelPickerDecorations[] = [];
let useComposedDecorations: UseModelPickerDecorations = usePassThroughDecorations;
let pickerHookInUse = false;
let dictationBlockHooks: UseDictationBlock[] = [];
let useComposedDictationBlock: UseDictationBlock = useNoDictationBlock;
let dictationBlockHookInUse = false;
const overlaid = new Map<Locale, { source: I18nDictionary; result: I18nDictionary }>();
const listeners = new Set<() => void>();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compileSubstitutions = (): Substitution[] =>
  plugins.flatMap((plugin) => (plugin.substitutions ?? []).map(([from, to]) => ({
    pattern: new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'),
    to,
  })));

const combineDecorationHooks = (
  useFirst: UseModelPickerDecorations,
  useSecond: UseModelPickerDecorations,
): UseModelPickerDecorations => {
  function useCombinedDecorations(open: boolean): ModelPickerDecorations {
    const first = useFirst(open);
    const second = useSecond(open);
    return React.useMemo(() => ({
      isProviderShown: (providerId) => first.isProviderShown(providerId) && second.isProviderShown(providerId),
      entryStatus: (entry) => first.entryStatus(entry) ?? second.entryStatus(entry),
      offersAddProvider: first.offersAddProvider !== false && second.offersAddProvider !== false,
    }), [first, second]);
  }
  return useCombinedDecorations;
};

const sameHooks = (left: UseModelPickerDecorations[], right: UseModelPickerDecorations[]): boolean =>
  left.length === right.length && left.every((hook, index) => hook === right[index]);

// The model picker calls one hook, composed here from every plugin's hook, so
// the number and order of hooks stay fixed per render. Once the picker has
// called it, swapping it would change that number under a mounted picker, so a
// picker plugin registered later is ignored until the next load.
const updateDecorationHooks = (): void => {
  const next = plugins.flatMap((plugin) => (plugin.modelPicker ? [plugin.modelPicker.useDecorations] : []));
  if (sameHooks(next, pickerHooks)) {
    return;
  }
  if (pickerHookInUse) {
    if (typeof console !== 'undefined' && import.meta.env?.DEV) {
      console.warn('[product-plugins] a model-picker plugin registered after the picker rendered; its decorations are ignored until reload');
    }
    return;
  }
  pickerHooks = next;
  useComposedDecorations = next.length === 0 ? usePassThroughDecorations : next.reduce(combineDecorationHooks);
};

const guardDictationBlock = (useBlock: UseDictationBlock): UseDictationBlock => {
  function useGuardedDictationBlock(): DictationBlock {
    try {
      return useBlock();
    } catch {
      return notBlocked;
    }
  }
  return useGuardedDictationBlock;
};

const combineDictationBlocks = (useFirst: UseDictationBlock, useSecond: UseDictationBlock): UseDictationBlock => {
  function useCombinedDictationBlock(): DictationBlock {
    const first = useFirst();
    const second = useSecond();
    return first.blocked ? first : second;
  }
  return useCombinedDictationBlock;
};

const updateDictationBlockHooks = (): void => {
  const next = plugins.flatMap((plugin) => (plugin.composer ? [plugin.composer.useDictationBlock] : []));
  if (next.length === dictationBlockHooks.length && next.every((hook, index) => hook === dictationBlockHooks[index])) {
    return;
  }
  if (dictationBlockHookInUse) {
    if (import.meta.env?.DEV) {
      console.warn('[product-plugins] a dictation-block plugin registered after the composer rendered; its block is ignored until reload');
    }
    return;
  }
  dictationBlockHooks = next;
  useComposedDictationBlock = next.length === 0 ? useNoDictationBlock : next.map(guardDictationBlock).reduce(combineDictationBlocks);
};

const changed = (): void => {
  substitutions = compileSubstitutions();
  updateDecorationHooks();
  updateDictationBlockHooks();
  overlaid.clear();
  listeners.forEach((listener) => listener());
};

export function registerProductUiPlugin(plugin: ProductUiPlugin): void {
  plugins = [...plugins.filter((existing) => existing.id !== plugin.id), plugin];
  changed();
}

export function resetProductUiPluginsForTests(): void {
  plugins = [];
  pickerHookInUse = false;
  dictationBlockHookInUse = false;
  changed();
}

// The English dictionary and the lazily loaded locales are read by the i18n
// store before or after a plugin registers, depending on module evaluation
// order. The store therefore keeps raw dictionaries, reads them through
// `overlayDictionary`, and refreshes its live state from this subscription.
export function subscribeProductUiPlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function overlayDictionary(locale: Locale, dict: I18nDictionary): I18nDictionary {
  if (plugins.length === 0) {
    return dict;
  }

  const cached = overlaid.get(locale);
  if (cached && cached.source === dict) {
    return cached.result;
  }

  const overrides: Partial<I18nDictionary> = {};
  for (const plugin of plugins) {
    Object.assign(overrides, plugin.dictionaries?.[locale]);
  }

  const result = { ...dict };
  // SAFETY: `result` is a copy of `dict`, so its own keys are exactly the I18nKey set.
  for (const key of Object.keys(result) as Array<keyof I18nDictionary>) {
    if (Object.hasOwn(overrides, key)) {
      continue;
    }
    result[key] = substitutions.reduce(
      (value, { pattern, to }) => value.replace(pattern, () => to),
      result[key],
    );
  }
  Object.assign(result, overrides);

  overlaid.set(locale, { source: dict, result });
  return result;
}

export function remoteModelCatalogAllowed(): boolean {
  return plugins.every((plugin) => plugin.remoteModelCatalog !== false);
}

export function getProductLogo(): ProductUiPlugin['logo'] | undefined {
  for (let index = plugins.length - 1; index >= 0; index -= 1) {
    const logo = plugins[index].logo;
    if (logo) {
      return logo;
    }
  }
  return undefined;
}

const getPluginsSnapshot = (): ProductUiPlugin[] => plugins;

// Plugins normally register before the first render. One registered later
// still reaches every mounted root and slot through this subscription: a slot
// it fills renders in place, but a rootWrapper it adds changes the elements
// above the app, so React remounts the app.
const useProductUiPlugins = (): ProductUiPlugin[] =>
  React.useSyncExternalStore(subscribeProductUiPlugins, getPluginsSnapshot, getPluginsSnapshot);

export function ProductRoot({ surface, children }: { surface: ProductSurface; children: React.ReactNode }): React.ReactNode {
  const current = useProductUiPlugins();
  return current.reduceRight<React.ReactNode>(
    (inner, plugin) => (plugin.rootWrapper ? React.createElement(plugin.rootWrapper, { surface, children: inner }) : inner),
    children,
  );
}

export function ProductSlot<K extends ProductSlotName>({ name, ...props }: { name: K } & ProductSlotProps[K]): React.ReactNode {
  const current = useProductUiPlugins();
  const elements = current.flatMap((plugin) => {
    const filled = plugin.slots?.[name];
    const components = filled === undefined ? [] : Array.isArray(filled) ? filled : [filled];
    return components.map((component, index) => React.createElement(
      component,
      { ...props, key: `${plugin.id}:${index}` },
    ));
  });
  return elements.length === 0 ? null : elements;
}

export function useProductModelPicker(open: boolean): ModelPickerDecorations {
  pickerHookInUse = true;
  return useComposedDecorations(open);
}

export function useProductDictationBlock(): DictationBlock {
  dictationBlockHookInUse = true;
  return useComposedDictationBlock();
}

export function translateProductMessageError(error: ProductMessageError): string | null {
  for (const plugin of plugins) {
    const translated = plugin.messageError?.(error) ?? null;
    if (translated !== null) {
      return translated;
    }
  }
  return null;
}

export function translateProductSessionAuthDescription(context: ProductSessionAuthContext): string | null {
  for (const plugin of plugins) {
    const description = plugin.sessionAuthDescription?.(context) ?? null;
    if (description !== null) {
      return description;
    }
  }
  return null;
}
