import { afterEach, describe, expect, test } from 'bun:test';

import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useUIStore } from '../../../ui/src/stores/useUIStore';
import { useSelectionStore } from '../../../ui/src/sync/selection-store';
import { captureSendSelection } from './sendSelection';

const savedConfig = useConfigStore.getState();
const savedSelection = useSelectionStore.getState();
const savedUI = useUIStore.getState();

afterEach(() => {
  useConfigStore.setState(savedConfig, true);
  useSelectionStore.setState(savedSelection, true);
  useUIStore.setState(savedUI, true);
});

const configure = (state: Partial<ReturnType<typeof useConfigStore.getState>>) => {
  useConfigStore.setState({
    settingsDefaultModel: undefined,
    settingsDefaultAgent: undefined,
    settingsDefaultVariant: undefined,
    currentProviderId: '',
    currentModelId: '',
    currentAgentName: undefined,
    currentVariant: undefined,
    agents: [],
    providers: [],
    ...state,
  });
  useSelectionStore.setState({ lastUsedProvider: null });
  useUIStore.setState({ lastUsedEfforts: {} });
};

const withEfforts = (id: string) => [{ id: 'mittr', models: [{ id, modelID: id, name: id, variants: { low: {}, high: {} }, cost: [], capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 0, output: 0 } }] }] as unknown as ReturnType<typeof useConfigStore.getState>['providers'];

describe('the send selection', () => {
  test('no model anywhere gives no selection', () => {
    configure({});
    expect(captureSendSelection()).toBeNull();
  });

  test('the current model, agent and variant are captured', () => {
    configure({ currentProviderId: 'mittr', currentModelId: 'a', currentAgentName: 'build', currentVariant: 'high' });
    expect(captureSendSelection()).toEqual({ providerID: 'mittr', modelID: 'a', agentName: 'build', variant: 'high' });
  });

  test('the default model starts on its configured variant', () => {
    configure({ providers: withEfforts('a'), settingsDefaultModel: 'mittr/a', settingsDefaultVariant: 'high', currentAgentName: 'build' });
    expect(captureSendSelection()).toEqual({ providerID: 'mittr', modelID: 'a', agentName: 'build', variant: 'high' });
  });

  test('a model last sent with no effort keeps no effort as null', () => {
    configure({ providers: withEfforts('a'), currentProviderId: 'mittr', currentModelId: 'a', currentVariant: 'high' });
    useUIStore.setState({ lastUsedEfforts: { 'mittr/a': null } });
    expect(captureSendSelection()?.variant).toBeNull();
  });

  test('the last used model is the fallback', () => {
    configure({});
    useSelectionStore.setState({ lastUsedProvider: { providerID: 'mittr', modelID: 'b' } });
    expect(captureSendSelection()).toEqual({ providerID: 'mittr', modelID: 'b', agentName: undefined, variant: undefined });
  });
});
