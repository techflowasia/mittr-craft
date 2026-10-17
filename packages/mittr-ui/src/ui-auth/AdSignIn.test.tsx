import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import type { RuntimeUrlQuery } from '../../../ui/src/lib/runtime-url';
import { mittrT } from '../strings/mittrT';
import type { AdFetch, AdStatus } from './adStatus';
import { entraLoginUrl, submitAdSession } from './adApi';
import { AdSignInView } from './AdSignIn';

const entra: AdStatus = { enabled: true, mode: 'entra', passwordEnabled: false, tunnelLocked: false };
const ldap: AdStatus = { enabled: true, mode: 'ldap', passwordEnabled: false, tunnelLocked: false };

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const view = (props: Partial<React.ComponentProps<typeof AdSignInView>> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <AdSignInView status={entra} isDesktop={false} isTunnelLocked={false} {...props} />
  </I18nProvider>,
);

describe('AdSignInView', () => {
  test('Microsoft button on hosted web with Entra', () => {
    const html = view();
    expect(html).toContain(escaped(mittrT('mittr.uiAuth.microsoft')));
    expect(html).toContain('<button');
    expect(html).not.toContain('type="password"');
  });

  test('nothing on desktop', () => {
    expect(view({ isDesktop: true })).toBe('');
    expect(view({ isDesktop: true, status: ldap })).toBe('');
  });

  test('nothing when tunnel-locked', () => {
    expect(view({ isTunnelLocked: true })).toBe('');
    expect(view({ status: { ...entra, tunnelLocked: true } })).toBe('');
  });

  test('nothing when company sign-in is off or not known yet', () => {
    expect(view({ status: { enabled: false, passwordEnabled: true, tunnelLocked: false } })).toBe('');
    expect(view({ status: null })).toBe('');
  });

  test('LDAP shows a username and a password field that offers the saved password', () => {
    const html = view({ status: ldap });
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('type="password"');
    expect(html).toContain(escaped(mittrT('mittr.uiAuth.username')));
    expect(html).not.toContain(escaped(mittrT('mittr.uiAuth.microsoft')));
  });

  test('the "or" divider shows only next to a password form', () => {
    expect(view({ status: { ...entra, passwordEnabled: true } })).toContain(`>${escaped(mittrT('mittr.uiAuth.or'))}<`);
    expect(view()).not.toContain(`>${escaped(mittrT('mittr.uiAuth.or'))}<`);
  });

  test('trust this device is offered here only when the gate has no password form to carry it', () => {
    expect(view()).toContain(escaped(mittrT('mittr.uiAuth.trustDevice')));
    expect(view({ status: { ...entra, passwordEnabled: true } })).not.toContain(escaped(mittrT('mittr.uiAuth.trustDevice')));
  });
});

describe('submitAdSession', () => {
  const recording = (status: number, body: JsonValue = {}) => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetch: AdFetch = async (path, init) => {
      calls.push({ path, init });
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { calls, fetch };
  };

  test('LDAP form posts username and password', async () => {
    const { calls, fetch } = recording(200, { authenticated: true });
    const result = await submitAdSession({ fetch, username: 'u', password: 'p', trustDevice: false });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/auth/ad/session');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.credentials).toBe('include');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ username: 'u', password: 'p', trustDevice: false });
  });

  test('a trusted device is sent as trusted', async () => {
    const { calls, fetch } = recording(200);
    await submitAdSession({ fetch, username: 'u', password: 'p', trustDevice: true });
    expect(JSON.parse(String(calls[0].init?.body)).trustDevice).toBe(true);
  });

  test('wrong credentials, too many tries and any other failure are told apart', async () => {
    expect(await submitAdSession({ fetch: recording(401).fetch, username: 'u', password: 'p', trustDevice: false })).toEqual({ ok: false, reason: 'invalid' });
    expect(await submitAdSession({ fetch: recording(429).fetch, username: 'u', password: 'p', trustDevice: false })).toEqual({ ok: false, reason: 'rate-limited' });
    expect(await submitAdSession({ fetch: recording(502).fetch, username: 'u', password: 'p', trustDevice: false })).toEqual({ ok: false, reason: 'failed' });
    expect(await submitAdSession({ fetch: async () => { throw new Error('offline'); }, username: 'u', password: 'p', trustDevice: false })).toEqual({ ok: false, reason: 'failed' });
  });

  test('the password is in no result', async () => {
    const results = [
      await submitAdSession({ fetch: recording(200).fetch, username: 'u', password: 'secret-value', trustDevice: false }),
      await submitAdSession({ fetch: recording(401).fetch, username: 'u', password: 'secret-value', trustDevice: false }),
    ];
    expect(JSON.stringify(results)).not.toContain('secret-value');
  });
});

describe('entraLoginUrl', () => {
  const auth = (path: string, query?: RuntimeUrlQuery) => {
    const url = new URL(`https://host.example${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return `${url.pathname}${url.search}`;
  };

  test('goes to the login route and comes back to the current path', () => {
    expect(entraLoginUrl(auth, { pathname: '/projects/a', search: '?tab=1' }, false)).toBe('/auth/ad/login?returnTo=%2Fprojects%2Fa%3Ftab%3D1');
  });

  test('a trusted device is asked for', () => {
    expect(entraLoginUrl(auth, { pathname: '/', search: '' }, true)).toBe('/auth/ad/login?returnTo=%2F&trustDevice=true');
  });
});
