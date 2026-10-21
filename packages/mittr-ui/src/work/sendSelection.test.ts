import { afterEach, describe, expect, test } from 'bun:test';

import { useConfigStore } from '../../../ui/src/stores/useConfigStore';
import { useSelectionStore } from '../../../ui/src/sync/selection-store';
import { captureSendSelection } from './sendSelection';

const savedConfig = useConfigStore.getState();
const savedSelection = useSelectionStore.getState();

afterEach(() => {
  useConfigStore.setState(savedConfig, true);
  useSelectionStore.setState(savedSelection, true);
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
};

describe('the send selection', () => {
  test('no model anywhere gives no selection', () => {
    configure({});
    expect(captureSendSelection()).toBeNull();
  });

  test('the current model, agent and default variant are captured', () => {
    configure({ currentProviderId: 'mittr', currentModelId: 'a', currentAgentName: 'build', settingsDefaultVariant: 'high' });
    expect(captureSendSelection()).toEqual({ providerID: 'mittr', modelID: 'a', agentName: 'build', variant: 'high' });
  });

  test('the last used model is the fallback', () => {
    configure({});
    useSelectionStore.setState({ lastUsedProvider: { providerID: 'mittr', modelID: 'b' } });
    expect(captureSendSelection()).toEqual({ providerID: 'mittr', modelID: 'b', agentName: undefined, variant: undefined });
  });
});
