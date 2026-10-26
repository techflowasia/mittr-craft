export const PRODUCT_LOCALE = 'en-GB';
export const PRODUCT_TIME_ZONE = 'Asia/Bangkok';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = Object.freeze(['stt', 'tts']);

export const nextWeeklyReset = (now) => {
  const local = new Date(now + BANGKOK_OFFSET_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const daysUntilMonday = ((8 - local.getUTCDay()) % 7) || 7;
  return new Date(midnight + daysUntilMonday * DAY_MS - BANGKOK_OFFSET_MS).toISOString();
};

const resetFormats = new Map();

export const formatResetTime = (resetsAt, locale = PRODUCT_LOCALE, timeZone = PRODUCT_TIME_ZONE) => {
  const key = `${locale}|${timeZone}`;
  if (!resetFormats.has(key)) {
    resetFormats.set(key, new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }));
  }
  return resetFormats.get(key).format(new Date(resetsAt));
};

const isTime = (value) => value === String(value) && !Number.isNaN(Date.parse(value));

export function createSpeechState({ now = Date.now } = {}) {
  const blocked = { stt: null, tts: null };
  const waiters = new Set();
  let revision = 0;
  let liftTimer = null;
  let closed = false;

  const current = (kind) => (blocked[kind] && Date.parse(blocked[kind]) > now() ? blocked[kind] : null);

  const view = () => ({ revision, stt: { blockedUntil: current('stt') }, tts: { blockedUntil: current('tts') } });

  const notify = () => {
    for (const waiter of [...waiters]) waiter.settle();
  };

  const scheduleLift = () => {
    clearTimeout(liftTimer);
    liftTimer = null;
    if (closed) return;
    const pending = KINDS.map(current).filter(Boolean).map((at) => Date.parse(at));
    if (pending.length === 0) return;
    liftTimer = setTimeout(() => {
      liftTimer = null;
      revision += 1;
      notify();
      scheduleLift();
    }, Math.max(0, Math.min(...pending) - now()) + 1);
    liftTimer.unref?.();
  };

  const change = (kind, value) => {
    if (blocked[kind] === value) return;
    blocked[kind] = value;
    revision += 1;
    scheduleLift();
    notify();
  };

  return {
    block: (kind, resetsAt) => {
      if (!KINDS.includes(kind)) return;
      change(kind, isTime(resetsAt) ? resetsAt : nextWeeklyReset(now()));
    },
    clear: (kind) => {
      if (KINDS.includes(kind)) change(kind, null);
    },
    clearAll: () => {
      for (const kind of KINDS) change(kind, null);
    },
    view,
    waitForChange: (since, ms, signal) => {
      const asked = Number(since);
      if (closed || !Number.isInteger(asked) || asked !== revision || signal?.aborted) return Promise.resolve(view());
      return new Promise((resolve) => {
        const waiter = {
          settle: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', waiter.settle);
            waiters.delete(waiter);
            resolve(view());
          },
        };
        const timer = setTimeout(waiter.settle, ms);
        timer.unref?.();
        signal?.addEventListener('abort', waiter.settle, { once: true });
        waiters.add(waiter);
      });
    },
    close: () => {
      closed = true;
      clearTimeout(liftTimer);
      liftTimer = null;
      notify();
    },
  };
}
