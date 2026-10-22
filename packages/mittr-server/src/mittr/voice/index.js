import { createSessionLookup, createVoiceContextBuilder } from './context.js';
import { registerVoiceActions } from './actions.js';
import { createVoiceConversation } from './conversation.js';
import { runVoiceTurn } from './loop.js';
import { registerVoiceRoutes } from './routes.js';
import { MITTR_TOOLS } from '../tools/registry.js';
import { VOICE_SESSION_ID } from './tools.js';

export function setupMittrVoice(context, { registry, tools, speech, mittrSettings, platform, logger = console, runTurn = runVoiceTurn }) {
  const { app, express, control, opencode, settings: upstreamSettings, host, requestScope } = context;
  const conversation = createVoiceConversation();
  conversation.onEnd(() => tools.chrome.endConversation(VOICE_SESSION_ID));

  const accountChanged = () => {
    conversation.endAll();
    speech.state.clearAll();
  };

  if (!host) return { conversation, accountChanged, dispose: () => conversation.endAll() };

  void mittrSettings.carryParkedVoiceSettings().then(
    (voice) => {
      if (voice) logger.log('[mittr] carried the 1.22 voice assistant limits');
    },
    (error) => logger.warn('[mittr] could not carry the 1.22 voice assistant limits; trying again next start:', error?.name ?? 'Error'),
  );

  const chromeAvailable = () => registry.definitions({ tool: MITTR_TOOLS.chrome }).some((entry) => entry.action === 'chrome.open' && entry.available);
  registerVoiceActions(registry, { control, engine: opencode, chrome: tools.chrome, conversation, settings: mittrSettings, chromeAvailable });

  const lookup = createSessionLookup({ control, engine: opencode });
  const buildContext = createVoiceContextBuilder({ control, chrome: tools.chrome, describeSession: lookup.describe });

  const switches = async () => {
    const [{ tools: stored }, upstream] = await Promise.all([
      mittrSettings.read(),
      Promise.resolve().then(() => upstreamSettings.read()).catch(() => null),
    ]);
    return {
      control: upstream?.agentControlToolEnabled !== false,
      web: upstream?.agentWebToolEnabled !== false,
      chrome: stored.chrome !== false,
      computer: stored.computer !== false,
    };
  };

  const deps = {
    ...platform,
    registry,
    upstream: control.definitions(),
    switches,
    settings: () => mittrSettings.read(),
    buildContext,
    describeSession: lookup.describe,
    conversation,
    logger,
  };

  registerVoiceRoutes(app, {
    express,
    conversation,
    runTurn: (turn) => runTurn({ ...turn, scope: { local: true }, deps }),
    client: speech.client,
    state: speech.state,
    requestScope,
    host,
    logger,
  });

  return { conversation, accountChanged, dispose: () => conversation.endAll() };
}
