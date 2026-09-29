const READINESS_TTL_MS = 30_000;
const READINESS_TIMEOUT_MS = 10_000;
const SPEECH_TIMEOUT_MS = 60_000;

const STATUS_BY_REASON = {
  not_signed_in: 401,
  not_configured: 503,
  unreachable: 502,
  upstream_timeout: 504,
  upstream_failed: 502,
  audio_too_large: 413,
  bad_request: 400,
};

const createSpeechError = (reasonCode, statusCode = STATUS_BY_REASON[reasonCode] ?? 502) => {
  const error = new Error(`Mittr speech failed: ${reasonCode}`);
  error.reasonCode = reasonCode;
  error.statusCode = statusCode;
  return error;
};

const isSessionRefused = (status) => status === 401 || status === 403;

const notReady = { listen: false, speak: false, voice: false };

export const createMittrSpeechClient = ({
  brokerBaseUrl,
  ensureFreshSession,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) => {
  if (!brokerBaseUrl || typeof ensureFreshSession !== 'function') return null;

  const urlFor = (path) => new URL(path, brokerBaseUrl).toString();
  let cachedReadiness = null;

  const accessTokenOrNull = async () => {
    const session = await ensureFreshSession();
    return session?.accessToken || null;
  };

  const request = async (path, init, signal, timeoutMs) => {
    const accessToken = await accessTokenOrNull();
    if (!accessToken) throw createSpeechError('not_signed_in');
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(urlFor(path), {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw createSpeechError('upstream_timeout');
      throw createSpeechError('unreachable');
    }
    if (response.ok) return response;
    if (isSessionRefused(response.status)) throw createSpeechError('not_signed_in');
    const body = await response.json().catch(() => null);
    const code = typeof body?.code === 'string' && body.code ? body.code : 'upstream_failed';
    throw createSpeechError(code, response.status);
  };

  const readFromPlatform = async (accessToken) => {
    let response;
    try {
      response = await fetchImpl(urlFor('/desktop/speech/readiness'), {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
      });
    } catch {
      return { cacheable: false, value: { signedIn: true, ready: notReady, reason: 'unreachable' } };
    }
    if (isSessionRefused(response.status)) {
      return { cacheable: false, value: { signedIn: false, ready: notReady, reason: 'not_signed_in' } };
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || typeof body !== 'object') {
      const reason = body?.code === 'not_configured' ? 'not_configured' : 'unreachable';
      return { cacheable: reason === 'not_configured', value: { signedIn: true, ready: notReady, reason } };
    }
    const ready = {
      listen: body.listen?.ready === true,
      speak: body.speak?.ready === true,
      voice: body.voice?.ready === true,
    };
    const allReady = ready.listen && ready.speak && ready.voice;
    return {
      cacheable: true,
      value: {
        signedIn: true,
        ready,
        ...(Number.isFinite(body.silenceMs) ? { silenceMs: body.silenceMs } : {}),
        ...(Number.isFinite(body.voiceSilenceMs) ? { voiceSilenceMs: body.voiceSilenceMs } : {}),
        reason: allReady ? null : 'not_configured',
      },
    };
  };

  const readiness = async () => {
    const accessToken = await accessTokenOrNull();
    if (!accessToken) {
      cachedReadiness = null;
      return { signedIn: false, ready: notReady, reason: 'not_signed_in' };
    }
    if (cachedReadiness && cachedReadiness.accessToken === accessToken && now() - cachedReadiness.at < READINESS_TTL_MS) {
      return cachedReadiness.value;
    }
    const { cacheable, value } = await readFromPlatform(accessToken);
    cachedReadiness = cacheable ? { accessToken, at: now(), value } : null;
    return value;
  };

  const transcribe = async (wavBuffer, signal) => {
    const form = new FormData();
    form.append('audio', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    try {
      const response = await request('/desktop/speech/transcribe', { method: 'POST', headers: {}, body: form }, signal, SPEECH_TIMEOUT_MS);
      const body = await response.json().catch(() => null);
      return typeof body?.text === 'string' ? body.text : '';
    } catch (error) {
      if (error?.reasonCode === 'empty_transcript') return '';
      throw error;
    }
  };

  const synthesize = async (text, signal) => {
    const response = await request(
      '/desktop/speech/synthesize',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
      signal,
      SPEECH_TIMEOUT_MS,
    );
    return {
      body: response.body,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
    };
  };

  return { readiness, transcribe, synthesize };
};
