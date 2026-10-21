import crypto from 'node:crypto';

import { isRecord } from '../values.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';

export const CHROME_PERMISSION = MITTR_TOOLS.chrome;
const DECISION_WAIT_MS = 10_000;
const PENDING_POLL_MS = 5_000;
const DENY_RETRY_MS = 500;
const EARLY_LIMIT = 64;
const ENGINE_TIMEOUT_MS = 5_000;

const CANCELLED = 'Cancelled while waiting for the user';
const REPLIES = new Set(['once', 'always', 'reject']);
const LOST = Symbol('lost');

const keyFor = (sessionId, host) => `${sessionId}\n${host}`;
const textOf = (value) => (value === String(value) && value.trim() ? value.trim() : null);

export const isChromePermission = (permission) => permission?.action === CHROME_PERMISSION;

export const chromeQuestion = (host) => `Allow the agent to use your Chrome sign-in on ${host}?`;

const cancelled = () => new Error(CANCELLED);
const isCancelled = (error) => error instanceof Error && error.message === CANCELLED;

export function createChromeApprovals({ settings, logger = console }) {
  const sessionGrants = new Map();
  const waiters = new Map();
  let queue = Promise.resolve();

  const serialized = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  const approvedHosts = async () => (await settings.read()).tools.chromeApprovedHosts;

  const isApproved = async (sessionId, host) => sessionGrants.get(sessionId)?.has(host) === true || (await approvedHosts()).includes(host);

  const grant = (sessionId, host) => {
    const grants = sessionGrants.get(sessionId) ?? new Set();
    grants.add(host);
    sessionGrants.set(sessionId, grants);
  };

  const settle = (key, reply) => {
    for (const waiter of [...(waiters.get(key) ?? [])]) waiter.resolve(reply);
  };

  const saveHost = (host) => serialized(async () => {
    const hosts = await approvedHosts();
    if (!hosts.includes(host)) await settings.update({ tools: { chromeApprovedHosts: [...hosts, host] } });
  });

  const record = async (sessionId, host, reply) => {
    if (!REPLIES.has(reply)) throw new TypeError('reply must be once, always or reject');
    if (reply === 'always') {
      await saveHost(host).catch((error) => {
        logger.warn('[mittr] could not save an always-allowed Chrome site; it stays allowed for this conversation only:', error?.message ?? error);
      });
    }
    if (reply !== 'reject') grant(sessionId, host);
    settle(keyFor(sessionId, host), reply);
  };

  const awaitDecision = (sessionId, host, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const key = keyFor(sessionId, host);
    const listed = waiters.get(key) ?? new Set();
    waiters.set(key, listed);
    const stop = () => {
      signal?.removeEventListener('abort', onAbort);
      listed.delete(waiter);
      if (listed.size === 0 && waiters.get(key) === listed) waiters.delete(key);
    };
    const waiter = {
      resolve: (reply) => {
        stop();
        resolve(reply);
      },
      reject: (error) => {
        stop();
        reject(error);
      },
    };
    const onAbort = () => waiter.reject(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    listed.add(waiter);
  });

  const removeHost = (host) => serialized(async () => {
    for (const grants of sessionGrants.values()) grants.delete(host);
    const next = (await approvedHosts()).filter((entry) => entry !== host);
    await settings.update({ tools: { chromeApprovedHosts: next } });
    return next;
  });

  const forgetSession = (sessionId) => {
    sessionGrants.delete(sessionId);
  };

  const forgetAll = () => {
    sessionGrants.clear();
    for (const listed of [...waiters.values()]) {
      for (const waiter of [...listed]) waiter.reject(cancelled());
    }
  };

  return { isApproved, awaitDecision, record, removeHost, forgetSession, forgetAll };
}

const unwrapped = (value) => (isRecord(value) && Object.hasOwn(value, 'data') ? value.data : value);

export function createEnginePermissions({ opencode, fetchImpl = fetch, timeoutMs = ENGINE_TIMEOUT_MS }) {
  const call = async (route, { method = 'GET', body, directory } = {}) => {
    const headers = { accept: 'application/json', ...opencode.authHeaders() };
    if (body) headers['content-type'] = 'application/json';
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(directory);
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body) init.body = JSON.stringify(body);
    const response = await fetchImpl(opencode.url(route), init);
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`The engine answered HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!text) return null;
    return unwrapped(JSON.parse(text));
  };

  const session = (sessionId) => `/api/session/${encodeURIComponent(sessionId)}`;

  return {
    create: (sessionId, request) => call(`${session(sessionId)}/permission`, { method: 'POST', body: request }),
    reply: (sessionId, requestId, decision) => call(`${session(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`, { method: 'POST', body: { decision } }),
    pending: async (sessionId) => {
      const listed = await call(`${session(sessionId)}/permission`);
      return Array.isArray(listed) ? listed : null;
    },
    saved: async (directory) => {
      const listed = await call('/api/permission/saved', { directory });
      return Array.isArray(listed) ? listed : [];
    },
    removeSaved: (id, directory) => call(`/api/permission/saved/${encodeURIComponent(id)}`, { method: 'DELETE', directory }),
  };
}

const savedFor = (rules, host) => rules.filter((rule) => rule?.action === CHROME_PERMISSION && rule.resource === host && textOf(rule.id));

const couldNotAsk = (host) => new MittrToolError(`MittrCraft could not ask the user about ${host}; try again in a moment`, 503);

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastMintMs = 0;
let mintCounter = 0;

export const mintPermissionId = () => {
  const now = Date.now();
  if (now !== lastMintMs) {
    lastMintMs = now;
    mintCounter = 0;
  }
  mintCounter += 1;
  const time = (BigInt(now) * 0x1000n + BigInt(mintCounter)).toString(16).padStart(12, '0').slice(-12);
  const random = Array.from(crypto.randomBytes(14), (byte) => ID_CHARS[byte % ID_CHARS.length]).join('');
  return `per_${time}${random}`;
};

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export function createChromeSiteApprovals({
  settings,
  engine,
  defaultDirectory = () => null,
  decisionWaitMs = DECISION_WAIT_MS,
  pollMs = PENDING_POLL_MS,
  denyRetryMs = DENY_RETRY_MS,
  mintId = mintPermissionId,
  logger = console,
}) {
  const approvals = createChromeApprovals({ settings, logger });
  const asking = new Map();
  const byRequest = new Map();
  const early = new Map();

  const recordQuietly = (sessionId, host, reply) => approvals.record(sessionId, host, reply).catch((error) => {
    logger.warn('[mittr] could not record a Chrome site answer:', error?.message ?? error);
  });

  const withdraw = async (entry, decision) => {
    const requestId = entry.requestId;
    if (!requestId) return;
    entry.requestId = null;
    if (byRequest.get(requestId) === entry) byRequest.delete(requestId);
    await engine.reply(entry.sessionId, requestId, decision).catch((failure) => {
      logger.warn(`[mittr] could not close a Chrome site question: ${failure?.status ?? 'no answer'}`);
    });
  };

  const settleOthers = (decided) => {
    for (const other of asking.values()) {
      if (other === decided || other.done || other.host !== decided.host) continue;
      void withdraw(other, 'once');
      void recordQuietly(other.sessionId, other.host, 'always');
    }
  };

  const decide = (entry, requestId, reply) => {
    if (byRequest.get(requestId) === entry) byRequest.delete(requestId);
    if (entry.requestId === requestId) entry.requestId = null;
    void recordQuietly(entry.sessionId, entry.host, reply).then(() => {
      if (reply === 'always') settleOthers(entry);
    });
  };

  const holdEarly = (requestId, sessionId, reply) => {
    const repeated = early.get(requestId);
    if (repeated) {
      clearTimeout(repeated.timer);
      early.delete(requestId);
    }
    if (early.size >= EARLY_LIMIT) {
      const [oldest, held] = early.entries().next().value;
      clearTimeout(held.timer);
      early.delete(oldest);
    }
    const timer = setTimeout(() => early.delete(requestId), decisionWaitMs);
    timer.unref?.();
    early.set(requestId, { sessionId, reply, timer });
  };

  const bind = (entry, requestId) => {
    entry.requestId = requestId;
    byRequest.set(requestId, entry);
    const held = early.get(requestId);
    if (!held) return;
    clearTimeout(held.timer);
    early.delete(requestId);
    if (held.sessionId === entry.sessionId) decide(entry, requestId, held.reply);
  };

  const replied = (requestId, sessionId, reply) => {
    if (!REPLIES.has(reply)) return;
    const entry = byRequest.get(requestId);
    if (!entry) {
      holdEarly(requestId, sessionId, reply);
      return;
    }
    if (entry.sessionId === sessionId) decide(entry, requestId, reply);
  };

  const clearSaved = async (host, directory) => {
    const rules = savedFor(await engine.saved(directory), host);
    for (const rule of rules) await engine.removeSaved(rule.id, directory);
    return rules.length;
  };

  const watchForLoss = (sessionId, requestId, done) => new Promise((resolve) => {
    let timer = null;
    const later = (work, ms) => {
      timer = setTimeout(work, ms);
      timer.unref?.();
    };
    const check = async () => {
      const listed = await engine.pending(sessionId).catch(() => null);
      if (done.aborted) return;
      if (!listed || listed.some((request) => request?.id === requestId)) {
        later(check, pollMs);
        return;
      }
      later(() => resolve(LOST), decisionWaitMs);
    };
    done.addEventListener('abort', () => clearTimeout(timer), { once: true });
    later(check, pollMs);
  });

  const requestFor = (id, host, source) => {
    const request = {
      id,
      action: CHROME_PERMISSION,
      resources: [host],
      save: [host],
      message: chromeQuestion(host),
      metadata: { host },
    };
    if (source) request.source = source;
    return request;
  };

  const createOnce = async (entry, source, signal) => {
    if (signal.aborted) throw cancelled();
    const id = mintId();
    let answer;
    try {
      answer = await engine.create(entry.sessionId, requestFor(id, entry.host, source));
    } catch (error) {
      logger.warn(`[mittr] the engine did not raise the Chrome site question: ${error?.status ?? 'no answer'}`);
      await engine.reply(entry.sessionId, id, 'reject').catch(() => undefined);
      throw couldNotAsk(entry.host);
    }
    if (answer?.effect !== 'ask') return answer?.effect ?? null;
    const answeredId = textOf(answer.id);
    if (answeredId !== id) {
      if (answeredId) await engine.reply(entry.sessionId, answeredId, 'reject').catch(() => undefined);
      logger.warn('[mittr] the engine raised the Chrome site question under an id MittrCraft did not give it; the question was withdrawn');
      throw couldNotAsk(entry.host);
    }
    bind(entry, id);
    return 'ask';
  };

  const raiseQuestion = async (entry, { directory, source, signal }) => {
    let effect = await createOnce(entry, source, signal);
    if (effect === 'deny') {
      await sleep(denyRetryMs);
      effect = await createOnce(entry, source, signal);
    }
    if (effect === 'allow') {
      const cleared = await clearSaved(entry.host, directory).catch(() => 0);
      if (cleared > 0) effect = await createOnce(entry, source, signal);
    }
    if (effect === 'ask') return;
    if (effect === 'deny') throw new MittrToolError(`The engine refused to ask the user about ${entry.host}; a permission rule may block it`, 403);
    throw couldNotAsk(entry.host);
  };

  const raise = async (entry, { directory, source }) => {
    const { signal } = entry.controller;
    const decision = approvals.awaitDecision(entry.sessionId, entry.host, signal);
    decision.catch(() => {});
    const done = new AbortController();
    let outcome = null;
    try {
      await raiseQuestion(entry, { directory, source, signal });
      const watched = entry.requestId;
      const lost = watched ? watchForLoss(entry.sessionId, watched, done.signal) : new Promise(() => {});
      outcome = await Promise.race([decision, lost]);
      if (outcome === LOST) throw new MittrToolError(`The user's answer for ${entry.host} did not arrive; ask again`, 403);
      return outcome;
    } catch (error) {
      if (!isCancelled(error) && !signal.aborted) throw error;
      throw new MittrToolError(CANCELLED, 499);
    } finally {
      done.abort();
      entry.done = true;
      await withdraw(entry, outcome === 'once' || outcome === 'always' ? 'once' : 'reject');
    }
  };

  const follow = (entry, signal) => new Promise((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return false;
      left = true;
      signal?.removeEventListener('abort', onAbort);
      entry.callers -= 1;
      if (entry.callers > 0) return false;
      entry.controller.abort();
      return true;
    };
    const onAbort = () => {
      if (!leave()) {
        reject(new MittrToolError(CANCELLED, 499));
        return;
      }
      entry.result.then(() => reject(new MittrToolError(CANCELLED, 499)), reject);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.result.then(
      (value) => {
        if (left) return;
        leave();
        resolve(value);
      },
      (error) => {
        if (left) return;
        leave();
        reject(error);
      },
    );
  });

  const ask = ({ sessionId, host, directory, source, signal }) => {
    if (signal?.aborted) return Promise.reject(new MittrToolError(CANCELLED, 499));
    const key = keyFor(sessionId, host);
    let entry = asking.get(key);
    if (!entry || entry.done || entry.controller.signal.aborted) {
      entry = { sessionId, host, requestId: null, done: false, callers: 0, controller: new AbortController() };
      const started = entry;
      asking.set(key, started);
      started.result = raise(started, { directory, source }).finally(() => {
        if (asking.get(key) === started) asking.delete(key);
      });
      started.result.catch(() => {});
    }
    entry.callers += 1;
    return follow(entry, signal);
  };

  const removeHost = async (host) => {
    const remaining = await approvals.removeHost(host);
    await clearSaved(host, defaultDirectory()).catch((error) => {
      logger.warn(`[mittr] could not remove the engine's saved answer for a removed Chrome site; the next question about it removes it: ${error?.status ?? 'no answer'}`);
    });
    return remaining;
  };

  return {
    isApproved: approvals.isApproved,
    awaitDecision: approvals.awaitDecision,
    record: approvals.record,
    forgetSession: approvals.forgetSession,
    forgetAll: approvals.forgetAll,
    ask,
    replied,
    removeHost,
  };
}

export const subscribeApprovals = (events, approvals) => events.subscribe((event) => {
  const raw = event?.payload;
  const data = raw?.data;
  if (raw?.type !== 'permission.replied' || !isRecord(data)) return;
  const requestId = textOf(data.requestID);
  const sessionId = textOf(data.sessionID);
  if (requestId && sessionId) approvals.replied(requestId, sessionId, data.reply);
});
