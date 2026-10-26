import { describe, expect, test } from 'bun:test';

import {
  gateNotice,
  gateStateFromStatus,
  parseAuthorizeUrl,
  parseSignInStatus,
  SIGN_IN_COMPLETED_EVENT,
  SIGN_IN_FAILED_EVENT,
  SIGN_IN_START_ENDPOINT,
  SIGN_IN_STATUS_ENDPOINT,
  type GateSnapshot,
} from './signInGateState';

const snapshot = (over: Partial<GateSnapshot> = {}): GateSnapshot => ({
  status: { signedIn: false },
  checkFailed: false,
  actionFailed: null,
  waiting: false,
  busy: false,
  accounts: [],
  ...over,
});

describe('parseSignInStatus', () => {
  test('status parsing defaults to signed out', () => {
    const status = parseSignInStatus({});
    expect(status).toEqual({ signedIn: false });
    expect(Object.keys(status)).toEqual(['signedIn']);
  });

  test('reads a signed-in status', () => {
    expect(parseSignInStatus({ signedIn: true, userId: 'u1', displayName: 'Chaiwat' }))
      .toEqual({ signedIn: true, userId: 'u1', displayName: 'Chaiwat' });
  });

  test('anything that is not exactly true is signed out, and a signed-out status keeps no user', () => {
    expect(parseSignInStatus({ signedIn: 'yes' })).toEqual({ signedIn: false });
    expect(parseSignInStatus({ signedIn: 1 })).toEqual({ signedIn: false });
    expect(parseSignInStatus(null)).toEqual({ signedIn: false });
    expect(parseSignInStatus({ signedIn: false, userId: 'u1', displayName: 'A' })).toEqual({ signedIn: false });
  });

  test('keeps what the server says stands in the way of signing in', () => {
    expect(parseSignInStatus({ signedIn: false, accountsDamaged: true, keychainMissing: true, signInFailed: 'unreachable' }))
      .toEqual({ signedIn: false, accountsDamaged: true, keychainMissing: true, signInFailed: 'unreachable' });
    expect(parseSignInStatus({ signedIn: false, accountsDamaged: 'yes', signInFailed: 'other' })).toEqual({ signedIn: false });
  });
});

describe('gateStateFromStatus', () => {
  test('waits while the status is unknown, and opens the app only when signed in', () => {
    expect(gateStateFromStatus(null)).toBe('checking');
    expect(gateStateFromStatus({ signedIn: false })).toBe('signed-out');
    expect(gateStateFromStatus({ signedIn: true, userId: 'u1' })).toBe('signed-in');
  });
});

describe('parseAuthorizeUrl', () => {
  test('authorize URL must be http(s)', () => {
    expect(parseAuthorizeUrl({ authorizeUrl: 'javascript:alert(1)' })).toBe(null);
    expect(parseAuthorizeUrl({ authorizeUrl: 'file:///etc/passwd' })).toBe(null);
    expect(parseAuthorizeUrl({ authorizeUrl: 'https://api-dev.mittr.asia/auth/desktop/start?x=1' }))
      .toBe('https://api-dev.mittr.asia/auth/desktop/start?x=1');
  });

  test('a missing or malformed value is refused rather than handed to a browser', () => {
    expect(parseAuthorizeUrl({})).toBe(null);
    expect(parseAuthorizeUrl({ authorizeUrl: '' })).toBe(null);
    expect(parseAuthorizeUrl({ authorizeUrl: 'not a url' })).toBe(null);
    expect(parseAuthorizeUrl(null)).toBe(null);
  });
});

describe('gateNotice', () => {
  test('a missing keychain outranks everything, since nothing else can be done here', () => {
    expect(gateNotice(snapshot({ status: { signedIn: false, keychainMissing: true, accountsDamaged: true }, actionFailed: 'start' })))
      .toBe('no-keychain');
  });

  test('a damaged account list asks for repair, and a failed repair says so', () => {
    expect(gateNotice(snapshot({ status: { signedIn: false, accountsDamaged: true } }))).toBe('accounts-damaged');
    expect(gateNotice(snapshot({ status: { signedIn: false, accountsDamaged: true }, actionFailed: 'repair' }))).toBe('repair-failed');
  });

  test('a sign-in that did not finish in the browser is told apart from one that could not reach Mittr', () => {
    expect(gateNotice(snapshot({ status: { signedIn: false, signInFailed: 'failed' } }))).toBe('sign-in-failed');
    expect(gateNotice(snapshot({ status: { signedIn: false, signInFailed: 'unreachable' } }))).toBe('sign-in-unreachable');
  });

  test('a start that failed, a browser trip under way, and a status nobody could read each have their notice', () => {
    expect(gateNotice(snapshot({ actionFailed: 'start' }))).toBe('start-failed');
    expect(gateNotice(snapshot({ waiting: true }))).toBe('waiting');
    expect(gateNotice(snapshot({ status: null, checkFailed: true }))).toBe('check-failed');
    expect(gateNotice(snapshot())).toBe(null);
  });

  test('an account Mittr signed out is said, below anything that stands in the way of signing in again', () => {
    expect(parseSignInStatus({ signedIn: false, sessionEnded: true })).toEqual({ signedIn: false, sessionEnded: true });
    expect(parseSignInStatus({ signedIn: true, userId: 'u1', sessionEnded: true })).toEqual({ signedIn: true, userId: 'u1' });
    expect(gateNotice(snapshot({ status: { signedIn: false, sessionEnded: true } }))).toBe('session-ended');
    expect(gateNotice(snapshot({ status: { signedIn: false, sessionEnded: true }, waiting: true }))).toBe('waiting');
    expect(gateNotice(snapshot({ status: { signedIn: false, sessionEnded: true, accountsDamaged: true } }))).toBe('accounts-damaged');
  });

  test('a new browser trip hides the failure of the one before', () => {
    expect(gateNotice(snapshot({ status: { signedIn: false, signInFailed: 'failed' }, waiting: true }))).toBe('waiting');
  });
});

test('the routes and the desktop events are the ones the server and the shell use', () => {
  expect(SIGN_IN_STATUS_ENDPOINT).toBe('/api/mittr/auth/status');
  expect(SIGN_IN_START_ENDPOINT).toBe('/api/mittr/auth/start');
  expect(SIGN_IN_COMPLETED_EVENT).toBe('mittrcraft:signed-in');
  expect(SIGN_IN_FAILED_EVENT).toBe('mittrcraft:sign-in-failed');
});
