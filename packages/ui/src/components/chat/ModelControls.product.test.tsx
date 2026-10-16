import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ModelPickerList, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { registerProductUiPlugin, resetProductUiPluginsForTests, useProductModelPicker } from '@/lib/product-plugins';

// ModelControls draws its picker in a portal, which static markup does not
// render, and the composer's stores cannot be stood in for without module
// mocks. So this renders the real picker list the way ModelControls wires it:
// one useProductModelPicker call, whose isProviderShown becomes the list's
// isModelAllowed. The upstream contract pins that wiring in ModelControls.

const PROVIDERS: ModelPickerProvider[] = [
  { id: 'mittr', name: 'Mittr', models: [{ id: 'writer', name: 'Mittr Writer' }] },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5.5', name: 'GPT Five' }] },
];

const LABELS = {
  searchPlaceholder: 'Search models',
  noResults: 'No models',
  favorites: 'Favorites',
  recent: 'Recent',
  keyboardHint: 'Navigate',
};

const noop = () => {};

function PickerAsModelControlsWiresIt(): React.ReactNode {
  const productModelPicker = useProductModelPicker(true);
  return (
    <ModelPickerList
      providers={PROVIDERS}
      favoriteModels={[]}
      recentModels={[]}
      searchQuery=""
      onSearchQueryChange={noop}
      onSelect={noop}
      labels={LABELS}
      isModelAllowed={(providerID) => productModelPicker.isProviderShown(providerID)}
    />
  );
}

afterEach(() => {
  resetProductUiPluginsForTests();
});

describe('ModelControls product picker', () => {
  test('picker hides other providers when a plugin says so', () => {
    registerProductUiPlugin({
      id: 'mittr-only',
      modelPicker: {
        useDecorations: () => ({ isProviderShown: (providerId) => providerId === 'mittr', entryStatus: () => null }),
      },
    });
    const html = renderToStaticMarkup(<PickerAsModelControlsWiresIt />);
    expect(html).toContain('Mittr Writer');
    expect(html).not.toContain('GPT Five');
  });

  test('with no plugin every provider renders', () => {
    const html = renderToStaticMarkup(<PickerAsModelControlsWiresIt />);
    expect(html).toContain('Mittr Writer');
    expect(html).toContain('GPT Five');
  });
});
