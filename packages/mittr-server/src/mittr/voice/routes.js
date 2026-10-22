import { jsonBody } from '../json-body.js';
import { isLocalRequest } from '../tools/control-routes.js';
import { isPlainObject, trimmedText } from '../values.js';
import { SpeechError } from './speech-client.js';

export const THIS_MAC_ONLY = 'The voice assistant can only be used on this Mac';
export const CONVERSATION_HEADER = 'x-mittr-voice-conversation';

const LOCALES = new Set(['th', 'en']);
const SAID_MAX_CHARS = 4000;
const SYNTHESIZE_MAX_CHARS = 4000;
const HISTORY_MAX_ENTRIES = 60;
const HISTORY_TEXT_MAX_CHARS = 20_000;
const QUEUED_PROMPTS_MAX = 1000;
const AUDIO_LIMIT = '25mb';
const BODY_LIMIT = '2mb';

const MESSAGES = Object.freeze({
  not_signed_in: 'Sign in to Mittr to use dictation',
  not_configured: 'Your Mittr admin has not set up speech models yet',
  unreachable: 'The Mittr platform cannot be reached right now',
  upstream_timeout: 'The Mittr platform cannot be reached right now',
  upstream_failed: 'The Mittr platform cannot be reached right now',
  llm_quota_exhausted: 'Voice input is out of quota this week',
  account_changed: 'The Mittr account changed',
  bad_request: 'A WAV file in the audio field is required',
});

const ENDED = Object.freeze({ error: 'conversation_ended', reasonCode: 'conversation_ended' });
const NOT_HEARD = Object.freeze({ error: 'not_heard', reasonCode: 'not_heard' });

const isOptionalText = (value) => value === undefined || value === null || value === String(value);

export const readTurnBody = (body) => {
  if (!isPlainObject(body)) return null;
  const { said, history, locale, directory, sessionId, queuedPrompts, conversationId, heard, panelOpen } = body;
  if (said !== String(said) || !said.trim() || said.length > SAID_MAX_CHARS) return null;
  if (!LOCALES.has(locale)) return null;
  if (!Array.isArray(history) || history.length > HISTORY_MAX_ENTRIES) return null;
  if (!history.every((entry) => isPlainObject(entry) && (entry.role === 'user' || entry.role === 'assistant') && entry.text === String(entry.text) && entry.text.length <= HISTORY_TEXT_MAX_CHARS)) return null;
  if (!isOptionalText(directory) || !isOptionalText(sessionId)) return null;
  if (queuedPrompts !== undefined && (!Number.isInteger(queuedPrompts) || queuedPrompts < 0 || queuedPrompts > QUEUED_PROMPTS_MAX)) return null;
  if (!trimmedText(conversationId) || !trimmedText(heard)) return null;
  if (panelOpen !== undefined && panelOpen !== true && panelOpen !== false) return null;
  return {
    said: said.trim(),
    history: history.map(({ role, text }) => ({ role, text })),
    locale,
    directory: directory || undefined,
    sessionId: sessionId || undefined,
    queuedPrompts,
    conversationId,
    heard,
    panelOpen: panelOpen === true,
  };
};

const readAudioField = async (req) => {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data') || !Buffer.isBuffer(req.body) || req.body.length === 0) return null;
  const form = await new Request('http://127.0.0.1/', { method: 'POST', headers: { 'content-type': contentType }, body: req.body }).formData().catch(() => null);
  const audio = form?.get('audio');
  if (!audio || audio === String(audio) || audio.size === 0) return null;
  return Buffer.from(await audio.arrayBuffer());
};

const failureBody = (error) => {
  const failure = error instanceof SpeechError ? error : new SpeechError('upstream_failed');
  const body = { error: MESSAGES[failure.reasonCode] ?? MESSAGES.upstream_failed, reasonCode: failure.reasonCode };
  if (failure.reasonCode === 'llm_quota_exhausted') body.resetsAt = failure.resetsAt ?? null;
  return { status: failure.statusCode, body, failure };
};

export function registerVoiceRoutes(app, { express, conversation, runTurn, client, state, requestScope, host, logger = console }) {
  let live = null;

  const stopLive = (conversationId) => {
    if (live && (conversationId === undefined || live.conversationId === conversationId)) {
      live.controller.abort();
      live = null;
    }
  };
  conversation.onEnd((conversationId) => stopLive(conversationId));

  const onlyHere = (req, res, next) => (isLocalRequest(req, { host, requestScope }) ? next() : res.status(403).json({ error: THIS_MAC_ONLY }));

  const closeSignal = (res) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller;
  };

  const speechFailed = (res, route, error, kind) => {
    const { status, body, failure } = failureBody(error);
    if (failure.reasonCode === 'llm_quota_exhausted') state?.block(kind, failure.resetsAt ?? null);
    logger.warn(`[mittr] voice ${route} ${status} ${failure.reasonCode}`);
    return res.status(status).json(body);
  };

  app.post('/api/mittr/voice/start', onlyHere, (_req, res) => res.json({ conversationId: conversation.start() }));

  app.post('/api/mittr/voice/end', onlyHere, jsonBody(express, { limit: '16kb' }), (req, res) => {
    const conversationId = trimmedText(req.body?.conversationId);
    if (conversationId) conversation.end(conversationId);
    return res.status(204).end();
  });

  app.post('/api/mittr/voice/transcribe', onlyHere, express.raw({ type: 'multipart/form-data', limit: AUDIO_LIMIT }), async (req, res) => {
    const conversationId = trimmedText(req.headers[CONVERSATION_HEADER]);
    if (!conversationId || conversationId !== conversation.current()) return res.status(409).json(ENDED);
    const controller = closeSignal(res);
    try {
      const audio = await readAudioField(req);
      if (!audio) throw new SpeechError('bad_request');
      if (!client) throw new SpeechError('unreachable', 503);
      const text = await client.transcribe(audio, controller.signal);
      if (controller.signal.aborted) return undefined;
      state?.clear('stt');
      const heard = conversation.hear(conversationId, text);
      if (!heard) return res.status(409).json(ENDED);
      return res.json({ text, heard });
    } catch (error) {
      if (controller.signal.aborted || res.headersSent) return undefined;
      return speechFailed(res, 'transcribe', error, 'stt');
    }
  });

  app.post('/api/mittr/voice/synthesize', onlyHere, jsonBody(express, { limit: '64kb' }), async (req, res) => {
    const text = req.body?.text;
    if (text !== String(text) || !text.trim() || text.length > SYNTHESIZE_MAX_CHARS) {
      return res.status(400).json({ error: `The text to speak must be 1 to ${SYNTHESIZE_MAX_CHARS} characters`, reasonCode: 'bad_request' });
    }
    const controller = closeSignal(res);
    try {
      if (!client) throw new SpeechError('unreachable', 503);
      const { audio, contentType } = await client.synthesize(text, controller.signal);
      if (controller.signal.aborted) return undefined;
      state?.clear('tts');
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-length', audio.length);
      return res.end(audio);
    } catch (error) {
      if (controller.signal.aborted || res.headersSent) return undefined;
      return speechFailed(res, 'synthesize', error, 'tts');
    }
  });

  app.post('/api/mittr/voice/turn', onlyHere, jsonBody(express, { limit: BODY_LIMIT }), async (req, res) => {
    const input = readTurnBody(req.body);
    if (!input) return res.status(400).json({ error: 'bad_request' });
    if (input.conversationId !== conversation.current()) return res.status(409).json(ENDED);
    if (!conversation.take(input.conversationId, input.heard, input.said)) return res.status(409).json(NOT_HEARD);

    stopLive();
    const controller = new AbortController();
    const mine = { conversationId: input.conversationId, controller };
    live = mine;
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    const emit = (event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const { heard: _heard, ...turn } = input;
    try {
      await runTurn({ ...turn, signal: controller.signal, emit });
    } catch (error) {
      logger.warn(`[mittr] voice turn failed: ${error?.name ?? 'Error'}`);
      if (!controller.signal.aborted) emit({ type: 'error', code: 'upstream_failed' });
    } finally {
      if (live === mine) live = null;
      if (!res.writableEnded) res.end();
    }
    return undefined;
  });

  return { stopLive };
}
