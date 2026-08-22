import { beforeEach, describe, expect, mock, test } from 'bun:test';

const runtimeFetchCalls: unknown[][] = [];
let runtimeFetchResponses: Response[] = [];
const runtimeFetchMock = mock(async (...args: unknown[]): Promise<Response> => {
  runtimeFetchCalls.push(args);
  return runtimeFetchResponses.shift() ?? new Response(null, { status: 500 });
});

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: runtimeFetchMock }));

const {
  fetchSidebarUserProfile,
  getSidebarUserInitials,
  logoutSidebarUserProfile,
  parseSidebarUserProfile,
  shouldRequestSidebarProfileLogin,
} = await import('./sidebarUserProfile');

describe('sidebar user profile', () => {
  beforeEach(() => {
    runtimeFetchCalls.length = 0;
    runtimeFetchResponses = [];
  });

  test('parses a valid Entra profile and prefers display name and email', () => {
    expect(parseSidebarUserProfile({
      profile: {
        id: 'user-id',
        username: 'prawee.won',
        displayName: 'Prawee Won',
        email: 'prawee@example.com',
        tenantId: 'tenant-id',
      },
    })).toEqual({
      username: 'prawee.won',
      displayName: 'Prawee Won',
      email: 'prawee@example.com',
      department: null,
      title: null,
      groups: [],
      secondaryLabel: 'prawee@example.com',
    });
  });

  test('falls back to username and rejects missing or malformed profiles', () => {
    expect(parseSidebarUserProfile({ profile: { username: 'prawee.won' } })).toEqual({
      username: 'prawee.won',
      displayName: 'prawee.won',
      email: null,
      department: null,
      title: null,
      groups: [],
      secondaryLabel: null,
    });
    expect(parseSidebarUserProfile({ profile: { displayName: 123, email: [] } })).toBeNull();
    expect(parseSidebarUserProfile({ error: 'Not authenticated' })).toBeNull();
    expect(parseSidebarUserProfile(null)).toBeNull();
  });

  test('uses the username as secondary text when the email is unavailable', () => {
    expect(parseSidebarUserProfile({
      profile: { displayName: 'Prawee Won', username: 'prawee.won' },
    })).toEqual({
      username: 'prawee.won',
      displayName: 'Prawee Won',
      email: null,
      department: null,
      title: null,
      groups: [],
      secondaryLabel: 'prawee.won',
    });
  });

  test('preserves known LDAP organization fields and discards malformed group values', () => {
    expect(parseSidebarUserProfile({
      profile: {
        username: 'prawee.won',
        displayName: 'Prawee Won',
        department: 'Engineering',
        title: 'Staff Engineer',
        groups: ['Platform', '  Developers  ', null, 123, ''],
      },
    })).toEqual({
      username: 'prawee.won',
      displayName: 'Prawee Won',
      email: null,
      department: 'Engineering',
      title: 'Staff Engineer',
      groups: ['Platform', 'Developers'],
      secondaryLabel: 'prawee.won',
    });
  });

  test('treats an unsupported profile response as unavailable', async () => {
    runtimeFetchResponses = [Response.json({ enabled: false })];
    const controller = new AbortController();
    expect(await fetchSidebarUserProfile(controller.signal)).toEqual({ status: 'unavailable' });
    expect(runtimeFetchCalls).toEqual([[
      '/auth/ad/status',
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      },
    ]]);
  });

  test('requires login when AD is enabled but the session has no profile', async () => {
    runtimeFetchResponses = [
      Response.json({ enabled: true, mode: 'entra' }),
      Response.json({ error: 'User profile not found' }, { status: 404 }),
    ];
    const controller = new AbortController();

    expect(await fetchSidebarUserProfile(controller.signal)).toEqual({ status: 'auth-required' });
    expect(runtimeFetchCalls.map(([path]) => path)).toEqual(['/auth/ad/status', '/auth/ad/profile']);
  });

  test('requires one reauthentication for a legacy Desktop Entra token without a profile', async () => {
    runtimeFetchResponses = [
      Response.json({ enabled: true }),
      Response.json(
        { error: 'Microsoft sign-in must be renewed', reauthenticationRequired: true },
        { status: 409 },
      ),
    ];
    const controller = new AbortController();

    const result = await fetchSidebarUserProfile(controller.signal);
    expect(result).toEqual({ status: 'reauth-required' });
    expect(shouldRequestSidebarProfileLogin(result, false)).toBe(true);
  });

  test('keeps ordinary Desktop bearer profile misses out of a login loop', () => {
    expect(shouldRequestSidebarProfileLogin({ status: 'auth-required' }, false)).toBe(false);
    expect(shouldRequestSidebarProfileLogin({ status: 'auth-required' }, true)).toBe(true);
    expect(shouldRequestSidebarProfileLogin({ status: 'unavailable' }, true)).toBe(false);
  });

  test('returns a parsed profile for an authenticated AD session', async () => {
    runtimeFetchResponses = [
      Response.json({ enabled: true, mode: 'entra' }),
      Response.json({ profile: { displayName: 'Prawee Won', email: 'prawee@example.com' } }),
    ];
    const controller = new AbortController();

    expect(await fetchSidebarUserProfile(controller.signal)).toEqual({
      status: 'ready',
      profile: {
        username: null,
        displayName: 'Prawee Won',
        email: 'prawee@example.com',
        department: null,
        title: null,
        groups: [],
        secondaryLabel: 'prawee@example.com',
      },
    });
  });

  test('logs out only through the current UI session endpoint', async () => {
    runtimeFetchResponses = [Response.json({ authenticated: false })];
    const controller = new AbortController();

    expect(await logoutSidebarUserProfile(controller.signal)).toBe(true);
    expect(runtimeFetchCalls).toEqual([[
      '/auth/session',
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        method: 'DELETE',
      },
    ]]);
  });

  test('reports a failed logout without treating it as success', async () => {
    runtimeFetchResponses = [Response.json({ error: 'Logout failed' }, { status: 500 })];
    const controller = new AbortController();

    expect(await logoutSidebarUserProfile(controller.signal)).toBe(false);
  });

  test('creates compact initials for names and email fallbacks', () => {
    expect(getSidebarUserInitials('Prawee Won')).toBe('PW');
    expect(getSidebarUserInitials('prawee@example.com')).toBe('PR');
    expect(getSidebarUserInitials('ปรวีร์')).toBe('ปร');
  });
});
