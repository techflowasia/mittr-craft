import crypto from 'node:crypto';

import { createQuotaStreamRewriter, readQuotaExhausted, toEngineRefusal } from './exhausted.js';
import { cameThroughProxy, isLoopbackPeer } from './loopback-guard.js';
import { createStreamMarkupWatcher, describeMarkup } from './response-markup.js';

/** Where the engine's `mittr` provider points: `http://127.0.0.1:<server port>` + this. */
export const SHIM_PREFIX = '/mittr-shim/v1';

const NOT_SIGNED_IN = 'Not signed in to Mittr. Sign in to continue.';
const UNREACHABLE = 'Cannot reach Mittr';
const TIMED_OUT = 'Mittr did not answer in time';
const NO_MODEL_LIST = 'The Mittr model list is not available';
const SWITCHING = 'The Mittr account is changing. Send the message again in a moment.';

// On an answer the shim itself gives up on, where asking again at once cannot
// help: the engine would otherwise retry it several times over.
const NO_RETRY = { 'x-should-retry': 'false' };

// The longest Mittr may stay silent: before it answers, or between two parts
// of a streamed answer. A model can think for a long time, so it is generous,
// but a platform that never answers must not hold a turn open for good.
const UPSTREAM_TIMEOUT_MS = 300_000;

// What the engine reads from a response besides its body: when, and whether,
// to try again.
const PASSED_RESPONSE_HEADERS = ['retry-after', 'retry-after-ms', 'x-should-retry', 'x-request-id'];

const LLM_QUOTA_EXHAUSTED = 'llm_quota_exhausted';
const STREAM_DONE = 'data: [DONE]\n\n';
const CUT_OFF = { error: { type: 'invalid_request_error', code: 'stream_cut_off', message: 'The answer was cut off. Send your message again.' } };
const CUT_OFF_END = `\ndata: ${JSON.stringify(CUT_OFF)}\n\n${STREAM_DONE}`;

const SESSION_ID = /^[\w.:-]{1,128}$/;
const MODEL_ALIAS = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
const NO_BYTES = new Uint8Array(0);

/**
 * The engine's session id for a provider request: `x-opencode-session-id`,
 * which OpenCode 2 sends on every call, then `x-session-id`. Anything that is
 * not a plain id is ignored, since it ends up in logs.
 */
export const sessionIdOf = (headers) => {
  for (const name of ['x-opencode-session-id', 'x-session-id']) {
    const value = typeof headers?.[name] === 'string' ? headers[name].trim() : '';
    if (SESSION_ID.test(value)) return value;
  }
  return null;
};

const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

const bearerOf = (header) => (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '');

/**
 * A timer that aborts the upstream request when Mittr stays silent too long.
 * `arm` restarts it each time Mittr is heard from.
 */
const silenceLimit = (timeoutMs) => {
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  return {
    signal: controller.signal,
    arm() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    },
    stop: () => clearTimeout(timer),
    abort: () => controller.abort(),
    timedOut: () => timedOut,
  };
};

/** The model alias the engine asked for, or null when it is not a plain alias. */
const requestedModelOf = (body) => (typeof body?.model === 'string' && MODEL_ALIAS.test(body.model) ? body.model : null);

const parsedOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isQuotaRefusalLine = (line) => line.startsWith('data:')
  && line.includes(LLM_QUOTA_EXHAUSTED)
  && parsedOrNull(line.slice('data:'.length))?.error?.code === LLM_QUOTA_EXHAUSTED;

const endAtQuotaRefusal = (bytes) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.includes(LLM_QUOTA_EXHAUSTED)) return null;
  const lines = buffer.toString('utf8').split('\n');
  const at = lines.findIndex(isQuotaRefusalLine);
  return at === -1 ? null : Buffer.from(`${lines.slice(0, at + 1).join('\n')}\n\n${STREAM_DONE}`, 'utf8');
};

/** Resolves once the engine has taken what is buffered, or has gone (even before this was called). */
export const drained = (res) => new Promise((resolve) => {
  if (res.destroyed || res.writableEnded) {
    resolve();
    return;
  }
  const done = () => {
    res.off('drain', done);
    res.off('close', done);
    resolve();
  };
  res.on('drain', done);
  res.on('close', done);
});

/**
 * The engine's OpenAI-compatible endpoint. The engine holds only the local
 * key, which opens these routes from this machine and nothing else; the shim
 * alone holds the person's Mittr token and attaches it to what it forwards.
 * A repository's own config can send the engine's requests elsewhere, so the
 * key the engine carries must be worthless anywhere but here.
 *
 * The routes sit outside `/api`: the engine has no UI session. The server
 * parses JSON for every path outside `/api` before plugin routes run.
 *
 * `onAnswer({ sessionId, model, startedAt, requestId, chunk, done })` hears each part of
 * every successful answer, then once more with `done: true`. `model` is the
 * alias the engine asked for (or null) and `startedAt` when the request came
 * in, so a listener can match the answer to the engine's message. `requestId`
 * is unique to the request, so a listener can tell apart two that started together.
 *
 * Returns `{ abortInFlight }`, which cuts every answer still streaming.
 */
export function registerMittrShim(app, {
  upstreamV1,
  localToken,
  ensureFreshSession,
  engineOnActiveHome = () => true,
  listModels = () => [],
  onAnswer = () => {},
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  env = process.env,
  now = Date.now,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
}) {
  // Answers on their way from Mittr with a signed-in account's token.
  const inFlight = new Set();
  let requestCount = 0;

  const expectedKey = digest(localToken);
  const presentsKey = (header) => {
    const presented = bearerOf(header);
    return presented.length > 0 && crypto.timingSafeEqual(digest(presented), expectedKey);
  };
  const completionsUrl = `${upstreamV1.replace(/\/+$/, '')}/chat/completions`;
  const logCalls = env.MITTRCRAFT_SHIM_LOG === '1';
  // Method, path, status and session only: never a body or a token.
  const logCall = (status, sessionId) => {
    if (logCalls) logger.log(`[mittr] shim POST /chat/completions ${status} session=${sessionId ?? '-'}`);
  };

  const reportMarkup = (result, model) => {
    if (result.kind === 'tool-calls-lost') {
      // Nothing else errors when this happens, so this line is the only warning anyone gets.
      logger.error(`[mittr] tool-calls-lost: model ${model} wrote a tool call as text and returned none (${result.markers.join(' ')}). The gateway's tool parser most likely does not match this model.`);
    } else if (result.kind === 'channel-markup') {
      logger.warn(`[mittr] channel-markup: model ${model} leaked markup into its answer (${result.markers.join(' ')})`);
    }
  };

  // One per request: a listener that fails on every chunk is logged once.
  const answerListener = () => {
    let failed = false;
    return (event) => {
      try {
        onAnswer(event);
      } catch (error) {
        if (!failed) logger.error('[mittr] shim answer listener failed:', error?.message ?? error);
        failed = true;
      }
    };
  };

  const guard = (req, res, next) => {
    if (!isLoopbackPeer(req.socket?.remoteAddress) || cameThroughProxy(req.headers)) return res.status(403).json({ error: 'Forbidden' });
    if (!presentsKey(req.headers.authorization)) return res.status(401).json({ error: 'Unauthorized' });
    if (!engineOnActiveHome()) return res.status(503).set(NO_RETRY).json({ error: SWITCHING });
    return next();
  };

  const passHeaders = (upstream, res) => {
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/json');
  };

  const chatCompletions = async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid request body' });
    const startedAt = now();
    const sessionId = sessionIdOf(req.headers);
    const requestedModel = requestedModelOf(req.body);
    const model = JSON.stringify(requestedModel);
    const limit = silenceLimit(upstreamTimeoutMs);
    const listener = answerListener();
    const requestId = ++requestCount;
    let engineGone = false;
    const tellAnswer = (event) => {
      if (engineGone) return;
      listener({ ...event, sessionId, model: requestedModel, startedAt, requestId });
    };
    res.on('close', () => {
      inFlight.delete(res);
      if (res.writableFinished) return;
      engineGone = true;
      limit.abort();
    });

    let session = null;
    try {
      session = await ensureFreshSession();
    } catch (error) {
      logger.error('[mittr] shim could not read the Mittr sign-in:', error?.message ?? error);
    }
    if (engineGone) return undefined;
    if (!session?.accessToken) return res.status(401).json({ error: NOT_SIGNED_IN });
    if (!engineOnActiveHome()) return res.status(503).set(NO_RETRY).json({ error: SWITCHING });
    inFlight.add(res);

    let upstream;
    limit.arm();
    try {
      // A new set of headers: nothing the engine sent, its key above all,
      // travels on. What goes onward is the person's own session.
      upstream = await fetchImpl(completionsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(req.body),
        signal: limit.signal,
      });
    } catch (error) {
      limit.stop();
      logCall(limit.timedOut() ? 'timeout' : 'failed', sessionId);
      if (engineGone) return undefined;
      if (limit.timedOut()) return res.status(504).set(NO_RETRY).json({ error: TIMED_OUT });
      logger.error('[mittr] shim could not reach Mittr:', error?.message ?? error);
      return res.status(502).json({ error: UNREACHABLE });
    }
    logCall(upstream.status, sessionId);

    if (!(req.body.stream && upstream.ok && upstream.body)) {
      let bytes;
      try {
        limit.arm();
        bytes = new Uint8Array(await upstream.arrayBuffer());
      } catch (error) {
        if (engineGone) return undefined;
        logger.error('[mittr] shim lost the answer from Mittr:', error?.message ?? error);
        return limit.timedOut() ? res.status(504).set(NO_RETRY).json({ error: TIMED_OUT }) : res.status(502).json({ error: UNREACHABLE });
      } finally {
        limit.stop();
      }
      const answer = parsedOrNull(Buffer.from(bytes).toString('utf8'));
      const quota = readQuotaExhausted(answer);
      if (quota) {
        const refusal = toEngineRefusal(quota);
        return res.status(refusal.status).set(refusal.headers).json(refusal.body);
      }
      if (upstream.ok) {
        tellAnswer({ chunk: bytes, done: false });
        tellAnswer({ chunk: NO_BYTES, done: true });
        try {
          const message = answer?.choices?.[0]?.message;
          reportMarkup(describeMarkup({ content: message?.content, hasToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0 }), model);
        } catch {
          // Inspecting the answer is diagnostics; it must never cost the answer.
        }
      }
      res.status(upstream.status);
      passHeaders(upstream, res);
      return res.end(bytes);
    }

    res.status(upstream.status);
    passHeaders(upstream, res);
    res.setHeader('cache-control', 'no-cache, no-transform');
    // Anything that buffers this stream turns a live agent into a long pause
    // followed by a wall of text.
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();

    const watcher = createStreamMarkupWatcher();
    const quotaFrames = createQuotaStreamRewriter();
    const send = async (bytes) => {
      if (bytes.length === 0) return;
      watcher.observe(bytes);
      tellAnswer({ chunk: bytes, done: false });
      if (engineGone) return;
      if (!res.write(bytes)) await drained(res);
    };
    try {
      limit.arm();
      let refused = false;
      for await (const chunk of upstream.body) {
        const bytes = quotaFrames.push(chunk);
        const refusal = endAtQuotaRefusal(bytes);
        await send(refusal ?? bytes);
        if (engineGone) return undefined;
        refused = refusal !== null;
        if (refused) break;
        limit.arm();
      }
      if (refused) {
        limit.abort();
      } else {
        const rest = quotaFrames.end();
        await send(endAtQuotaRefusal(rest) ?? rest);
        if (engineGone) return undefined;
      }
    } catch (error) {
      if (engineGone) return undefined;
      logger.error(`[mittr] shim cut the answer: ${limit.timedOut() ? 'Mittr went silent' : `the stream from Mittr broke (${error?.message ?? error})`}`);
      return res.end(CUT_OFF_END);
    } finally {
      limit.stop();
    }
    tellAnswer({ chunk: NO_BYTES, done: true });
    reportMarkup(watcher.finish(), model);
    return res.end();
  };

  const models = async (_req, res) => {
    let list;
    try {
      list = await listModels();
    } catch (error) {
      // An empty list would read as "you have no models", which is not what happened.
      logger.error('[mittr] shim could not read the model list:', error?.message ?? error);
      return res.status(503).set(NO_RETRY).json({ error: NO_MODEL_LIST });
    }
    return res.json({ object: 'list', data: list.map(({ alias }) => ({ id: alias, object: 'model' })) });
  };

  app.use(SHIM_PREFIX, guard);
  app.post(`${SHIM_PREFIX}/chat/completions`, chatCompletions);
  app.get(`${SHIM_PREFIX}/models`, models);
  app.use(SHIM_PREFIX, (_req, res) => res.status(404).json({ error: 'Not found' }));

  return {
    /**
     * Cuts every answer still coming from Mittr. Called when the active
     * account changes or signs out, so nothing keeps streaming on a token
     * that is no longer the person's choice.
     */
    abortInFlight() {
      const cut = [...inFlight];
      inFlight.clear();
      for (const res of cut) res.destroy();
      if (cut.length > 0) logger.warn(`[mittr] shim ended ${cut.length} answer(s): the Mittr account changed`);
      return cut.length;
    },
  };
}
