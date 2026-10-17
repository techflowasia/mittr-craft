import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ModelEntryStatusPill } from '@/components/model-picker/ModelEntryStatusPill';
import { ModelPickerList, type ModelPickerEntry, type ModelPickerProvider } from '@/components/model-picker/ModelPickerList';
import { registerProductUiPlugin, resetProductUiPluginsForTests, useProductModelPicker } from '@/lib/product-plugins';
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID } from '@/lib/routing/autoModel';

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

const AUTO_ENTRY = { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, model: { id: AUTO_MODEL_ID, name: 'Auto pick' } };

function PickerAsModelControlsWiresIt(): React.ReactNode {
  const productModelPicker = useProductModelPicker(true);
  const offeredAutoEntry = productModelPicker.isProviderShown(AUTO_ENTRY.providerID) ? AUTO_ENTRY : null;
  return (
    <ModelPickerList
      providers={PROVIDERS}
      favoriteModels={[]}
      recentModels={[]}
      searchQuery=""
      onSearchQueryChange={noop}
      onSelect={noop}
      labels={LABELS}
      leadingEntry={offeredAutoEntry}
      isModelAllowed={(providerID) => productModelPicker.isProviderShown(providerID)}
    />
  );
}

const THINKING_SLOT = <span>Thinking: Default</span>;

function PickerWithEntryStatus(): React.ReactNode {
  const productModelPicker = useProductModelPicker(true);
  const entryStatusOf = (entry: ModelPickerEntry) => productModelPicker.entryStatus({
    providerID: entry.providerID,
    modelID: entry.modelID,
    name: String(entry.model.name),
  });
  return (
    <ModelPickerList
      providers={PROVIDERS}
      favoriteModels={[]}
      recentModels={[]}
      searchQuery=""
      onSearchQueryChange={noop}
      onSelect={noop}
      labels={LABELS}
      isEntryBlocked={(entry) => entryStatusOf(entry)?.blocked === true}
      renderRowEnd={(entry, state) => (
        <>
          <ModelEntryStatusPill status={entryStatusOf(entry)} isHighlighted={state.isHighlighted} />
          {THINKING_SLOT}
        </>
      )}
    />
  );
}

const rowsOf = (html: string) => html.split('role="option"').slice(1);

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
    expect(html).toContain('Auto pick');
  });

  test('the Auto entry is offered only while a plugin shows its provider', () => {
    registerProductUiPlugin({
      id: 'mittr-only',
      modelPicker: {
        useDecorations: () => ({ isProviderShown: (providerId) => providerId === 'mittr', entryStatus: () => null }),
      },
    });
    expect(renderToStaticMarkup(<PickerAsModelControlsWiresIt />)).not.toContain('Auto pick');
  });

  test('a plugin status draws a pill before the thinking slot', () => {
    registerProductUiPlugin({
      id: 'status',
      modelPicker: {
        useDecorations: () => ({
          isProviderShown: () => true,
          entryStatus: (entry) => (entry.modelID === 'writer'
            ? { pill: 'Used up', title: 'Mittr Writer is used up this week', tone: 'neutral', blocked: true }
            : null),
        }),
      },
    });
    const [writer, gpt] = rowsOf(renderToStaticMarkup(<PickerWithEntryStatus />));
    expect(writer).toContain('aria-label="Mittr Writer is used up this week"');
    expect(writer).toContain('>Used up</span>');
    expect(writer.indexOf('Used up')).toBeLessThan(writer.indexOf('Thinking: Default'));
    expect(writer).toContain('aria-disabled="true"');
    expect(gpt).not.toContain('Used up');
    expect(gpt).not.toContain('aria-disabled');
    expect(gpt).toContain('Thinking: Default');
  });

  test('a status that does not block marks the row without disabling it', () => {
    registerProductUiPlugin({
      id: 'status',
      modelPicker: {
        useDecorations: () => ({
          isProviderShown: () => true,
          entryStatus: (entry) => (entry.modelID === 'writer' ? { pill: '12% left', tone: 'near', blocked: false } : null),
        }),
      },
    });
    const [writer] = rowsOf(renderToStaticMarkup(<PickerWithEntryStatus />));
    expect(writer).toContain('>12% left</span>');
    expect(writer).toContain('aria-label="12% left"');
    expect(writer).toContain('data-model-status="near"');
    expect(writer).not.toContain('aria-disabled');
  });

  test('with no plugin no row is marked or blocked', () => {
    const html = renderToStaticMarkup(<PickerWithEntryStatus />);
    expect(html).not.toContain('data-model-status');
    expect(html).not.toContain('aria-disabled');
    expect(html).toContain('Thinking: Default');
  });
});
