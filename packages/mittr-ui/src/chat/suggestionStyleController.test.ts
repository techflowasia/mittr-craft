import { describe, expect, test } from 'bun:test';

import { createSuggestionStyleController } from './suggestionStyleController';
import { SuggestionStyleRequestError, type SuggestionStyle, type SuggestionStyleApi, type SuggestionStyleSettings } from './suggestionStyleApi';

const gate = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const fakeApi = (settings: SuggestionStyleSettings = { suggestionStyle: 'next-step', canChange: true }) => {
  const saves: SuggestionStyle[] = [];
  let failSave: Error | null = null;
  let failLoad: Error | null = null;
  const api: SuggestionStyleApi = {
    load: async () => {
      if (failLoad) throw failLoad;
      return settings;
    },
    save: async (style) => {
      saves.push(style);
      if (failSave) throw failSave;
      settings = { ...settings, suggestionStyle: style };
      return settings;
    },
  };
  return {
    api,
    saves,
    failSaveWith: (error: Error | null) => { failSave = error; },
    failLoadWith: (error: Error | null) => { failLoad = error; },
  };
};

describe('MittrCraft suggestion style controller', () => {
  test('starts loading, then holds the stored style', async () => {
    const fake = fakeApi({ suggestionStyle: 'unfinished-only', canChange: false });
    const controller = createSuggestionStyleController({ api: fake.api });
    expect(controller.state()).toEqual({ status: 'loading' });
    await controller.load();
    expect(controller.state()).toEqual({ status: 'ready', suggestionStyle: 'unfinished-only', canChange: false, saving: false });
  });

  test('a load that fails says why, and a retry recovers', async () => {
    const fake = fakeApi();
    fake.failLoadWith(new SuggestionStyleRequestError('Could not read the suggestion setting', 500));
    const controller = createSuggestionStyleController({ api: fake.api });
    await controller.load();
    expect(controller.state()).toEqual({ status: 'error', error: 'Could not read the suggestion setting' });
    fake.failLoadWith(null);
    await controller.load();
    expect(controller.state()).toMatchObject({ status: 'ready', suggestionStyle: 'next-step' });
  });

  test('choosing a style shows it at once, saves it and tells listeners', async () => {
    const fake = fakeApi();
    const controller = createSuggestionStyleController({ api: fake.api });
    await controller.load();
    let told = 0;
    controller.subscribe(() => { told += 1; });
    const saving = controller.choose('unfinished-only');
    expect(controller.state()).toEqual({ status: 'ready', suggestionStyle: 'unfinished-only', canChange: true, saving: true });
    expect(await saving).toBeNull();
    expect(controller.state()).toEqual({ status: 'ready', suggestionStyle: 'unfinished-only', canChange: true, saving: false });
    expect(fake.saves).toEqual(['unfinished-only']);
    expect(told).toBeGreaterThan(0);
  });

  test('a failed save goes back to the stored style and answers the error', async () => {
    const fake = fakeApi();
    const controller = createSuggestionStyleController({ api: fake.api });
    await controller.load();
    fake.failSaveWith(new SuggestionStyleRequestError('Cannot store the suggestion setting on this machine', 500));
    expect(await controller.choose('unfinished-only')).toBe('Cannot store the suggestion setting on this machine');
    expect(controller.state()).toEqual({ status: 'ready', suggestionStyle: 'next-step', canChange: true, saving: false });
  });

  test('nothing is saved before the style is known, when it cannot change, or when it is already chosen', async () => {
    const fake = fakeApi({ suggestionStyle: 'next-step', canChange: false });
    const controller = createSuggestionStyleController({ api: fake.api });
    expect(await controller.choose('unfinished-only')).toBeNull();
    await controller.load();
    expect(await controller.choose('unfinished-only')).toBeNull();
    const changeable = createSuggestionStyleController({ api: fakeApi().api });
    await changeable.load();
    expect(await changeable.choose('next-step')).toBeNull();
    expect(fake.saves).toEqual([]);
  });

  test('a load that answers after a newer choice does not undo it', async () => {
    const pending = gate<SuggestionStyleSettings>();
    const saves: SuggestionStyle[] = [];
    let first = true;
    const api: SuggestionStyleApi = {
      load: async () => {
        if (first) {
          first = false;
          return { suggestionStyle: 'next-step', canChange: true };
        }
        return pending.promise;
      },
      save: async (style) => {
        saves.push(style);
        return { suggestionStyle: style, canChange: true };
      },
    };
    const controller = createSuggestionStyleController({ api });
    await controller.load();
    const reload = controller.load();
    await controller.choose('unfinished-only');
    pending.resolve({ suggestionStyle: 'next-step', canChange: true });
    await reload;
    expect(controller.state()).toMatchObject({ suggestionStyle: 'unfinished-only' });
  });
});
