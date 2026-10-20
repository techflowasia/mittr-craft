const REFUSALS = {
  desktop_entitlement_required: { reason: 'entitlement', canResync: false },
  agent_not_granted: { reason: 'stale-catalog', canResync: true },
};

const UNKNOWN = { reason: 'unknown', canResync: false };

const candidatesOf = (body) => {
  const error = body?.error;
  if (typeof error === 'string') return [error];
  return [error?.code, error?.message];
};

export function describeModelRefusal(body) {
  for (const candidate of candidatesOf(body)) {
    if (typeof candidate === 'string' && Object.hasOwn(REFUSALS, candidate)) return { ...REFUSALS[candidate] };
  }
  return { ...UNKNOWN };
}

export function createThrottle(intervalMs, now = Date.now) {
  let last = null;
  return () => {
    const at = now();
    if (last !== null && at - last < intervalMs) return false;
    last = at;
    return true;
  };
}

const REFUSAL_WAIT_MS = 15_000;

const settledWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  void promise.then(() => {
    clearTimeout(timer);
    resolve();
  });
});

export function createModelRefusalHandler({ mayResync, syncStored, catalogModels, waitMs = REFUSAL_WAIT_MS }) {
  let pending = null;
  const startSync = () => {
    const run = new Promise((resolve) => { resolve(syncStored()); }).catch(() => undefined);
    pending = run;
    void run.then(() => {
      if (pending === run) pending = null;
    });
    return run;
  };

  const withdrawn = (model) => {
    const models = catalogModels();
    if (models?.configured !== true) return undefined;
    return models.items.some((item) => item.alias === model) ? undefined : { withdrawn: true };
  };

  return async ({ kind, reason, model }) => {
    if (kind !== 'model') return undefined;
    if (reason === 'stale-catalog') {
      if (mayResync()) void startSync();
      return undefined;
    }
    if (reason !== 'entitlement' || !model) return undefined;
    const waiting = mayResync() ? startSync() : pending;
    if (waiting) await settledWithin(waiting, waitMs);
    return withdrawn(model);
  };
}
