import { describe, expect, test } from 'bun:test';

import { announceAccountChanged, gateHeld, holdGate, listenAccountChanged, onGateRelease } from './accountChange';

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
