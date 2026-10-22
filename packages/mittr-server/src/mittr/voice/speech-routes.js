import { jsonBody } from '../json-body.js';
import { cameThroughProxy, isLoopbackPeer } from '../loopback-guard.js';
import { isLocalRequest } from '../tools/control-routes.js';
import { isPlainObject } from '../values.js';
import { pcm16ToWav, pcmFormatOf, splitSpeechText } from './audio.js';
import { SpeechError } from './speech-client.js';
import { SPEECH_KEY_KINDS } from './speech-key.js';
import { formatResetTime } from './speech-state.js';

export const SPEECH_PREFIX = '/mittr-speech/v1';
export const MITTR_SPEECH_MODEL = 'mittr';
export const MITTR_SPEECH_VOICE = 'mittr';
export const SPEECH_INPUT_MAX_CHARS = 64_000;
export const THIS_MAC_ONLY = 'These settings can be changed only on this Mac';

const TRANSCRIBE_LIMIT = '25mb';
const STATE_WAIT_MS = 25_000;
export const STT_KEY_SETTLE_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const NOT_OUR_KEY = { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Not a MittrCraft speech key' } };
const CANNOT_REACH = 'The Mittr platform cannot be reached right now';
const CANNOT_JOIN = 'The Mittr platform returned audio this app cannot join';
const CANNOT_PLAY = 'The Mittr platform returned audio this app cannot play';
const NO_AUDIO = 'The Mittr platform returned no audio';

const MESSAGES = Object.freeze({
  not_signed_in: 'Sign in to Mittr to use dictation',
  not_configured: 'Your Mittr admin has not set up speech models yet',
  unreachable: CANNOT_REACH,
  upstream_timeout: CANNOT_REACH,
  upstream_failed: CANNOT_REACH,
  account_changed: 'The Mittr account changed',
  audio_too_large: 'This recording is too long for Mittr speech',
  bad_request: 'Mittr speech could not use this request',
});

const UNREACHABLE_READINESS = Object.freeze({ listen: false, speak: false, voice: false, signedIn: false, voiceSilenceMs: null, reason: 'unreachable' });

const bearerOf = (header) => {
  const match = /^Bearer\s+(.+)$/i.exec(String(header ?? ''));
  return match ? match[1].trim() : '';
};

export const isSpeechCaller = (req, keys) => isLoopbackPeer(req.socket?.remoteAddress)
  && !cameThroughProxy(req.headers)
  && keys.matches(bearerOf(req.headers?.authorization));

export const isMittrSpeechUrl = (value) => {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && url.pathname.replace(/\/+$/, '') === SPEECH_PREFIX;
  } catch {
    return false;
  }
};

const messageOf = (error, kind) => {
  if (error.reasonCode === 'llm_quota_exhausted') {
    return kind === 'stt'
      ? `Voice input is out of quota until ${formatResetTime(error.resetsAt)}`
      : 'Spoken replies are out of quota this week — answering in text';
  }
  return MESSAGES[error.reasonCode] ?? CANNOT_REACH;
};

const typeOf = (error) => {
  if (error.reasonCode === 'llm_quota_exhausted') return 'insufficient_quota';
  return error.statusCode < 500 ? 'invalid_request_error' : 'server_error';
};

const toSpeechError = (error) => (error instanceof SpeechError ? error : new SpeechError('upstream_failed'));

const readFilePart = async (req) => {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data') || !Buffer.isBuffer(req.body) || req.body.length === 0) return null;
  const form = await new Request('http://127.0.0.1/', { method: 'POST', headers: { 'content-type': contentType }, body: req.body }).formData().catch(() => null);
  const file = form?.get('file');
  if (!file || file === String(file) || file.size === 0) return null;
  return Buffer.from(await file.arrayBuffer());
};

const joinParts = (spoken) => {
  const formats = spoken.map(({ contentType }) => pcmFormatOf(contentType));
  if (formats.every(Boolean)) {
    if (formats.some((format) => format.channels !== 1)) throw new SpeechError('upstream_failed', 502, { text: CANNOT_PLAY });
    if (new Set(formats.map((format) => format.rate)).size > 1) throw new SpeechError('upstream_failed', 502, { text: CANNOT_JOIN });
    const samples = spoken.map(({ audio }, index) => {
      const even = Buffer.from(audio.subarray(0, audio.length & ~1));
      return formats[index].swap ? even.swap16() : even;
    });
    return { audio: pcm16ToWav(Buffer.concat(samples), formats[0].rate), contentType: 'audio/wav' };
  }
  if (spoken.length > 1) throw new SpeechError('upstream_failed', 502, { text: CANNOT_JOIN });
  return spoken[0];
};

export function registerSpeechRoutes(app, { express, client, keys, state, offered, requestScope, host, port, carry, upstreamSettings, logger = console, now = Date.now }) {
  const local = (req) => isLocalRequest(req, { host, requestScope });
  let sttKeyInstalledAt = null;

  const abortOnClose = (req, res) => {
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller.signal;
  };

  const refuse = (res, route, error, kind) => {
    const failure = toSpeechError(error);
    if (failure.reasonCode === 'llm_quota_exhausted') state.block(kind, failure.resetsAt ?? null);
    logger.warn(`[mittr] speech ${route} ${failure.statusCode} ${failure.reasonCode}`);
    const body = { type: typeOf(failure), code: failure.reasonCode, message: failure.text ?? messageOf(failure, kind) };
    if (failure.reasonCode === 'llm_quota_exhausted') body.resets_at = failure.resetsAt ?? null;
    res.setHeader('x-should-retry', 'false');
    return res.status(failure.statusCode).json({ error: body });
  };

  const forgetStaleSttKey = async () => {
    if (!offered || !keys.installed().stt) return;
    if (sttKeyInstalledAt !== null && now() - sttKeyInstalledAt < STT_KEY_SETTLE_MS) return;
    const settings = await Promise.resolve().then(() => upstreamSettings?.read()).catch(() => null);
    if (settings?.sttProvider === 'openai-compatible' && isMittrSpeechUrl(settings.sttServerUrl)) return;
    try {
      keys.remove('stt');
    } catch (error) {
      logger.warn('[mittr] could not take back the dictation speech key:', error?.name ?? 'Error');
    }
  };

  if (offered) {
    app.use(SPEECH_PREFIX, (req, res, next) => (isSpeechCaller(req, keys) ? next() : res.status(401).json(NOT_OUR_KEY)));

    app.post(`${SPEECH_PREFIX}/audio/transcriptions`, express.raw({ type: 'multipart/form-data', limit: TRANSCRIBE_LIMIT }), async (req, res) => {
      const route = 'audio/transcriptions';
      const signal = abortOnClose(req, res);
      try {
        const wav = await readFilePart(req);
        if (!wav) throw new SpeechError('bad_request');
        if (!client) throw new SpeechError('unreachable', 503);
        const text = await client.transcribe(wav, signal);
        if (signal.aborted) return undefined;
        state.clear('stt');
        return res.json({ text });
      } catch (error) {
        if (signal.aborted || res.headersSent) return undefined;
        return refuse(res, route, error, 'stt');
      }
    });

    app.post(`${SPEECH_PREFIX}/audio/speech`, express.json(), async (req, res) => {
      const route = 'audio/speech';
      const signal = abortOnClose(req, res);
      try {
        const input = req.body?.input;
        if (input !== String(input) || !input.trim() || input.length > SPEECH_INPUT_MAX_CHARS) throw new SpeechError('bad_request');
        if (!client) throw new SpeechError('unreachable', 503);
        const parts = splitSpeechText(input);
        const spoken = [];
        for (const part of parts) {
          const answer = await client.synthesize(part, signal);
          if (!answer.contentType.split(';')[0].trim().toLowerCase().startsWith('audio/')) throw new SpeechError('upstream_failed', 502, { text: NO_AUDIO });
          if (!pcmFormatOf(answer.contentType) && parts.length > 1) throw new SpeechError('upstream_failed', 502, { text: CANNOT_JOIN });
          spoken.push(answer);
        }
        const { audio, contentType } = joinParts(spoken);
        if (signal.aborted) return undefined;
        state.clear('tts');
        res.setHeader('content-type', contentType);
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('content-length', audio.length);
        return res.end(audio);
      } catch (error) {
        if (signal.aborted || res.headersSent) return undefined;
        return refuse(res, route, error, 'tts');
      }
    });
  }

  app.get('/api/mittr/voice/readiness', async (req, res) => {
    const here = local(req);
    if (!client) return res.json({ ...UNREACHABLE_READINESS, here });
    try {
      const readiness = await client.readiness();
      return res.json({
        listen: readiness.ready?.listen === true,
        speak: readiness.ready?.speak === true,
        voice: readiness.ready?.voice === true,
        signedIn: readiness.signedIn === true,
        voiceSilenceMs: Number.isFinite(readiness.voiceSilenceMs) ? readiness.voiceSilenceMs : null,
        reason: readiness.reason ?? null,
        here,
      });
    } catch {
      return res.json({ ...UNREACHABLE_READINESS, here });
    }
  });

  app.get('/api/mittr/speech/state', async (req, res) => {
    const signal = abortOnClose(req, res);
    const since = req.query?.since === undefined ? -1 : Number(req.query.since);
    const view = await state.waitForChange(Number.isInteger(since) ? since : -1, STATE_WAIT_MS, signal);
    if (!signal.aborted) res.json(view);
  });

  const speechView = async () => {
    await forgetStaleSttKey();
    const serverPort = port();
    const baseUrl = offered && Number.isInteger(serverPort) ? `http://127.0.0.1:${serverPort}${SPEECH_PREFIX}` : null;
    const here = baseUrl !== null;
    return {
      offered: here,
      baseUrl,
      model: MITTR_SPEECH_MODEL,
      voice: MITTR_SPEECH_VOICE,
      installed: here ? keys.installed() : { stt: false, openaiCompatible: false },
      carryDictation: here ? await carry.pending() : false,
    };
  };

  app.get('/api/mittr/speech', async (_req, res) => res.json(await speechView()));

  app.put('/api/mittr/speech/key', jsonBody(express, { limit: '16kb' }), async (req, res) => {
    if (!offered || !local(req)) return res.status(403).json({ error: THIS_MAC_ONLY });
    const patch = req.body;
    const named = isPlainObject(patch) ? Object.keys(patch) : [];
    if (named.length === 0 || named.some((kind) => !SPEECH_KEY_KINDS.includes(kind) || (patch[kind] !== true && patch[kind] !== false))) {
      return res.status(400).json({ error: 'Name stt or openaiCompatible, each true or false' });
    }
    try {
      const install = named.filter((kind) => patch[kind] === true);
      if (install.length > 0) keys.install(install);
      if (install.includes('stt')) sttKeyInstalledAt = now();
      for (const kind of named.filter((name) => patch[name] === false)) keys.remove(kind);
    } catch (error) {
      logger.warn('[mittr] could not change the speech key:', error?.name ?? 'Error');
      return res.status(500).json({ error: 'The speech key could not be saved' });
    }
    return res.json({ installed: keys.installed() });
  });

  app.post('/api/mittr/speech/carried', async (req, res) => {
    if (!offered || !local(req)) return res.status(403).json({ error: THIS_MAC_ONLY });
    await carry.done();
    return res.status(204).end();
  });

  return { forgetStaleSttKey };
}
