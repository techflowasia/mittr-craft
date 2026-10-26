import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const { getRuntimeKey } = await import('../../../ui/src/lib/runtime-switch');
const { useConfigStore } = await import('../../../ui/src/stores/useConfigStore');
const { useProjectsStore } = await import('../../../ui/src/stores/useProjectsStore');
const { useSelectionStore } = await import('../../../ui/src/sync/selection-store');
const { useSessionUIStore } = await import('../../../ui/src/sync/session-ui-store');
const { startLastPickMemory } = await import('./lastPick');

type Saved = { defaultModel?: string; defaultVariant?: string; defaultAgent?: string };

const DIRECTORY = '/work/app';

const catalogModel = (providerId: string, modelId: string, variants: string[]) => ({
  id: `${providerId}/${modelId}`,
  modelID: modelId,
  providerID: providerId,
  name: modelId,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: variants.map((id) => ({ id })),
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: 'active' as const,
  enabled: true,
  limit: { context: 0, output: 0 },
});

const catalogProvider = (id: string, models: ReturnType<typeof catalogModel>[]) => ({
  id,
  name: id,
  activation: 'enabled' as const,
  package: id,
  models,
});

const primaryAgent = (name: string) => ({
  id: name,
  name,
  displayName: name,
  mode: 'primary' as const,
  hidden: false,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
});

const PROVIDERS = [
  catalogProvider('mittr', [catalogModel('mittr', 'fast', ['low', 'high']), catalogModel('mittr', 'deep', ['low', 'high'])]),
  catalogProvider('acme', [catalogModel('acme', 'other', [])]),
];

let saved: Saved[] = [];
let signedIn = true;
let stop: () => void = () => {};

const startMemory = () => {
  stop = startLastPickMemory({
    isProviderOffered: (providerId) => providerId === 'mittr',
    signedIn: () => signedIn,
    save: (defaults) => { saved.push(defaults); },
  });
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const openChat = (sessionId: string | null) => {
  useSessionUIStore.setState({ currentSessionId: sessionId });
};

const startNewChat = () => {
  openChat(null);
  useConfigStore.getState().applyDefaultModelAgentSelection({});
};

const pickModel = (sessionId: string | null, providerId: string, modelId: string) => {
  const store = useConfigStore.getState();
  store.setProvider(providerId);
  store.setModel(modelId);
  if (sessionId) useSelectionStore.getState().saveSessionModelSelection(sessionId, providerId, modelId);
};

const pickEffort = (sessionId: string | null, variant: string | null) => {
  const store = useConfigStore.getState();
  store.setCurrentVariantOverride(variant, undefined);
  if (sessionId && store.currentAgentName) {
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, store.currentAgentName, store.currentProviderId, store.currentModelId, variant);
  }
};

const pickAgent = (agentName: string) => {
  useConfigStore.getState().setAgent(agentName);
};

const composer = () => {
  const state = useConfigStore.getState();
  return { model: `${state.currentProviderId}/${state.currentModelId}`, variant: state.currentVariant, agent: state.currentAgentName };
};

beforeEach(() => {
  stop();
  saved = [];
  signedIn = true;
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  useSessionUIStore.setState({ currentSessionId: null });
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    sessionAgentModelSelections: new Map(),
    agentModelVariantSelections: new Map(),
  });
  useConfigStore.setState({
    configRuntimeKey: getRuntimeKey(),
    activeDirectoryKey: DIRECTORY,
    directoryScoped: {},
    providers: PROVIDERS,
    agents: [primaryAgent('build'), primaryAgent('plan')],
    currentProviderId: 'mittr',
    currentModelId: 'fast',
    currentVariant: undefined,
    currentVariantSelection: { override: undefined, inherited: undefined },
    currentAgentName: 'build',
    selectionSource: 'auto',
    agentSelectionSource: 'auto',
    settingsDefaultModel: undefined,
    settingsDefaultVariant: undefined,
    settingsDefaultAgent: undefined,
    settingsDefaultsLoaded: true,
    opencodeDefaultModel: 'mittr/fast',
    opencodeDefaultAgent: undefined,
  });
  startMemory();
});

describe('the last pick in the composer is where a new chat starts', () => {
  test('a model, effort and agent picked in chat A are where new chat B starts', async () => {
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    pickEffort('ses_a', 'high');
    await settle();
    pickAgent('plan');
    await settle();

    startNewChat();

    expect(composer()).toEqual({ model: 'mittr/deep', variant: 'high', agent: 'plan' });
    expect(saved).toEqual([
      { defaultModel: 'mittr/deep', defaultVariant: '' },
      { defaultModel: 'mittr/deep', defaultVariant: 'high' },
      { defaultAgent: 'plan' },
    ]);
  });

  test('the last pick survives a restart of the app', async () => {
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    pickEffort('ses_a', 'low');
    await settle();
    pickAgent('plan');
    await settle();

    await settle();
    const onDisk = localStorage.getItem('config-store');
    useConfigStore.setState({ settingsDefaultModel: undefined, settingsDefaultVariant: undefined, settingsDefaultAgent: undefined });
    await settle();
    localStorage.setItem('config-store', onDisk ?? '');
    await useConfigStore.persist.rehydrate();
    startNewChat();

    expect(composer()).toEqual({ model: 'mittr/deep', variant: 'low', agent: 'plan' });
  });

  test('a pick in a new chat stays as picked there, even where the project names its own default', async () => {
    useProjectsStore.setState({ projects: [{ id: 'app', path: DIRECTORY, label: 'App', defaultModel: 'mittr/fast' }], activeProjectId: 'app' });
    useSessionUIStore.setState({ newSessionDraft: { draftId: 7, open: true, target: 'project', selectedProjectId: 'app', directoryOverride: null, parentID: null } });
    startNewChat();

    pickModel(null, 'mittr', 'deep');
    await settle();
    pickAgent('plan');
    await settle();

    expect(composer()).toEqual({ model: 'mittr/deep', variant: undefined, agent: 'plan' });
    expect(useConfigStore.getState().selectionSource).toBe('manual');
    expect(useConfigStore.getState().settingsDefaultModel).toBe('mittr/deep');
    expect(useConfigStore.getState().settingsDefaultAgent).toBe('plan');
  });

  test('an explicit Default effort is remembered as no effort', async () => {
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    pickEffort('ses_a', 'high');
    await settle();
    pickEffort('ses_a', null);
    await settle();

    startNewChat();

    expect(composer().variant).toBeUndefined();
    expect(useConfigStore.getState().settingsDefaultVariant).toBeUndefined();
    expect(saved.at(-1)).toEqual({ defaultModel: 'mittr/deep', defaultVariant: '' });
  });
});

describe('what is not a pick', () => {
  test('defaults the app applies by itself are not saved', async () => {
    startNewChat();
    await settle();
    useConfigStore.getState().setCurrentVariant('high');
    await settle();
    openChat('ses_a');
    useConfigStore.getState().applyDefaultModelAgentSelection({});
    await settle();

    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultModel).toBeUndefined();
  });

  test('reopening a chat brings back its own choice without saving it', async () => {
    useSelectionStore.getState().saveSessionModelSelection('ses_b', 'mittr', 'fast');
    useSelectionStore.getState().saveSessionAgentSelection('ses_b', 'build');
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    pickAgent('plan');
    await settle();
    saved = [];

    openChat('ses_b');
    pickModel('ses_b', 'mittr', 'fast');
    pickAgent('build');
    await settle();

    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultModel).toBe('mittr/deep');
    expect(useConfigStore.getState().settingsDefaultAgent).toBe('plan');
  });

  test('a model the picker does not offer is not saved, while the agent picked with it is', async () => {
    openChat('ses_a');
    pickModel('ses_a', 'acme', 'other');
    await settle();
    pickAgent('plan');
    await settle();

    expect(saved).toEqual([{ defaultAgent: 'plan' }]);
    expect(useConfigStore.getState().settingsDefaultModel).toBeUndefined();
  });

  test('nothing is saved while signed out', async () => {
    signedIn = false;
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    pickAgent('plan');
    await settle();

    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultModel).toBeUndefined();
  });

  test('after it stops, picks are not saved', async () => {
    stop();
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();

    expect(saved).toEqual([]);
  });
});
