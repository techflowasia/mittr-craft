import type { JsonValue } from '@openchamber/sdk';

import {
  gateStateFromStatus,
  parseAuthorizeUrl,
  parseSignInStatus,
  SIGN_IN_COMPLETED_EVENT,
  SIGN_IN_FAILED_EVENT,
  SIGN_IN_REPAIR_ENDPOINT,
  SIGN_IN_START_ENDPOINT,
  SIGN_IN_STATUS_ENDPOINT,
  type GateSnapshot,
  type GateState,
} from './signInGateState';

export type GateResponse = { ok: boolean; status: number; json: () => Promise<JsonValue> };
export type GateFetch = (path: string, init?: { method?: 'POST'; signal?: AbortSignal }) => Promise<GateResponse>;
export type GateSchedule = (run: () => void, delayMs: number) => () => void;
export type GateListen = (event: string, handler: () => void) => Promise<() => void> | (() => void);

type DesktopEventBridge = { listen?: GateListen };

export function desktopBridge(): DesktopEventBridge | undefined {
  // SAFETY: the desktop preload exposes this bridge on window; outside the
  // desktop shell it is absent, which the optional chain covers.
  return (window as Window & { __OPENCHAMBER_DESKTOP__?: DesktopEventBridge }).__OPENCHAMBER_DESKTOP__;
}

export type SignInGateDeps = {
  fetch: GateFetch;
  // The desktop bridge's listen; absent outside the desktop shell.
  listen?: GateListen;
  onFocus: (handler: () => void) => () => void;
  openUrl?: (url: string) => Promise<boolean>;
  schedule?: GateSchedule;
  held?: () => boolean;
  onRelease?: (listener: () => void) => () => void;
};

export type SignInGateController = {
  state: () => GateState;
  snapshot: () => GateSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  repair: () => Promise<void>;
  dispose: () => void;
};

// A status check that hangs must end as a failed check the person can retry.
export const STATUS_TIMEOUT_MS = 10_000;

// The server's sign-in transaction lives this long; after it the browser trip
// can no longer finish, so the gate stops saying it is waiting for one.
export const TRANSACTION_TTL_MS = 600_000;

export const scheduleWithTimers: GateSchedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

const INITIAL: GateSnapshot = { status: null, checkFailed: false, actionFailed: null, waiting: false, busy: false };

/**
 * The sign-in gate without React: it reads the status route on start, on
 * window focus and on the desktop's signed-in and sign-in-failed events, and
 * runs the two things the person can do from the gate, start a sign-in and
 * repair a damaged account list.
 */
export function createSignInGateController({
  fetch,
  listen,
  onFocus,
  openUrl = async () => false,
  schedule = scheduleWithTimers,
  held = () => false,
  onRelease,
}: SignInGateDeps): SignInGateController {
  let current = INITIAL;
  let disposed = false;
  let latestCheck = 0;
  const listeners = new Set<() => void>();
  const stops: Array<() => void> = [];
  const pendingTimers = new Set<() => void>();
  let cancelWait: (() => void) | null = null;

  const after = (delayMs: number, run: () => void) => {
    const cancel = schedule(() => {
      pendingTimers.delete(cancel);
      run();
    }, delayMs);
    pendingTimers.add(cancel);
    return () => {
      pendingTimers.delete(cancel);
      cancel();
    };
  };

  const fetchStatus = async (): Promise<GateResponse> => {
    const abort = new AbortController();
    let cancelTimeout = () => {};
    const timedOut = new Promise<never>((_resolve, reject) => {
      cancelTimeout = after(STATUS_TIMEOUT_MS, () => {
        abort.abort();
        reject(new Error('the status check timed out'));
      });
    });
    try {
      return await Promise.race([fetch(SIGN_IN_STATUS_ENDPOINT, { signal: abort.signal }), timedOut]);
    } finally {
      cancelTimeout();
    }
  };

  const stopWaiting = () => {
    cancelWait?.();
    cancelWait = null;
  };

  const update = (next: Partial<GateSnapshot>) => {
    if (disposed) return;
    current = { ...current, ...next };
    for (const listener of listeners) listener();
  };

  let refreshWhenReleased = false;

  const refresh = async () => {
    if (held()) {
      refreshWhenReleased = true;
      return;
    }
    const check = ++latestCheck;
    try {
      const response = await fetchStatus();
      if (!response.ok) throw new Error(`status answered ${response.status}`);
      const status = parseSignInStatus(await response.json());
      if (check === latestCheck) update({ status, checkFailed: false });
    } catch {
      // A status nobody could read is not "signed out": the last known status
      // stands, and with none the gate says the check failed.
      if (check === latestCheck) update({ checkFailed: true });
    }
  };

  const post = async (path: string): Promise<GateResponse | null> => {
    try {
      return await fetch(path, { method: 'POST' });
    } catch {
      return null;
    }
  };

  const signIn = async () => {
    if (current.busy) return;
    stopWaiting();
    update({ busy: true, actionFailed: null, waiting: false });
    const response = await post(SIGN_IN_START_ENDPOINT);
    const authorizeUrl = response?.ok ? parseAuthorizeUrl(await response.json().catch(() => null)) : null;
    const opened = authorizeUrl ? await openUrl(authorizeUrl).catch(() => false) : false;
    update({ busy: false, waiting: opened, actionFailed: opened ? null : 'start' });
    if (opened && !disposed) cancelWait = after(TRANSACTION_TTL_MS, () => { cancelWait = null; update({ waiting: false }); });
    // A refused start usually means something now stands in the way, such as
    // a damaged account list, which the status names.
    if (!opened) await refresh();
  };

  const repair = async () => {
    if (current.busy) return;
    update({ busy: true, actionFailed: null });
    const response = await post(SIGN_IN_REPAIR_ENDPOINT);
    update({ busy: false, actionFailed: response?.ok ? null : 'repair' });
    await refresh();
  };

  const endWait = () => {
    stopWaiting();
    update({ waiting: false });
    void refresh();
  };

  stops.push(onFocus(() => { void refresh(); }));
  if (onRelease) {
    stops.push(onRelease(() => {
      if (!refreshWhenReleased) return;
      refreshWhenReleased = false;
      void refresh();
    }));
  }
  for (const event of [SIGN_IN_COMPLETED_EVENT, SIGN_IN_FAILED_EVENT]) {
    try {
      void Promise.resolve(listen?.(event, endWait)).then((stop) => {
        if (!stop) return;
        if (disposed) stop();
        else stops.push(stop);
      }, () => {});
    } catch {
      // Without the event the gate still re-checks on focus.
    }
  }
  void refresh();

  return {
    state: () => gateStateFromStatus(current.status),
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    signIn,
    repair,
    dispose: () => {
      disposed = true;
      listeners.clear();
      for (const stop of stops.splice(0)) stop();
      for (const cancel of [...pendingTimers]) cancel();
      pendingTimers.clear();
      cancelWait = null;
    },
  };
}
