import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../ui/src/lib/i18n';
import { dict as enDict } from '../../ui/src/lib/i18n/messages/en';
import { overlayDictionary, ProductSlot, remoteModelCatalogAllowed, useProductModelPicker } from '../../ui/src/lib/product-plugins';
import './product-ui-plugin';
import { strings } from './strings/en';
import { mittrT } from './strings/mittrT';

const MISLEADING = [
  'an MittrCraft',
  'An MittrCraft',
  'MittrCraft MittrCraft',
  'Install MittrCraft',
  'MittrCraft {version}',
  'the the ',
  'your the ',
];

describe('MittrCraft UI plugin', () => {
  const merged = overlayDictionary('en', enDict);

  test('the merged English dictionary names no OpenChamber or OpenCode product', () => {
    const leftovers = Object.entries(merged)
      .filter(([key, value]) => /\bOpenChamber\b/.test(value) && !(key in strings));
    expect(leftovers).toEqual([]);
  });

  test('no merged English value reads as installing or updating the app in place of the engine', () => {
    const offenders = Object.entries(merged)
      .flatMap(([key, value]) => MISLEADING.filter((phrase) => value.includes(phrase)).map((phrase) => `${key}: ${phrase}`));
    expect(offenders).toEqual([]);
  });

  test('the About dialog says only "Version" under the app name and drops the community tagline', () => {
    expect(merged['aboutDialog.openChamberVersionLabel']).toBe('Version {version}');
    expect(merged['aboutDialog.footerNote']).toBe('');
  });

  test('every override keeps the placeholders of the value it replaces', () => {
    const placeholders = (value: string) => (value.match(/\{[^{}]+\}/g) ?? []).sort();
    const changed = Object.entries(strings)
      .filter(([key, value]) => placeholders(value).join() !== placeholders(enDict[key as keyof typeof enDict]).join())
      .map(([key]) => key);
    expect(changed).toEqual([]);
  });
});

describe('MittrCraft model picker and providers page', () => {
  test('the picker shows only Mittr until the switch is known to be on', () => {
    const shown: Record<string, boolean> = {};
    const Probe = () => {
      const decorations = useProductModelPicker(false);
      for (const id of ['mittr', 'openai', 'opencode']) shown[id] = decorations.isProviderShown(id);
      return null;
    };
    renderToStaticMarkup(React.createElement(Probe));
    expect(shown).toEqual({ mittr: true, openai: false, opencode: false });
  });

  test('the providers page carries the switch for other providers', () => {
    const html = renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ProductSlot, { name: 'providers-page' })),
    );
    expect(html).toContain(mittrT('mittr.providers.otherProviders.label'));
    expect(html).toContain('role="switch"');
  });
});

describe('MittrCraft and the public model catalog', () => {
  test('the window never asks models.dev for model metadata or provider logos', () => {
    expect(remoteModelCatalogAllowed()).toBe(false);
  });
});
