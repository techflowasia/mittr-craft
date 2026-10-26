import crypto from 'node:crypto';

export const HEARD_TTL_MS = 120_000;

const digestOf = (text) => crypto.createHash('sha256').update(String(text ?? '').trim(), 'utf8').digest('hex');

export function createVoiceConversation({ now = Date.now, heardTtlMs = HEARD_TTL_MS, randomId = crypto.randomUUID } = {}) {
  let live = null;
  const listeners = new Set();

  const finish = () => {
    const ended = live;
    live = null;
    if (!ended) return false;
    for (const listener of [...listeners]) listener(ended.id);
    return true;
  };

  const liveOf = (conversationId) => (live && conversationId === live.id ? live : null);

  return {
    start: () => {
      finish();
      live = { id: randomId(), heard: new Map(), pendingHost: null, chromeAllowed: false };
      return live.id;
    },
    current: () => live?.id ?? null,
    end: (conversationId) => (liveOf(conversationId) ? finish() : false),
    endAll: () => {
      finish();
    },
    onEnd: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hear: (conversationId, text) => {
      const conversation = liveOf(conversationId);
      if (!conversation) return null;
      const heardId = randomId();
      conversation.heard.set(heardId, { digest: digestOf(text), at: now() });
      return heardId;
    },
    take: (conversationId, heardId, said) => {
      const conversation = liveOf(conversationId);
      const receipt = conversation?.heard.get(heardId);
      if (!receipt) return false;
      conversation.heard.delete(heardId);
      return now() - receipt.at <= heardTtlMs && receipt.digest === digestOf(said);
    },
    pendingHost: () => live?.pendingHost ?? null,
    setPendingHost: (host) => {
      if (live) live.pendingHost = host;
    },
    chromeAllowed: () => live?.chromeAllowed === true,
    allowChrome: () => {
      if (!live) return;
      live.chromeAllowed = true;
      live.pendingHost = null;
    },
  };
}
