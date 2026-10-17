import { describe, expect, test } from 'bun:test';

import { announceAccountChanged, beginSignInWait, gateHeld, holdGate, listenAccountChanged, onGateRelease, reloadOrDefer } from './accountChange';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('account change across windows', () => {
  test('another window hears an account change; the window that made it does not', async () => {
    const heard: string[] = [];
    const stop = listenAccountChanged(() => heard.push('here'));
    const other = new BroadcastChannel('mittr.account.changed');
    try {
      announceAccountChanged();
      await settle();
      expect(heard).toEqual([]);

      other.postMessage('another-window');
      await settle();
      expect(heard).toEqual(['here']);
    } finally {
      stop();
      other.close();
    }
  });
});

describe('the gate hold', () => {
  test('the gate is held until every hold is released, and the release is told once', () => {
    const released: number[] = [];
    const stop = onGateRelease(() => released.push(1));
    const first = holdGate();
    const second = holdGate();
    expect(gateHeld()).toBe(true);
    first();
    first();
    expect(gateHeld()).toBe(true);
    expect(released).toEqual([]);
    second();
    expect(gateHeld()).toBe(false);
    expect(released).toEqual([1]);
    stop();
  });
});

describe('reloads during a sign-in wait', () => {
  test('without a wait the reload runs at once', () => {
    const log: string[] = [];
    reloadOrDefer(() => log.push('reload'), () => log.push('resync and reload'));
    expect(log).toEqual(['reload']);
  });

  test('a reload asked during a wait runs once, as a resync and reload, when the wait ends unhandled', () => {
    const log: string[] = [];
    const end = beginSignInWait();
    reloadOrDefer(() => log.push('reload'), () => log.push('resync and reload'));
    reloadOrDefer(() => log.push('reload'), () => log.push('resync and reload'));
    expect(log).toEqual([]);
    end(false);
    end(false);
    expect(log).toEqual(['resync and reload']);
  });

  test('a wait that ends with its own resync and reload drops the deferred one', () => {
    const log: string[] = [];
    const end = beginSignInWait();
    reloadOrDefer(() => log.push('reload'), () => log.push('resync and reload'));
    end(true);
    expect(log).toEqual([]);
    reloadOrDefer(() => log.push('reload'), () => log.push('resync and reload'));
    expect(log).toEqual(['reload']);
  });

  test('with two waits the deferred reload waits for the last', () => {
    const log: string[] = [];
    const gate = beginSignInWait();
    const menu = beginSignInWait();
    reloadOrDefer(() => log.push('reload'), () => log.push('resync and reload'));
    gate(false);
    expect(log).toEqual([]);
    menu(false);
    expect(log).toEqual(['resync and reload']);
  });
});
