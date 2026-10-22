import { readQuotaExhausted } from '../exhausted.js';
import { SPEECH_READINESS_TIMEOUT_MS, SPEECH_TIMEOUT_MS } from '../platform.js';
import { pinAccount, sessionKeyOf } from '../tools/account-guard.js';
import { trimmedText } from '../values.js';

const READINESS_TTL_MS = 30_000;

const STATUS_BY_REASON = Object.freeze({
  not_signed_in: 401,
  not_configured: 503,
  unreachable: 502,
  upstream_timeout: 504,
  upstream_failed: 502,
  audio_too_large: 413,
  bad_request: 400,
  account_changed: 409,
});

export class SpeechError extends Error {
  constructor(reasonCode, statusCode = STATUS_BY_REASON[reasonCode] ?? 502, extra = {}) {
    super(`Mittr speech failed: ${reasonCode}`);
    this.name = 'SpeechError';
    this.reasonCode = reasonCode;
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

const NOT_READY = Object.freeze({ listen: false, speak: false, voice: false });

const isSessionRefused = (status) => status === 401 || status === 403;
const isSpeechMissing = (status, code) => status === 404 || (status === 503 && !code);
const isTimeout = (error) => error?.name === 'TimeoutError';

const codeOf = (body) => trimmedText(body?.code);

const failureOf = (response, body) => {
  if (isSessionRefused(response.status)) return new SpeechError('not_signed_in');
  const quota = readQuotaExhausted(body);
  if (quota) return new SpeechError('llm_quota_exhausted', response.status, { kind: quota.kind, resetsAt: quota.resetsAt });
  const code = codeOf(body);
  if (code === 'not_configured' || isSpeechMissing(response.status, code)) return new SpeechError('not_configured');
  if (code && Object.hasOwn(STATUS_BY_REASON, code)) return new SpeechError(code);
  return new SpeechError(code ?? 'upstream_failed', response.status);
};

export function createMittrSpeechClient({ broker, ensureFreshSession, fetchImpl = (...args) => fetch(...args), activeAccountKey, now = Date.now } = {}) {
  if (!broker?.baseUrl || !(ensureFreshSession instanceof Function) || !(activeAccountKey instanceof Function)) return null;
  const urlFor = (route) => new URL(route, broker.baseUrl).toString();
  let cachedReadiness = null;

  const pinned = () => {
    const check = pinAccount({ activeAccountKey, engineOnActiveHome: () => true });
    return (sessionKey) => {
      try {
        check(sessionKey);
      } catch {
        throw new SpeechError('account_changed');
      }
    };
  };

  const freshSession = () => Promise.resolve().then(ensureFreshSession).catch(() => null);

  const call = async (route, init, signal, read) => {
    const ensureSameAccount = pinned();
    ensureSameAccount();
    const session = await freshSession();
    if (!session?.accessToken) throw new SpeechError('not_signed_in');
    ensureSameAccount(sessionKeyOf(session));
    const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let answer;
    try {
      const response = await fetchImpl(urlFor(route), {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${session.accessToken}` },
        signal: combined,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw failureOf(response, body);
      }
      answer = await read(response);
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      if (signal?.aborted) throw error;
      if (timeout.aborted || isTimeout(error)) throw new SpeechError('upstream_timeout');
      throw new SpeechError('unreachable');
    }
    ensureSameAccount();
    return answer;
  };

  const readFromPlatform = async (accessToken) => {
    let response;
    try {
      response = await fetchImpl(urlFor('/desktop/speech/readiness'), {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(SPEECH_READINESS_TIMEOUT_MS),
      });
    } catch {
      return { cacheable: false, value: { signedIn: true, ready: NOT_READY, reason: 'unreachable' } };
    }
    if (isSessionRefused(response.status)) return { cacheable: false, value: { signedIn: false, ready: NOT_READY, reason: 'not_signed_in' } };
    const body = await response.json().catch(() => null);
    if (!response.ok || body === null || typeof body !== 'object') {
      const code = codeOf(body);
      const reason = code === 'not_configured' || isSpeechMissing(response.status, code) ? 'not_configured' : 'unreachable';
      return { cacheable: reason === 'not_configured', value: { signedIn: true, ready: NOT_READY, reason } };
    }
    const ready = { listen: body.listen?.ready === true, speak: body.speak?.ready === true, voice: body.voice?.ready === true };
    return {
      cacheable: true,
      value: {
        signedIn: true,
        ready,
        ...(Number.isFinite(body.silenceMs) ? { silenceMs: body.silenceMs } : {}),
        ...(Number.isFinite(body.voiceSilenceMs) ? { voiceSilenceMs: body.voiceSilenceMs } : {}),
        reason: ready.listen && ready.speak && ready.voice ? null : 'not_configured',
      },
    };
  };

  const readiness = async () => {
    const accessToken = (await freshSession())?.accessToken;
    if (!accessToken) {
      cachedReadiness = null;
      return { signedIn: false, ready: NOT_READY, reason: 'not_signed_in' };
    }
    if (cachedReadiness?.accessToken === accessToken && now() - cachedReadiness.at < READINESS_TTL_MS) return cachedReadiness.value;
    const { cacheable, value } = await readFromPlatform(accessToken);
    cachedReadiness = cacheable ? { accessToken, at: now(), value } : null;
    return value;
  };

  const transcribe = async (wav, signal) => {
    const form = new FormData();
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    try {
      return await call('/desktop/speech/transcribe', { method: 'POST', headers: {}, body: form }, signal, async (response) => {
        const body = await response.json().catch(() => null);
        return body?.text === String(body?.text) ? body.text : '';
      });
    } catch (error) {
      if (error?.reasonCode === 'empty_transcript') return '';
      throw error;
    }
  };

  const synthesize = (text, signal) => call(
    '/desktop/speech/synthesize',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
    signal,
    async (response) => ({
      audio: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
    }),
  );

  return { readiness, transcribe, synthesize };
}
