import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dict as enDict } from './i18n/messages/en';
import { dict as esDict } from './i18n/messages/es';
import { formatMessage, resetI18nDictionaryCacheForTests, useI18nStore, type I18nDictionary } from './i18n/store';
import {
  getProductLogo,
  overlayDictionary,
  ProductRoot,
  ProductSlot,
  registerProductUiPlugin,
  remoteModelCatalogAllowed,
  resetProductUiPluginsForTests,
  translateProductMessageError,
  useProductModelPicker,
  type ModelPickerDecorations,
  type ProductSlotComponent,
  type ProductSlotProps,
} from './product-plugins';

const ABOUT_KEY = 'aboutDialog.openChamberVersionLabel';
const AND_KEY = 'aboutDialog.openCodeVersionLabel';
const MISSING_KEY = 'does.not.exist' as keyof I18nDictionary;

afterEach(() => {
  resetProductUiPluginsForTests();
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({ locale: 'en', dictionary: enDict, loadingLocale: null });
});

const waitForLocale = async (locale: 'es') => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = useI18nStore.getState();
    if (state.locale === locale && state.loadingLocale === null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${locale}`);
};

describe('product UI plugins', () => {
  test('overlay wins over upstream value', () => {
    registerProductUiPlugin({
      id: 'test',
      substitutions: [['OpenChamber', 'Acme']],
      dictionaries: { en: { [ABOUT_KEY]: 'Custom {version}' } },
    });

    expect(overlayDictionary('en', enDict)[ABOUT_KEY]).toBe('Custom {version}');
  });

  test('substitution rewrites a value not overlaid', () => {
    registerProductUiPlugin({
      id: 'test',
      substitutions: [['OpenChamber', 'Acme'], ['OpenCode', 'Acme Engine']],
    });

    const overlaid = overlayDictionary('en', enDict);
    expect(overlaid[ABOUT_KEY]).toBe('Acme version {version}');
    expect(overlaid[AND_KEY]).toBe('Acme Engine version {version}');
  });

  test('substitution is whole-word and case-sensitive', () => {
    registerProductUiPlugin({ id: 'test', substitutions: [['Open', 'Closed']] });

    const source = { ...enDict, [ABOUT_KEY]: 'Open OpenChamber openchamber Opening' };
    expect(overlayDictionary('en', source)[ABOUT_KEY]).toBe('Closed OpenChamber openchamber Opening');
  });

  test('English seen before registration is overlaid after registration', () => {
    const before = formatMessage(useI18nStore.getState().dictionary, ABOUT_KEY, { version: '1' });
    expect(before).toBe('OpenChamber version 1');

    registerProductUiPlugin({ id: 'test', substitutions: [['OpenChamber', 'Acme']] });

    const after = formatMessage(useI18nStore.getState().dictionary, ABOUT_KEY, { version: '1' });
    expect(after).toBe('Acme version 1');
  });

  test('formatMessage fallback to English is overlaid', () => {
    expect(formatMessage({} as I18nDictionary, ABOUT_KEY, { version: '1' })).toBe('OpenChamber version 1');

    registerProductUiPlugin({ id: 'test', substitutions: [['OpenChamber', 'Acme']] });

    expect(formatMessage({} as I18nDictionary, ABOUT_KEY, { version: '1' })).toBe('Acme version 1');
    expect(formatMessage({} as I18nDictionary, MISSING_KEY)).toBe('does.not.exist');
  });

  test('no plugins leaves dictionaries identical', () => {
    expect(overlayDictionary('en', enDict)).toBe(enDict);
    expect(getProductLogo()).toBeUndefined();
  });

  test('the logo of the registered plugin is returned', () => {
    const Logo = () => null;
    registerProductUiPlugin({ id: 'test', logo: Logo });

    expect(getProductLogo()).toBe(Logo);
  });

  test('registering the same id again replaces the plugin', () => {
    registerProductUiPlugin({ id: 'test', substitutions: [['OpenChamber', 'First']] });
    registerProductUiPlugin({ id: 'test', substitutions: [['OpenChamber', 'Second']] });

    expect(overlayDictionary('en', enDict)[ABOUT_KEY]).toBe('Second version {version}');
  });

  test('a lazily loaded locale is overlaid whether the plugin registered before or after it loaded', async () => {
    registerProductUiPlugin({ id: 'test', substitutions: [['OpenChamber', 'Acme']] });
    useI18nStore.getState().setLocale('es');
    await waitForLocale('es');

    const expected = esDict[ABOUT_KEY].replace(/\bOpenChamber\b/g, 'Acme');
    expect(expected).not.toBe(esDict[ABOUT_KEY]);
    expect(useI18nStore.getState().dictionary[ABOUT_KEY]).toBe(expected);

    resetProductUiPluginsForTests();
    expect(useI18nStore.getState().dictionary[ABOUT_KEY]).toBe(esDict[ABOUT_KEY]);

    registerProductUiPlugin({ id: 'test', substitutions: [['OpenChamber', 'Acme']] });
    expect(useI18nStore.getState().dictionary[ABOUT_KEY]).toBe(expected);
  });
});

const ENTRY = { providerID: 'openai', modelID: 'gpt-x', name: 'GPT X' };

const readModelPicker = (open: boolean): ModelPickerDecorations => {
  let decorations: ModelPickerDecorations | undefined;
  const Probe = () => {
    decorations = useProductModelPicker(open);
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  if (!decorations) {
    throw new Error('the probe did not render');
  }
  return decorations;
};

describe('product UI plugin root and slots', () => {
  test('no plugin leaves the tree unchanged', () => {
    const markup = renderToStaticMarkup(createElement(ProductRoot, { surface: 'main', children: createElement('b', null, 'x') }));

    expect(markup).toBe('<b>x</b>');
  });

  test('wrappers nest in registration order', () => {
    const surfaces: string[] = [];
    registerProductUiPlugin({
      id: 'p1',
      rootWrapper: ({ children, surface }) => {
        surfaces.push(surface);
        return createElement('i', { 'data-p1': '' }, children);
      },
    });
    registerProductUiPlugin({
      id: 'p2',
      rootWrapper: ({ children }) => createElement('u', { 'data-p2': '' }, children),
    });

    const markup = renderToStaticMarkup(createElement(ProductRoot, { surface: 'mini-chat', children: createElement('b', null, 'x') }));

    expect(markup).toBe('<i data-p1=""><u data-p2=""><b>x</b></u></i>');
    expect(surfaces).toEqual(['mini-chat']);
  });

  test("a slot renders every plugin's component with its props", () => {
    const seen: string[] = [];
    const methods = (label: string): ProductSlotComponent<'session-auth-methods'> => ({ isTunnelLocked, runtime }) => {
      seen.push(`${String(isTunnelLocked)}:${runtime}`);
      return createElement('span', null, label);
    };
    registerProductUiPlugin({ id: 'p1', slots: { 'session-auth-methods': methods('one') } });
    registerProductUiPlugin({ id: 'p2', slots: { 'session-auth-methods': methods('two') } });

    const markup = renderToStaticMarkup(createElement(ProductSlot, { name: 'session-auth-methods', isTunnelLocked: true, runtime: 'desktop-remote', onSignedIn: async () => true }));

    expect(markup).toBe('<span>one</span><span>two</span>');
    expect(seen).toEqual(['true:desktop-remote', 'true:desktop-remote']);
  });

  test('one plugin fills a slot with several components in order', () => {
    const message: ProductSlotProps['assistant-message-footer']['message'] = {
      info: { id: 'msg_1' } as ProductSlotProps['assistant-message-footer']['message']['info'],
      parts: [],
    };
    const footer = (label: string) => (props: ProductSlotProps['assistant-message-footer']) =>
      createElement('em', null, `${label}:${props.message.info.id}:${String(props.isLatestTurn)}`);
    registerProductUiPlugin({ id: 'p1', slots: { 'assistant-message-footer': [footer('A'), footer('B')] } });

    const markup = renderToStaticMarkup(createElement(ProductSlot, { name: 'assistant-message-footer', message, isLatestTurn: false }));

    expect(markup).toBe('<em>A:msg_1:false</em><em>B:msg_1:false</em>');
  });

  test('an empty slot renders nothing', () => {
    registerProductUiPlugin({ id: 'p1', slots: { 'about-dialog': () => createElement('span', null, 'about') } });

    expect(renderToStaticMarkup(createElement(ProductSlot, { name: 'sidebar-footer' }))).toBe('');
    resetProductUiPluginsForTests();
    expect(renderToStaticMarkup(createElement(ProductSlot, { name: 'about-dialog' }))).toBe('');
  });

  test('a slot reads the plugins registered when it renders', () => {
    const tree = (): ReactNode => createElement(ProductSlot, { name: 'providers-page' });
    expect(renderToStaticMarkup(tree())).toBe('');

    registerProductUiPlugin({ id: 'late', slots: { 'providers-page': () => createElement('p', null, 'late') } });

    expect(renderToStaticMarkup(tree())).toBe('<p>late</p>');
  });

  test('model picker decorations default to pass-through', () => {
    const decorations = readModelPicker(true);

    expect(decorations.isProviderShown('openai')).toBe(true);
    expect(decorations.entryStatus(ENTRY)).toBeNull();
  });

  test('a model-picker plugin registered after the picker rendered is ignored, not a crash', () => {
    const before = readModelPicker(true);
    let called = false;
    registerProductUiPlugin({
      id: 'late',
      modelPicker: {
        useDecorations: () => {
          called = true;
          return { isProviderShown: () => false, entryStatus: () => ({ pill: 'late', tone: 'near', blocked: true }) };
        },
      },
    });

    const after = readModelPicker(true);

    expect(called).toBe(false);
    expect(after).toBe(before);
    expect(after.isProviderShown('openai')).toBe(true);
    expect(after.entryStatus(ENTRY)).toBeNull();
  });

  test('a model-picker plugin registered before the picker rendered is used', () => {
    registerProductUiPlugin({
      id: 'early',
      modelPicker: { useDecorations: () => ({ isProviderShown: () => false, entryStatus: () => null }) },
    });

    expect(readModelPicker(true).isProviderShown('openai')).toBe(false);
  });

  test("two plugins' decorations compose into one hook", () => {
    const opened: string[] = [];
    registerProductUiPlugin({
      id: 'p1',
      modelPicker: {
        useDecorations: (open) => {
          opened.push(`p1:${open}`);
          return {
            isProviderShown: (providerId) => providerId !== 'mistral',
            entryStatus: (entry) => (entry.modelID === 'gpt-x' ? null : { pill: 'p1', tone: 'neutral', blocked: false }),
          };
        },
      },
    });
    registerProductUiPlugin({
      id: 'p2',
      modelPicker: {
        useDecorations: (open) => {
          opened.push(`p2:${open}`);
          return {
            isProviderShown: (providerId) => providerId !== 'google',
            entryStatus: () => ({ pill: 'p2', title: 'Near the limit', tone: 'near', blocked: true }),
          };
        },
      },
    });

    const decorations = readModelPicker(false);

    expect(opened).toEqual(['p1:false', 'p2:false']);
    expect(decorations.isProviderShown('openai')).toBe(true);
    expect(decorations.isProviderShown('mistral')).toBe(false);
    expect(decorations.isProviderShown('google')).toBe(false);
    expect(decorations.entryStatus(ENTRY)).toEqual({ pill: 'p2', title: 'Near the limit', tone: 'near', blocked: true });
    expect(decorations.entryStatus({ ...ENTRY, modelID: 'other' })).toEqual({ pill: 'p1', tone: 'neutral', blocked: false });
  });

  test('the picker offers to add a provider unless a plugin says not to', () => {
    expect(readModelPicker(true).offersAddProvider).not.toBe(false);
  });

  test('one plugin that withholds the add-provider row withholds it for all', () => {
    registerProductUiPlugin({
      id: 'p1',
      modelPicker: { useDecorations: () => ({ isProviderShown: () => true, entryStatus: () => null, offersAddProvider: false }) },
    });
    registerProductUiPlugin({
      id: 'p2',
      modelPicker: { useDecorations: () => ({ isProviderShown: () => true, entryStatus: () => null }) },
    });

    expect(readModelPicker(true).offersAddProvider).toBe(false);
  });

  test('plugins that say nothing about the add-provider row keep it', () => {
    registerProductUiPlugin({
      id: 'p1',
      modelPicker: { useDecorations: () => ({ isProviderShown: () => true, entryStatus: () => null }) },
    });
    registerProductUiPlugin({
      id: 'p2',
      modelPicker: { useDecorations: () => ({ isProviderShown: () => true, entryStatus: () => null, offersAddProvider: true }) },
    });

    expect(readModelPicker(true).offersAddProvider).not.toBe(false);
  });

  test('message error translation takes the first answer', () => {
    const error = { type: 'provider.quota', message: 'quota', status: 402, responseBody: '{}' };
    expect(translateProductMessageError(error)).toBeNull();

    registerProductUiPlugin({ id: 'p1', messageError: () => null });
    registerProductUiPlugin({ id: 'p2', messageError: (seen) => `second:${seen.status}` });
    registerProductUiPlugin({ id: 'p3', messageError: () => 'third' });

    expect(translateProductMessageError(error)).toBe('second:402');
  });
});

describe('remote model catalog', () => {
  test('the window may fetch the public model catalog until a plugin turns it off', () => {
    expect(remoteModelCatalogAllowed()).toBe(true);
    registerProductUiPlugin({ id: 'brand' });
    expect(remoteModelCatalogAllowed()).toBe(true);
    registerProductUiPlugin({ id: 'offline', remoteModelCatalog: false });
    expect(remoteModelCatalogAllowed()).toBe(false);
    registerProductUiPlugin({ id: 'other', remoteModelCatalog: true });
    expect(remoteModelCatalogAllowed()).toBe(false);
    resetProductUiPluginsForTests();
    expect(remoteModelCatalogAllowed()).toBe(true);
  });
});
