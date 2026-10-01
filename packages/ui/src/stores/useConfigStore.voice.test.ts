import { describe, expect, mock, test } from 'bun:test';

let storage = new Map<string, string>();

const makeStorage = (): Storage => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
}) as Storage;

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
if (typeof window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      location: { search: '', pathname: '/', hash: '', href: 'http://localhost/' },
    },
  });
}

mock.module('@/stores/utils/safeStorage', () => ({
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
  createDeferredSafeJSONStorage: () => ({
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }),
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: () => undefined,
    getDirectory: () => '/workspace',
    clearConfigCache: () => undefined,
    getFilesystemHome: async () => null,
    getSystemInfo: async () => ({}),
  },
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async () => undefined,
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: () => undefined,
  scopeMatches: () => false,
  subscribeToConfigChanges: () => () => undefined,
}));

let importCount = 0;
const freshStore = async (seed: Record<string, string>, vscode = false) => {
  storage = new Map(Object.entries(seed));
  (window as unknown as { __VSCODE_CONFIG__?: unknown }).__VSCODE_CONFIG__ = vscode ? {} : undefined;
  importCount += 1;
  const module = await import(`./useConfigStore?voice=${importCount}`) as typeof import('./useConfigStore');
  return module.useConfigStore.getState();
};

describe('useConfigStore voice providers at start', () => {
  test('a saved read-aloud choice is kept', async () => {
    expect((await freshStore({ voiceProvider: 'say' })).voiceProvider).toBe('say');
    expect((await freshStore({ voiceProvider: 'openai-compatible' })).voiceProvider).toBe('openai-compatible');
    expect((await freshStore({ voiceProvider: 'local' })).voiceProvider).toBe('local');
  });

  test('a saved dictation choice is kept', async () => {
    expect((await freshStore({ sttProvider: 'local' })).sttProvider).toBe('local');
    expect((await freshStore({ sttProvider: 'openai-compatible' })).sttProvider).toBe('openai-compatible');
  });

  test('nothing saved starts on Mittr', async () => {
    const state = await freshStore({});
    expect(state.voiceProvider).toBe('mittr');
    expect(state.sttProvider).toBe('mittr');
  });

  test('a stored local model counts as having chosen local dictation', async () => {
    expect((await freshStore({ sttLocalModel: 'parakeet-tdt-0.6b-v2-int8' })).sttProvider).toBe('local');
  });

  test('the VS Code webview does not start on Mittr', async () => {
    const state = await freshStore({}, true);
    expect(state.voiceProvider).toBe('browser');
    expect(state.sttProvider).toBe('local');
  });
});
