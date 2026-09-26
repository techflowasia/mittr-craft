export const CHROME_PERMISSION = 'mittrcraft_chrome';

const keyFor = (sessionId, host) => `${sessionId}\n${host}`;

export const createChromeApprovals = ({ readSettings, persistSettings }) => {
  const pendingRequests = new Map();
  const sessionGrants = new Map();
  const asked = new Set();
  const decisions = new Map();
  const waiters = new Map();
  let queue = Promise.resolve();

  const serialized = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const persistedHosts = async () => {
    const settings = (await readSettings()) ?? {};
    return Array.isArray(settings.agentChromeApprovedHosts) ? settings.agentChromeApprovedHosts : [];
  };

  const addHost = (host) => serialized(async () => {
    const hosts = await persistedHosts();
    if (hosts.includes(host)) return hosts;
    const next = [...hosts, host];
    await persistSettings({ agentChromeApprovedHosts: next });
    return next;
  });

  const removeHost = (host) => serialized(async () => {
    for (const grants of sessionGrants.values()) grants.delete(host);
    const next = (await persistedHosts()).filter((entry) => entry !== host);
    await persistSettings({ agentChromeApprovedHosts: next });
    return next;
  });

  const grantSession = (sessionId, host) => {
    if (!sessionGrants.has(sessionId)) sessionGrants.set(sessionId, new Set());
    sessionGrants.get(sessionId).add(host);
  };

  const isApproved = async (sessionId, host) => (
    sessionGrants.get(sessionId)?.has(host) === true || (await persistedHosts()).includes(host)
  );

  const settle = (key, reply) => {
    decisions.set(key, reply);
    for (const resolve of waiters.get(key) ?? []) resolve(reply);
    waiters.delete(key);
  };

  const handleEvent = async (payload) => {
    const properties = payload?.properties;
    if (payload?.type === 'permission.asked' && properties?.permission === CHROME_PERMISSION) {
      const host = Array.isArray(properties.patterns) ? properties.patterns[0] : null;
      if (typeof properties.id !== 'string' || typeof properties.sessionID !== 'string' || typeof host !== 'string') return;
      const key = keyFor(properties.sessionID, host);
      pendingRequests.set(properties.id, { sessionId: properties.sessionID, host });
      asked.add(key);
      decisions.delete(key);
      return;
    }
    if (payload?.type === 'permission.replied') {
      const entry = pendingRequests.get(properties?.requestID);
      if (!entry || entry.sessionId !== properties?.sessionID) return;
      pendingRequests.delete(properties.requestID);
      const reply = properties.reply;
      if (reply === 'always') await addHost(entry.host);
      if (reply === 'always' || reply === 'once') grantSession(entry.sessionId, entry.host);
      settle(keyFor(entry.sessionId, entry.host), reply === 'always' || reply === 'once' ? reply : 'reject');
    }
  };

  const awaitDecision = (sessionId, host, signal) => {
    const key = keyFor(sessionId, host);
    if (decisions.has(key)) return Promise.resolve(decisions.get(key));
    if (!asked.has(key)) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Cancelled while waiting for the user'));
        return;
      }
      const done = (reply) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(reply);
      };
      const onAbort = () => {
        waiters.get(key)?.delete(done);
        reject(new Error('Cancelled while waiting for the user'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!waiters.has(key)) waiters.set(key, new Set());
      waiters.get(key).add(done);
    });
  };

  const forgetSession = (sessionId) => {
    sessionGrants.delete(sessionId);
  };

  const subscribe = (globalEventHub) => globalEventHub.subscribeEvent((event) => {
    const raw = event?.payload;
    const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    void handleEvent(payload).catch((error) => {
      console.warn('[chrome-approvals] could not record an answer:', error?.message ?? error);
    });
  });

  return { isApproved, handleEvent, awaitDecision, removeHost, forgetSession, subscribe };
};
