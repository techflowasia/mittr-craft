import { describe, expect, test } from 'bun:test';

import type { JsonValue } from '@openchamber/sdk';

import {
  createSignInGateController,
  STATUS_TIMEOUT_MS,
  TRANSACTION_TTL_MS,
  type GateFetch,
  type GateResponse,
  type GateSchedule,
} from './signInGateController';
import {
  SIGN_IN_COMPLETED_EVENT,
  SIGN_IN_FAILED_EVENT,
  SIGN_IN_REPAIR_ENDPOINT,
  SIGN_IN_START_ENDPOINT,
  SIGN_IN_STATUS_ENDPOINT,
} from './signInGateState';

type Answer = () => Promise<GateResponse>;
type Call = { path: string; method: string };

const answer = (body: JsonValue, status = 200): Answer => () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const unreachable = (message: string): Answer => () => Promise.reject(new Error(message));

const fakeFetch = (routes: Record<string, Answer[]>) => {
  const calls: Call[] = [];
  const fetch: GateFetch = (path, init) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    const queue = routes[path] ?? [];
    const next = (queue.length > 1 ? queue.shift() : queue[0]) ?? unreachable(`no answer for ${path}`);
    return next();
  };
  return { fetch, calls, statusCalls: () => calls.filter((call) => call.path === SIGN_IN_STATUS_ENDPOINT).length };
};

const fakeDesktop = () => {
  const handlers = new Map<string, Set<() => void>>();
  const focusHandlers = new Set<() => void>();
  return {
    listen: async (event: string, handler: () => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => { set.delete(handler); };
    },
    onFocus: (handler: () => void) => {
      focusHandlers.add(handler);
      return () => { focusHandlers.delete(handler); };
    },
    emit: (event: string) => { for (const handler of handlers.get(event) ?? []) handler(); },
    focus: () => { for (const handler of focusHandlers) handler(); },
    listening: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0) + focusHandlers.size,
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const fakeClock = () => {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  const schedule: GateSchedule = (run, delayMs) => {
    const timer = { at: now + delayMs, run };
    timers.add(timer);
    return () => { timers.delete(timer); };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > now) continue;
      timers.delete(timer);
      timer.run();
    }
  };
  return { schedule, advance, pending: () => timers.size };
};

const setUp = (routes: Record<string, Answer[]>, { withDesktop = true } = {}) => {
  const server = fakeFetch(routes);
  const desktop = fakeDesktop();
  const clock = fakeClock();
  const opened: string[] = [];
  const controller = createSignInGateController({
    fetch: server.fetch,
    listen: withDesktop ? desktop.listen : undefined,
    onFocus: desktop.onFocus,
    openUrl: async (url) => { opened.push(url); return true; },
    schedule: clock.schedule,
  });
  return { controller, server, desktop, opened, clock };
};

describe('sign-in gate controller', () => {
  test('controller moves to signed-out on a signed-out status', async () => {
    const { controller } = setUp({ [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })] });
    expect(controller.state()).toBe('checking');
    await settle();
    expect(controller.state()).toBe('signed-out');
    controller.dispose();
  });

  test('the desktop signed-in event re-checks status', async () => {
    const { controller, server, desktop } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false }), answer({ signedIn: true, userId: 'u1', displayName: 'A' })],
    });
    await settle();
    desktop.emit(SIGN_IN_COMPLETED_EVENT);
    await settle();
    expect(server.statusCalls()).toBe(2);
    expect(controller.state()).toBe('signed-in');
    controller.dispose();
  });

  test('window focus re-checks status', async () => {
    const { controller, server, desktop } = setUp({ [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })] });
    await settle();
    desktop.focus();
    await settle();
    expect(server.statusCalls()).toBe(2);
    controller.dispose();
  });

  test('while an account change holds the gate, a focus does not re-check; the release re-checks once', async () => {
    const server = fakeFetch({ [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: true, userId: 'u1', displayName: 'A' }), answer({ signedIn: false })] });
    const desktop = fakeDesktop();
    let held = false;
    const releases = new Set<() => void>();
    const controller = createSignInGateController({
      fetch: server.fetch,
      onFocus: desktop.onFocus,
      held: () => held,
      onRelease: (listener) => {
        releases.add(listener);
        return () => { releases.delete(listener); };
      },
    });
    await settle();
    expect(controller.state()).toBe('signed-in');

    held = true;
    desktop.focus();
    desktop.focus();
    await settle();
    expect(server.statusCalls()).toBe(1);
    expect(controller.state()).toBe('signed-in');

    held = false;
    for (const release of releases) release();
    for (const release of releases) release();
    await settle();
    expect(server.statusCalls()).toBe(2);
    expect(controller.state()).toBe('signed-out');
    controller.dispose();
    expect(releases.size).toBe(0);
  });

  test('a sign-in that failed in the browser ends the wait and shows the failure', async () => {
    const { controller, desktop, opened } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false }), answer({ signedIn: false, signInFailed: 'unreachable' })],
      [SIGN_IN_START_ENDPOINT]: [answer({ authorizeUrl: 'https://api-dev.mittr.asia/auth/desktop/start?code_challenge=x' })],
    });
    await settle();
    await controller.signIn();
    expect(opened).toEqual(['https://api-dev.mittr.asia/auth/desktop/start?code_challenge=x']);
    expect(controller.snapshot().waiting).toBe(true);

    desktop.emit(SIGN_IN_FAILED_EVENT);
    await settle();
    expect(controller.snapshot().waiting).toBe(false);
    expect(controller.snapshot().status).toEqual({ signedIn: false, signInFailed: 'unreachable' });
    controller.dispose();
  });

  test('a start the server refuses is shown as a failure and the status is read again', async () => {
    const { controller, server, opened } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false }), answer({ signedIn: false, accountsDamaged: true })],
      [SIGN_IN_START_ENDPOINT]: [answer({ error: 'refused' }, 503)],
    });
    await settle();
    await controller.signIn();
    expect(opened).toEqual([]);
    expect(controller.snapshot().actionFailed).toBe('start');
    expect(controller.snapshot().waiting).toBe(false);
    expect(server.statusCalls()).toBe(2);
    expect(controller.snapshot().status).toEqual({ signedIn: false, accountsDamaged: true });
    controller.dispose();
  });

  test('an authorize URL that is not a web address is never opened', async () => {
    const { controller, opened } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })],
      [SIGN_IN_START_ENDPOINT]: [answer({ authorizeUrl: 'javascript:alert(1)' })],
    });
    await settle();
    await controller.signIn();
    expect(opened).toEqual([]);
    expect(controller.snapshot().actionFailed).toBe('start');
    controller.dispose();
  });

  test('repair sets the damaged list aside and then reads the status again', async () => {
    const { controller, server } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false, accountsDamaged: true }), answer({ signedIn: false })],
      [SIGN_IN_REPAIR_ENDPOINT]: [answer({ repaired: true })],
    });
    await settle();
    await controller.repair();
    expect(server.calls.filter((call) => call.path === SIGN_IN_REPAIR_ENDPOINT)).toEqual([{ path: SIGN_IN_REPAIR_ENDPOINT, method: 'POST' }]);
    expect(controller.snapshot().status).toEqual({ signedIn: false });
    expect(controller.snapshot().actionFailed).toBe(null);
    controller.dispose();
  });

  test('a repair that fails says so and leaves the list damaged', async () => {
    const { controller } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false, accountsDamaged: true })],
      [SIGN_IN_REPAIR_ENDPOINT]: [answer({ error: 'Cannot store the Mittr sign-in on this machine' }, 500)],
    });
    await settle();
    await controller.repair();
    expect(controller.snapshot().actionFailed).toBe('repair');
    expect(controller.snapshot().status).toEqual({ signedIn: false, accountsDamaged: true });
    controller.dispose();
  });

  test('a status nobody could read is a failed check, not a signed-out person', async () => {
    const { controller } = setUp({ [SIGN_IN_STATUS_ENDPOINT]: [unreachable('offline')] });
    await settle();
    expect(controller.snapshot().checkFailed).toBe(true);
    expect(controller.snapshot().status).toBe(null);
    controller.dispose();
  });

  test('a failed re-check keeps a signed-in person in the app', async () => {
    const { controller, desktop } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: true, userId: 'u1' }), answer({ error: 'down' }, 502)],
    });
    await settle();
    desktop.focus();
    await settle();
    expect(controller.state()).toBe('signed-in');
    controller.dispose();
  });

  test('an older answer that arrives late does not overwrite a newer one', async () => {
    let releaseFirst: (response: GateResponse) => void = () => {};
    const answers: Answer[] = [
      () => new Promise((resolve) => { releaseFirst = resolve; }),
      answer({ signedIn: true, userId: 'u1' }),
    ];
    const controller = createSignInGateController({
      fetch: () => (answers.shift() ?? unreachable('unexpected'))(),
      onFocus: () => () => {},
    });
    await controller.refresh();
    expect(controller.state()).toBe('signed-in');
    releaseFirst(await answer({ signedIn: false })());
    await settle();
    expect(controller.state()).toBe('signed-in');
    controller.dispose();
  });

  test('waiting for the browser ends when the sign-in transaction can no longer finish', async () => {
    const { controller, clock } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })],
      [SIGN_IN_START_ENDPOINT]: [answer({ authorizeUrl: 'https://api-dev.mittr.asia/auth/desktop/start?code_challenge=x' })],
    });
    await settle();
    await controller.signIn();
    expect(controller.snapshot().waiting).toBe(true);
    clock.advance(TRANSACTION_TTL_MS - 1);
    expect(controller.snapshot().waiting).toBe(true);
    clock.advance(1);
    expect(controller.snapshot().waiting).toBe(false);
    controller.dispose();
  });

  test('a new browser trip restarts the wait, and dispose cancels it', async () => {
    const { controller, clock } = setUp({
      [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })],
      [SIGN_IN_START_ENDPOINT]: [answer({ authorizeUrl: 'https://api-dev.mittr.asia/auth/desktop/start?code_challenge=x' })],
    });
    await settle();
    await controller.signIn();
    clock.advance(TRANSACTION_TTL_MS - 10);
    await controller.signIn();
    clock.advance(10);
    expect(controller.snapshot().waiting).toBe(true);
    controller.dispose();
    expect(clock.pending()).toBe(0);
  });

  test('a status check that hangs becomes a failed check the person can retry', async () => {
    const signals: AbortSignal[] = [];
    const clock = fakeClock();
    const controller = createSignInGateController({
      fetch: (_path, init) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<GateResponse>(() => {});
      },
      onFocus: () => () => {},
      schedule: clock.schedule,
    });
    await settle();
    expect(controller.snapshot().checkFailed).toBe(false);
    clock.advance(STATUS_TIMEOUT_MS);
    await settle();
    expect(controller.snapshot().checkFailed).toBe(true);
    expect(controller.snapshot().status).toBe(null);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    controller.dispose();
  });

  test('a status that answers in time leaves no timer behind', async () => {
    const { controller, clock } = setUp({ [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })] });
    await settle();
    expect(clock.pending()).toBe(0);
    controller.dispose();
  });

  test('subscribers hear each change, and dispose stops every listener', async () => {
    const { controller, desktop } = setUp({ [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })] });
    let heard = 0;
    const unsubscribe = controller.subscribe(() => { heard += 1; });
    await settle();
    expect(heard).toBeGreaterThan(0);
    unsubscribe();
    controller.dispose();
    expect(desktop.listening()).toBe(0);
  });

  test('without a desktop bridge only focus re-checks', async () => {
    const { controller, desktop } = setUp({ [SIGN_IN_STATUS_ENDPOINT]: [answer({ signedIn: false })] }, { withDesktop: false });
    await settle();
    expect(desktop.listening()).toBe(1);
    controller.dispose();
    expect(desktop.listening()).toBe(0);
  });
});
