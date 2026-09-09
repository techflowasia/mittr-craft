import { describe, expect, test } from 'bun:test';
import {
  gateStateFromStatus,
  parseAuthorizeUrl,
  parseSignInStatus,
} from './mittrSignInGateState';

describe('parseSignInStatus', () => {
  test('reads a signed-in status', () => {
    expect(parseSignInStatus({ signedIn: true, displayName: 'Chaiwat' }))
      .toEqual({ signedIn: true, displayName: 'Chaiwat' });
  });

  test('treats anything that is not exactly true as signed out', () => {
    expect(parseSignInStatus({ signedIn: 'yes' }).signedIn).toBe(false);
    expect(parseSignInStatus({ signedIn: 1 }).signedIn).toBe(false);
    expect(parseSignInStatus({}).signedIn).toBe(false);
    expect(parseSignInStatus(null).signedIn).toBe(false);
  });

  test('tolerates a missing display name', () => {
    expect(parseSignInStatus({ signedIn: true }).displayName).toBe('');
  });
});

describe('gateStateFromStatus', () => {
  test('waits while the status is unknown', () => {
    expect(gateStateFromStatus(null)).toBe('checking');
  });

  test('opens the application only for a signed-in status', () => {
    expect(gateStateFromStatus({ signedIn: true, displayName: '' })).toBe('signed-in');
    expect(gateStateFromStatus({ signedIn: false, displayName: '' })).toBe('signed-out');
  });
});

describe('parseAuthorizeUrl', () => {
  test('accepts a web address', () => {
    expect(parseAuthorizeUrl({ authorizeUrl: 'https://mittr.test/api/auth/desktop/start?x=1' }))
      .toBe('https://mittr.test/api/auth/desktop/start?x=1');
  });

  test('refuses anything that is not a web address, since this is handed to a browser', () => {
    expect(parseAuthorizeUrl({ authorizeUrl: 'javascript:alert(1)' })).toBeNull();
    expect(parseAuthorizeUrl({ authorizeUrl: 'file:///etc/passwd' })).toBeNull();
  });

  test('refuses a missing or malformed value rather than returning it', () => {
    expect(parseAuthorizeUrl({})).toBeNull();
    expect(parseAuthorizeUrl({ authorizeUrl: '' })).toBeNull();
    expect(parseAuthorizeUrl({ authorizeUrl: 'not a url' })).toBeNull();
    expect(parseAuthorizeUrl(null)).toBeNull();
  });
});
