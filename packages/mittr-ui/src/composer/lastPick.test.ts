import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from '../../../ui/node_modules/happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  CustomEvent: browser.CustomEvent,
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
const { rememberEffort } = await import('../../../ui/src/lib/modelEfforts');
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

const applyModel = (sessionId: string | null, providerId: string, modelId: string) => {
  const store = useConfigStore.getState();
  store.setProvider(providerId);
  store.setModel(modelId);
  if (sessionId) useSelectionStore.getState().saveSessionModelSelection(sessionId, providerId, modelId);
};

const pickModel = (sessionId: string | null, providerId: string, modelId: string) => {
  applyModel(sessionId, providerId, modelId);
  if (sessionId) useSelectionStore.getState().pickSessionModel(sessionId, providerId, modelId);
};

const applyEffort = (sessionId: string | null, variant: string | null) => {
  const store = useConfigStore.getState();
  store.setCurrentVariantOverride(variant, undefined);
  if (sessionId && store.currentAgentName) {
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, store.currentAgentName, store.currentProviderId, store.currentModelId, variant);
  }
};

const pickEffort = (sessionId: string | null, variant: string | null) => {
  applyEffort(sessionId, variant);
  const { currentProviderId, currentModelId } = useConfigStore.getState();
  rememberEffort(currentProviderId, currentModelId, variant);
};

const pickAgent = (agentName: string) => {
  const sessionId = useSessionUIStore.getState().currentSessionId;
  if (sessionId) useSelectionStore.getState().pickSessionAgent(sessionId, agentName);
  useConfigStore.getState().setAgent(agentName);
};

const restoreAgent = (agentName: string) => {
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
    sessionPickedModels: new Map(),
    sessionAgentSelections: new Map(),
    sessionPickedAgents: new Map(),
    sessionFollowedAgents: new Map(),
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

  test('an agent picked in an open chat is remembered, even though the chat records the pick first', async () => {
    openChat('ses_a');
    pickAgent('plan');
    await settle();

    startNewChat();

    expect(composer().agent).toBe('plan');
    expect(saved).toEqual([{ defaultAgent: 'plan' }]);
  });

  test('picking back the model an open chat started on is remembered', async () => {
    useSelectionStore.getState().saveSessionModelSelection('ses_a', 'mittr', 'fast');
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    pickModel('ses_a', 'mittr', 'fast');
    await settle();

    expect(saved).toEqual([{ defaultModel: 'mittr/deep', defaultVariant: '' }, { defaultModel: 'mittr/fast', defaultVariant: '' }]);
  });

  test('picking back the agent an open chat already runs on is remembered', async () => {
    useSelectionStore.getState().followSessionAgent('ses_a', 'build');
    openChat('ses_a');
    pickAgent('plan');
    await settle();
    pickAgent('build');
    await settle();

    expect(useSelectionStore.getState().getSessionAgentPick('ses_a')).toBeNull();
    expect(saved).toEqual([{ defaultAgent: 'plan' }, { defaultAgent: 'build' }]);
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
    applyModel('ses_b', 'mittr', 'fast');
    restoreAgent('build');
    await settle();

    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultModel).toBe('mittr/deep');
    expect(useConfigStore.getState().settingsDefaultAgent).toBe('plan');
  });

  test('opening a chat this device never opened, such as one a schedule started, does not save its model', async () => {
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    saved = [];

    openChat('ses_from_schedule');
    applyModel('ses_from_schedule', 'mittr', 'fast');
    await settle();

    expect(composer().model).toBe('mittr/fast');
    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultModel).toBe('mittr/deep');
  });

  test('opening a chat this device never opened does not save its effort either', async () => {
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    pickEffort('ses_a', 'low');
    await settle();
    saved = [];

    openChat('ses_from_schedule');
    applyEffort('ses_from_schedule', 'high');
    await settle();

    expect(composer()).toMatchObject({ model: 'mittr/deep', variant: 'high' });
    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultVariant).toBe('low');
  });

  test('a model picked in another chat column is not this chat\'s pick', async () => {
    openChat('ses_a');
    useSelectionStore.getState().pickSessionModel('ses_column', 'mittr', 'deep');
    applyModel('ses_a', 'mittr', 'deep');
    await settle();

    expect(saved).toEqual([]);
  });

  test('a model pick still unsent in a chat is not picked again when the chat is reopened', async () => {
    openChat('ses_a');
    pickModel('ses_a', 'mittr', 'deep');
    await settle();
    openChat('ses_b');
    pickModel('ses_b', 'mittr', 'fast');
    await settle();
    saved = [];

    openChat('ses_a');
    applyModel('ses_a', 'mittr', 'deep');
    await settle();

    expect(useSelectionStore.getState().getSessionModelPick('ses_a')).toEqual({ providerId: 'mittr', modelId: 'deep' });
    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultModel).toBe('mittr/fast');
  });

  test('reopening a chat whose agent pick is still unsent does not pick it again', async () => {
    openChat('ses_a');
    pickAgent('plan');
    await settle();
    openChat('ses_c');
    pickAgent('build');
    await settle();
    saved = [];

    openChat('ses_a');
    restoreAgent('plan');
    await settle();

    expect(useSelectionStore.getState().getSessionAgentPick('ses_a')).toBe('plan');
    expect(saved).toEqual([]);
    expect(useConfigStore.getState().settingsDefaultAgent).toBe('build');
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
