import { isRecord } from '../values.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';

export const CHROME_PERMISSION = MITTR_TOOLS.chrome;
export const DECISION_WAIT_MS = 10_000;
export const PENDING_POLL_MS = 5_000;
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

export function createChromeSiteApprovals({
  settings,
  engine,
  defaultDirectory = () => null,
  decisionWaitMs = DECISION_WAIT_MS,
  pollMs = PENDING_POLL_MS,
  logger = console,
}) {
  const approvals = createChromeApprovals({ settings, logger });
  const asking = new Map();
  const byRequest = new Map();

  const bind = (entry, requestId) => {
    const id = textOf(requestId);
    if (!id || entry.done) return;
    entry.ids.add(id);
    byRequest.set(id, entry);
  };

  const unbindAll = (entry) => {
    for (const id of entry.ids) {
      if (byRequest.get(id) === entry) byRequest.delete(id);
    }
  };

  const asked = (requestId, sessionId, host) => {
    const entry = asking.get(keyFor(sessionId, host));
    if (entry) bind(entry, requestId);
  };

  const replied = (requestId, sessionId, reply) => {
    const entry = byRequest.get(requestId);
    if (!entry || entry.sessionId !== sessionId || !REPLIES.has(reply)) return;
    byRequest.delete(requestId);
    entry.ids.delete(requestId);
    void approvals.record(entry.sessionId, entry.host, reply).catch((error) => {
      logger.warn('[mittr] could not record a Chrome site answer:', error?.message ?? error);
    });
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

  const requestFor = (host, source) => {
    const request = {
      action: CHROME_PERMISSION,
      resources: [host],
      save: [host],
      message: chromeQuestion(host),
      metadata: { host },
    };
    if (source) request.source = source;
    return request;
  };

  const created = async (entry, { directory, source }) => {
    let answer;
    try {
      answer = await engine.create(entry.sessionId, requestFor(entry.host, source));
    } catch (error) {
      logger.warn(`[mittr] the engine did not raise the Chrome site question: ${error?.status ?? 'no answer'}`);
      throw couldNotAsk(entry.host);
    }
    if (answer?.effect !== 'allow' || entry.retried) return answer;
    entry.retried = true;
    const cleared = await clearSaved(entry.host, directory).catch(() => 0);
    if (cleared === 0) throw couldNotAsk(entry.host);
    return created(entry, { directory, source });
  };

  const raise = async (entry, { directory, source, signal }) => {
    if (signal?.aborted) throw new MittrToolError(CANCELLED, 499);
    const decision = approvals.awaitDecision(entry.sessionId, entry.host, signal);
    decision.catch(() => {});
    const done = new AbortController();
    try {
      const answer = await created(entry, { directory, source });
      if (answer?.effect === 'deny') throw new MittrToolError(`A permission rule blocks using the Chrome sign-in on ${entry.host}`, 403);
      if (answer?.effect === 'allow') throw couldNotAsk(entry.host);
      const requestId = textOf(answer?.id);
      if (!requestId) throw couldNotAsk(entry.host);
      bind(entry, requestId);
      const outcome = await Promise.race([decision, watchForLoss(entry.sessionId, requestId, done.signal)]);
      if (outcome === LOST) throw new MittrToolError(`The user's answer for ${entry.host} did not arrive; ask again`, 403);
      return outcome;
    } catch (error) {
      if (!isCancelled(error) && !signal?.aborted) throw error;
      const unanswered = [...entry.ids];
      unbindAll(entry);
      for (const id of unanswered) {
        await engine.reply(entry.sessionId, id, 'reject').catch((failure) => {
          logger.warn(`[mittr] could not withdraw a Chrome site question: ${failure?.status ?? 'no answer'}`);
        });
      }
      throw new MittrToolError(CANCELLED, 499);
    } finally {
      done.abort();
      entry.done = true;
      unbindAll(entry);
    }
  };

  const untilAborted = (work, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MittrToolError(CANCELLED, 499));
      return;
    }
    const onAbort = () => reject(new MittrToolError(CANCELLED, 499));
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
  });

  const ask = ({ sessionId, host, directory, source, signal }) => {
    const key = keyFor(sessionId, host);
    const running = asking.get(key);
    if (running) return untilAborted(running.result, signal);
    const entry = { sessionId, host, ids: new Set(), done: false, retried: false };
    asking.set(key, entry);
    entry.result = raise(entry, { directory, source, signal }).finally(() => {
      if (asking.get(key) === entry) asking.delete(key);
    });
    return entry.result;
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
    asked,
    replied,
    removeHost,
  };
}

const hostOf = (request) => (Array.isArray(request?.resources) && request.resources.length === 1 ? textOf(request.resources[0]) : null);

export const subscribeApprovals = (events, approvals) => events.subscribe((event) => {
  const raw = event?.payload;
  const data = raw?.data;
  if (!isRecord(data)) return;
  if (raw.type === 'permission.asked' && data.action === CHROME_PERMISSION) {
    const host = hostOf(data);
    const requestId = textOf(data.id);
    const sessionId = textOf(data.sessionID);
    if (host && requestId && sessionId) approvals.asked(requestId, sessionId, host);
    return;
  }
  if (raw.type === 'permission.replied') {
    const requestId = textOf(data.requestID);
    const sessionId = textOf(data.sessionID);
    if (requestId && sessionId) approvals.replied(requestId, sessionId, data.reply);
  }
});
