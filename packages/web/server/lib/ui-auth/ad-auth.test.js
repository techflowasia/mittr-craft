import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ldap from 'ldapjs';
import { createAdAuth } from './ad-auth.js';

vi.mock('ldapjs', () => ({ default: { createClient: vi.fn() } }));

const ldapEnv = {
  MITTR_AD_ENABLED: 'true',
  MITTR_AD_URL: 'ldaps://directory.example.com:636',
  MITTR_AD_BIND_DN: 'CN=reader,DC=example,DC=com',
  MITTR_AD_BIND_PASSWORD: 'test-reader-password',
  MITTR_AD_SEARCH_BASE: 'DC=example,DC=com',
};
const entraEnv = {
  MITTR_AD_CLIENT_ID: 'test-client',
  MITTR_AD_CLIENT_SECRET: 'test-secret',
  MITTR_AD_TENANT_ID: 'test-tenant',
  MITTR_AD_REDIRECT_URI: 'https://mittrcraft.example.com/auth/ad/callback',
};
const userDn = 'CN=Ada,DC=example,DC=com';
const entry = {
  dn: { toString: () => userDn },
  pojo: {
    attributes: [
      { type: 'sAMAccountName', values: ['ada'] },
      { type: 'displayName', values: ['Ada Lovelace'] },
      { type: 'mail', values: ['ada@example.com'] },
      { type: 'department', values: ['Engineering'] },
      { type: 'title', values: ['Engineer'] },
      { type: 'memberOf', values: ['CN=Developers,DC=example,DC=com'] },
    ],
  },
};
const profile = {
  username: 'ada',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  department: 'Engineering',
  title: 'Engineer',
  groups: ['Developers'],
};

const fakeClient = ({ failure, entries = [entry] } = {}) => {
  const client = new EventEmitter();
  const error = new Error('Test LDAP failure');
  client.bind = vi.fn((_dn, _password, callback) => callback(failure === 'bind' ? error : null));
  client.search = vi.fn((_base, _options, callback) => {
    if (failure === 'search') return callback(error);
    const result = new EventEmitter();
    callback(null, result);
    queueMicrotask(() => {
      if (failure === 'searchEvent') {
        result.emit('error', error);
        return;
      }
      for (const user of entries) result.emit('searchEntry', user);
      result.emit('end');
    });
  });
  client.unbind = vi.fn((callback) => callback());
  ldap.createClient.mockImplementationOnce(() => {
    queueMicrotask(() => client.emit(failure === 'connect' ? 'connectError' : 'connect', error));
    return client;
  });
  return client;
};

const expectSecureOptions = (url = ldapEnv.MITTR_AD_URL) => {
  expect(ldap.createClient).toHaveBeenLastCalledWith({
    url,
    tlsOptions: { rejectUnauthorized: true },
    connectTimeout: 5000,
    timeout: 10000,
    idleTimeout: 10000,
  });
};

let auth;
beforeEach(() => {
  ldap.createClient.mockReset();
  for (const [key, value] of Object.entries(ldapEnv)) vi.stubEnv(key, value);
  for (const key of Object.keys(entraEnv)) vi.stubEnv(key, '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  auth?.dispose();
  auth = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('LDAP configuration compatibility', () => {
  it.each(['false', 'TRUE', ''])('requires exact enabled=true, not %j', (enabled) => {
    vi.stubEnv('MITTR_AD_ENABLED', enabled);
    auth = createAdAuth();
    expect(auth.enabled).toBe(false);
    expect(ldap.createClient).not.toHaveBeenCalled();
  });

  it.each(['MITTR_AD_URL', 'MITTR_AD_BIND_DN', 'MITTR_AD_BIND_PASSWORD', 'MITTR_AD_SEARCH_BASE'])(
    'stays disabled without %s', async (key) => {
      vi.stubEnv(key, '');
      auth = createAdAuth();
      expect(auth.getStatus()).toEqual({ enabled: false });
      expect(await auth.authenticate('ada', 'test-password')).toEqual({
        ok: false, error: 'AD authentication not configured',
      });
      expect(await auth.getProfile('ada')).toBeNull();
      expect(ldap.createClient).not.toHaveBeenCalled();
    },
  );

  it.each(['partial', 'complete'])('keeps %s Entra configuration ahead of LDAP', (configuration) => {
    const values = configuration === 'partial' ? { MITTR_AD_CLIENT_ID: 'test-client' } : entraEnv;
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    auth = createAdAuth();
    expect(auth.mode).toBe('entra');
    expect(auth.enabled).toBe(configuration === 'complete');
    expect(auth.configurationPresent).toBe(true);
    expect(ldap.createClient).not.toHaveBeenCalled();
  });
});

for (const operation of ['authenticate', 'getProfile']) {
  describe(operation, () => {
    const invoke = () => auth[operation]('ada', 'test-user-password');
    const success = operation === 'authenticate' ? { ok: true, profile } : profile;
    const failureResult = operation === 'authenticate'
      ? { ok: false, error: 'AD authentication failed' }
      : null;

    it.each([ldapEnv.MITTR_AD_URL, 'ldap://directory.example.com:389'])(
      'preserves successful lookup and cleanup for %s', async (url) => {
        vi.stubEnv('MITTR_AD_URL', url);
        const client = fakeClient();
        auth = createAdAuth();
        expect(await invoke()).toEqual(success);
        expectSecureOptions(url);
        expect(client.search).toHaveBeenCalledWith(ldapEnv.MITTR_AD_SEARCH_BASE, {
          filter: '(sAMAccountName=ada)',
          scope: 'sub',
          attributes: ['sAMAccountName', 'displayName', 'mail', 'department', 'title', 'memberOf'],
        }, expect.any(Function));
        expect(client.bind).toHaveBeenCalledExactlyOnceWith(
          operation === 'authenticate' ? userDn : ldapEnv.MITTR_AD_BIND_DN,
          operation === 'authenticate' ? 'test-user-password' : ldapEnv.MITTR_AD_BIND_PASSWORD,
          expect.any(Function),
        );
        expect(client.unbind).toHaveBeenCalledTimes(1);
        expect(await auth.getProfile('ada')).toEqual(profile);
        expect(ldap.createClient).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['connect', 'bind', 'search', 'searchEvent'])(
      'fails closed and unbinds after %s failure without caching a profile', async (failure) => {
        const client = fakeClient({ failure });
        auth = createAdAuth();
        expect(await invoke()).toEqual(failureResult);
        expectSecureOptions();
        expect(client.unbind).toHaveBeenCalledTimes(1);
        if (failure === 'connect') {
          expect(client.bind).not.toHaveBeenCalled();
          expect(client.search).not.toHaveBeenCalled();
        }
        const retryClient = fakeClient();
        expect(await auth.getProfile('ada')).toEqual(profile);
        expect(ldap.createClient).toHaveBeenCalledTimes(2);
        expect(retryClient.unbind).toHaveBeenCalledTimes(1);
      },
    );

    it('returns the existing missing-user result and unbinds', async () => {
      const client = fakeClient({ entries: [] });
      auth = createAdAuth();
      expect(await invoke()).toEqual(operation === 'authenticate'
        ? { ok: false, error: 'User not found' }
        : null);
      expectSecureOptions();
      expect(client.unbind).toHaveBeenCalledTimes(1);
    });
  });
}
