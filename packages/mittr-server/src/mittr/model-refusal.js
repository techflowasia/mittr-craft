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
