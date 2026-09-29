import { createOpencodeClient } from '@opencode-ai/sdk/v2';

import { VOICE_CHROME_SESSION_ID, createSessionLookup, createVoiceChromePage, createVoiceContextBuilder } from './context.js';
import { runVoiceTurn } from './loop.js';
import { buildVoiceTools } from './tools.js';

const LOCALES = new Set(['th', 'en']);
const SAID_MAX_CHARS = 4000;
const HISTORY_MAX_ENTRIES = 60;
const QUEUED_PROMPTS_MAX = 1000;
const HISTORY_TEXT_MAX_CHARS = 20_000;

const isOptionalString = (value) => value === undefined || value === null || typeof value === 'string';

const readTurnBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { said, history, locale, directory, sessionId, queuedPrompts } = body;
  if (typeof said !== 'string' || !said.trim() || said.length > SAID_MAX_CHARS) return null;
  if (!LOCALES.has(locale)) return null;
  if (!Array.isArray(history) || history.length > HISTORY_MAX_ENTRIES) return null;
  if (!history.every((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string' && entry.text.length <= HISTORY_TEXT_MAX_CHARS)) return null;
  if (!isOptionalString(directory) || !isOptionalString(sessionId)) return null;
  if (queuedPrompts !== undefined && (!Number.isInteger(queuedPrompts) || queuedPrompts < 0 || queuedPrompts > QUEUED_PROMPTS_MAX)) return null;
  return {
    said: said.trim(),
    history: history.map(({ role, text }) => ({ role, text })),
    locale,
    directory: directory || undefined,
    sessionId: sessionId || undefined,
    queuedPrompts,
  };
};

export const registerVoiceAssistantRoutes = (app, dependencies) => {
  const {
    controlService,
    readSettingsFromDiskMigrated,
    brokerBaseUrl,
    ensureFreshSession,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    waitForOpenCodeReady,
    getOpenCodeClient = async () => {
      if (typeof waitForOpenCodeReady === 'function') await waitForOpenCodeReady(10_000, 250);
      return createOpencodeClient({
        baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
        headers: getOpenCodeAuthHeaders(),
      });
    },
    chromeControl,
    computerControl,
    isBrowserMounted,
    fetchImpl,
    runTurn = runVoiceTurn,
  } = dependencies;

  const sessionLookup = createSessionLookup({ getClient: getOpenCodeClient });
  const chromePage = createVoiceChromePage({
    chromeControl,
    readSettings: readSettingsFromDiskMigrated,
    isHostAllowed: (sessionId, host) => controlService.isChromeHostAllowed(sessionId, host),
  });
  const conversation = { pendingApprovalHost: null };
  const availability = {
    chromeAvailable: chromeControl?.available === true,
    computerAvailable: computerControl?.available === true,
  };
  const buildBaseContext = createVoiceContextBuilder({
    listProjects: async () => (await controlService.execute('projects.list', {}))?.projects,
    describeSession: sessionLookup.describe,
    readChromePage: chromePage.read,
    isBrowserMounted,
  });
  app.post('/api/voice/end', (_req, res) => {
    conversation.pendingApprovalHost = null;
    controlService.endChromeConversation?.(VOICE_CHROME_SESSION_ID);
    return res.status(204).end();
  });

  app.post('/api/voice/turn', async (req, res) => {
    const input = readTurnBody(req.body);
    if (!input) return res.status(400).json({ error: 'bad_request' });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnDisconnect);
    res.once('close', abortOnDisconnect);
    const emit = (event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runTurn({
        ...input,
        signal: controller.signal,
        emit,
        deps: {
          brokerBaseUrl,
          ensureFreshSession,
          ...(fetchImpl ? { fetchImpl } : {}),
          controlService,
          readSettings: readSettingsFromDiskMigrated,
          buildContext: (scope) => buildBaseContext({ ...scope, queuedPrompts: input.queuedPrompts }),
          describeSession: sessionLookup.describe,
          buildTools: (settings) => buildVoiceTools({ ...availability, settings }),
          chromePage,
          conversation,
        },
      });
    } catch (error) {
      console.warn(`[voice] turn failed: ${error?.name ?? 'Error'}`);
      if (!controller.signal.aborted) emit({ type: 'error', code: 'upstream_failed' });
    } finally {
      req.off('aborted', abortOnDisconnect);
      res.off('close', abortOnDisconnect);
      if (!res.writableEnded) res.end();
    }
  });
};
