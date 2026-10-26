import { createEngineCall } from '../tools/chrome-approvals.js';
import { MITTR_TOOLS, MittrToolError, UPSTREAM_SWITCHES } from '../tools/registry.js';
import { trimmedText } from '../values.js';
import { clampSpeech } from './audio.js';
import { VOICE_ACTION_DEFINITIONS, VOICE_TOOL_DESCRIPTION } from './descriptions.js';
import { speakable } from './speakable.js';
import { VOICE_SESSION_ID, VOICE_TOOLS } from './tools.js';

export const NOTHING_TO_ALLOW = 'Chrome has not asked for permission in this conversation, so there is nothing to allow';

const definitionOf = (action) => VOICE_ACTION_DEFINITIONS.find((entry) => entry.action === action);

const sessionIdOf = (input) => {
  const id = trimmedText(input.sessionId);
  if (!id) throw new MittrToolError('sessionId is required', 400);
  return id;
};

export function registerVoiceActions(registry, { control, engine, chrome, conversation, settings, chromeAvailable, fetchImpl }) {
  const engineCall = createEngineCall({ opencode: engine, fetchImpl });

  const directoryOf = async (input, sessionId) => {
    const directory = trimmedText(input.directory) ?? trimmedText(await control.resolveSessionDirectory(sessionId));
    if (!directory) throw new MittrToolError('directory is required', 400);
    return directory;
  };

  registry.defineTool({ name: VOICE_TOOLS.voice, description: VOICE_TOOL_DESCRIPTION, parameters: {} });

  registry.register({
    ...definitionOf('session.stop'),
    tool: VOICE_TOOLS.voice,
    effect: 'change',
    voiceOnly: true,
    switchedBy: UPSTREAM_SWITCHES.control,
    execute: async (input, ctx) => {
      const sessionId = sessionIdOf(input);
      const directory = await directoryOf(input, sessionId);
      await engineCall(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST', directory, signal: ctx.signal });
      return { stopped: true, sessionId, directory };
    },
  });

  registry.register({
    ...definitionOf('session.read_reply'),
    tool: VOICE_TOOLS.voice,
    effect: 'read',
    voiceOnly: true,
    switchedBy: UPSTREAM_SWITCHES.control,
    execute: async (input, ctx) => {
      const sessionId = sessionIdOf(input);
      const directory = await directoryOf(input, sessionId);
      const read = await control.execute('session.messages', { sessionId, directory, role: 'assistant', last: true }, directory, { signal: ctx.signal });
      const latest = Array.isArray(read?.messages) ? read.messages.at(-1) : null;
      if (!trimmedText(latest?.text)) return { sessionId, directory, text: null, truncated: false };
      const { voice } = await settings.read();
      const spoken = speakable(latest.text);
      return { sessionId, directory, text: clampSpeech(spoken, voice.replyMaxChars), truncated: spoken.length > voice.replyMaxChars };
    },
  });

  registry.register({
    ...definitionOf('chrome.allow_site'),
    tool: VOICE_TOOLS.voice,
    effect: 'change',
    voiceOnly: true,
    switchedBy: MITTR_TOOLS.chrome,
    available: chromeAvailable,
    execute: async (_input, ctx) => {
      if (!ctx.conversationId || ctx.conversationId !== conversation.current() || !conversation.pendingHost()) {
        throw new MittrToolError(NOTHING_TO_ALLOW, 409);
      }
      chrome.allowForConversation(VOICE_SESSION_ID);
      conversation.allowChrome();
      return { allowed: true, scope: 'conversation', sites: 'all' };
    },
  });
}
