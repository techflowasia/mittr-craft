import crypto from 'node:crypto';

import { cameThroughProxy, isLoopbackPeer } from './loopback-guard.js';
import { createStreamMarkupWatcher, describeMarkup } from './response-markup.js';

/** Where the engine's `mittr` provider points: `http://127.0.0.1:<server port>` + this. */
export const SHIM_PREFIX = '/mittr-shim/v1';

const NOT_SIGNED_IN = 'Not signed in to Mittr. Sign in to continue.';
const UNREACHABLE = 'Cannot reach Mittr';
const TIMED_OUT = 'Mittr did not answer in time';
const NO_MODEL_LIST = 'The Mittr model list is not available';

// The longest Mittr may stay silent: before it answers, or between two parts
// of a streamed answer. A model can think for a long time, so it is generous,
// but a platform that never answers must not hold a turn open for good.
const UPSTREAM_TIMEOUT_MS = 300_000;

// What the engine reads from a response besides its body: when, and whether,
// to try again.
const PASSED_RESPONSE_HEADERS = ['retry-after', 'retry-after-ms', 'x-should-retry', 'x-request-id'];

const SESSION_ID = /^[\w.:-]{1,128}$/;
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

/** Resolves once the engine has taken what is buffered, or has gone. */
const drained = (res) => new Promise((resolve) => {
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
 */
export function registerMittrShim(app, {
  upstreamV1,
  localToken,
  ensureFreshSession,
  listModels = () => [],
  onAnswer = () => {},
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  env = process.env,
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
}) {
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
    const sessionId = sessionIdOf(req.headers);
    const model = JSON.stringify(typeof req.body.model === 'string' ? req.body.model.slice(0, 200) : null);
    const limit = silenceLimit(upstreamTimeoutMs);
    const tellAnswer = answerListener();
    let engineGone = false;
    res.on('close', () => {
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
      if (limit.timedOut()) return res.status(504).json({ error: TIMED_OUT });
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
        return limit.timedOut() ? res.status(504).json({ error: TIMED_OUT }) : res.status(502).json({ error: UNREACHABLE });
      } finally {
        limit.stop();
      }
      if (upstream.ok) {
        tellAnswer({ sessionId, chunk: bytes, done: false });
        tellAnswer({ sessionId, chunk: NO_BYTES, done: true });
        try {
          const message = JSON.parse(Buffer.from(bytes).toString('utf8'))?.choices?.[0]?.message;
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
    try {
      limit.arm();
      for await (const chunk of upstream.body) {
        watcher.observe(chunk);
        tellAnswer({ sessionId, chunk, done: false });
        if (!res.write(chunk)) await drained(res);
        if (engineGone) return undefined;
        limit.arm();
      }
    } catch (error) {
      if (engineGone) return undefined;
      logger.error(`[mittr] shim cut the answer: ${limit.timedOut() ? 'Mittr went silent' : `the stream from Mittr broke (${error?.message ?? error})`}`);
      // Ending the response would hand the engine half an answer as if it
      // were whole. Cutting the connection reads as the failure it is.
      res.destroy();
      return undefined;
    } finally {
      limit.stop();
    }
    tellAnswer({ sessionId, chunk: NO_BYTES, done: true });
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
      return res.status(503).json({ error: NO_MODEL_LIST });
    }
    return res.json({ object: 'list', data: list.map(({ alias }) => ({ id: alias, object: 'model' })) });
  };

  app.use(SHIM_PREFIX, guard);
  app.post(`${SHIM_PREFIX}/chat/completions`, chatCompletions);
  app.get(`${SHIM_PREFIX}/models`, models);
  app.use(SHIM_PREFIX, (_req, res) => res.status(404).json({ error: 'Not found' }));
}
