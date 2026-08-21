import { describe, expect, test } from 'bun:test';

import {
  requestSessionLogin,
  resolveStatusCheckFailureState,
  runtimeIdentityMatches,
  SESSION_AUTH_REQUIRED_EVENT,
} from './sessionAuthGateState';

describe('resolveStatusCheckFailureState', () => {
  test('keeps the desktop-shell password login fallback intact', () => {
    expect(resolveStatusCheckFailureState({ shouldUseDesktopShellPasswordLogin: true })).toBe('locked');
  });

  test('uses the network error screen for non-desktop status-check failures', () => {
    expect(resolveStatusCheckFailureState({})).toBe('error');
  });

  test('rejects async auth results after switching hosts', () => {
    expect(runtimeIdentityMatches(
      { apiBaseUrl: 'https://host-a.example', runtimeKey: 'host:a' },
      { apiBaseUrl: 'https://host-b.example', runtimeKey: 'host:b' },
    )).toBe(false);
  });

  test('accepts a credential refresh for the same host', () => {
    expect(runtimeIdentityMatches(
      { apiBaseUrl: 'https://host-a.example', runtimeKey: 'host:a' },
      { apiBaseUrl: 'https://host-a.example', runtimeKey: 'host:a' },
    )).toBe(true);
  });

  test('dispatches the shared auth-required event when login is requested', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const events: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event) => {
          events.push(event.type);
          return true;
        },
      },
    });

    try {
      requestSessionLogin();
      expect(events).toEqual([SESSION_AUTH_REQUIRED_EVENT]);
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, 'window', originalWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
