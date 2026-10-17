import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DropdownMenu } from '../../../ui/src/components/ui/dropdown-menu';
import { I18nProvider } from '../../../ui/src/lib/i18n';
import { mittrT } from '../strings/mittrT';
import type { AdFetch } from './adStatus';
import { loadAdProfile, parseAdProfile, signOutAd, type AdProfile } from './adApi';
import { SidebarProfileHost, SidebarProfileItems, SidebarProfileView } from './SidebarProfile';

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const profile: AdProfile = { displayName: 'Ann Lee', title: 'Engineer', department: 'Platform' };

const view = (props: Partial<React.ComponentProps<typeof SidebarProfileView>> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <SidebarProfileView profile={profile} open signingOut={false} onOpenChange={() => {}} onSignOut={() => {}} {...props} />
  </I18nProvider>,
);

const answer = (status: number, body: JsonValue = {}): AdFetch => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const items = (props: Partial<React.ComponentProps<typeof SidebarProfileItems>> = {}) => renderToStaticMarkup(
  <DropdownMenu open>
    <SidebarProfileItems profile={profile} signingOut={false} onSignOut={() => {}} {...props} />
  </DropdownMenu>,
);

describe('SidebarProfileView', () => {
  test('shows name, title and department, and Sign out', () => {
    const html = items();
    expect(html).toContain('Ann Lee');
    expect(html).toContain('Engineer');
    expect(html).toContain('Platform');
    expect(html).toContain(escaped(mittrT('mittr.uiAuth.signOut')));
  });

  test('leaves out a title or department the directory does not have', () => {
    const html = items({ profile: { displayName: 'Bo', title: null, department: null } });
    expect(html).toContain('Bo');
    expect(html).not.toContain('Engineer');
  });

  test('the footer button shows initials and names the person', () => {
    const html = view();
    expect(html).toContain('>AL<');
    expect(html).toContain(`aria-label="${escaped(mittrT('mittr.uiAuth.profile.label', { name: 'Ann Lee' }))}"`);
  });
});

describe('SidebarProfileHost', () => {
  test('nothing on desktop', () => {
    expect(renderToStaticMarkup(<I18nProvider><SidebarProfileHost isDesktop /></I18nProvider>)).toBe('');
  });
});

describe('parseAdProfile', () => {
  test('reads the profile the route answers', () => {
    expect(parseAdProfile({ profile: { displayName: ' Ann Lee ', title: 'Engineer', department: 'Platform', email: 'a@x.example' } })).toEqual(profile);
  });

  test('falls back to the username or email when there is no display name', () => {
    expect(parseAdProfile({ profile: { username: 'ann', email: 'a@x.example' } })?.displayName).toBe('ann');
    expect(parseAdProfile({ profile: { email: 'a@x.example' } })?.displayName).toBe('a@x.example');
  });

  test('a body with no name is no profile', () => {
    expect(parseAdProfile({ profile: {} })).toBeNull();
    expect(parseAdProfile({})).toBeNull();
    expect(parseAdProfile(null)).toBeNull();
  });
});

describe('loadAdProfile', () => {
  test('asks the profile route with the session cookie', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const loaded = await loadAdProfile(async (path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 200, json: async () => ({ profile: { displayName: 'Ann Lee', title: 'Engineer', department: 'Platform' } }) };
    });
    expect(loaded).toEqual(profile);
    expect(calls[0].path).toBe('/auth/ad/profile');
    expect(calls[0].init?.credentials).toBe('include');
  });

  test('no company session, a tunnel, a server error or an offline network is no profile', async () => {
    expect(await loadAdProfile(answer(401))).toBeNull();
    expect(await loadAdProfile(answer(400))).toBeNull();
    expect(await loadAdProfile(answer(403))).toBeNull();
    expect(await loadAdProfile(answer(500))).toBeNull();
    expect(await loadAdProfile(async () => { throw new Error('offline'); })).toBeNull();
  });
});

describe('signOutAd', () => {
  test('sends DELETE /auth/session and says whether it worked', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const ok = await signOutAd(async (path, init) => {
      calls.push({ path, init });
      return { ok: true, status: 200, json: async () => ({ authenticated: false }) };
    });
    expect(ok).toBe(true);
    expect(calls[0].path).toBe('/auth/session');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(await signOutAd(answer(500))).toBe(false);
    expect(await signOutAd(async () => { throw new Error('offline'); })).toBe(false);
  });
});
