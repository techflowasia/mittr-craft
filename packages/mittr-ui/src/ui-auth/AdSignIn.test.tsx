import type { JsonValue } from '@openchamber/sdk';
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import type { RuntimeUrlQuery } from '../../../ui/src/lib/runtime-url';
import { mittrT } from '../strings/mittrT';
import type { AdFetch, AdStatus } from './adStatus';
import { entraLoginUrl, signInWithDirectory, submitAdSession } from './adApi';
import { AdSignInView } from './AdSignIn';

const entra: AdStatus = { enabled: true, mode: 'entra', passwordEnabled: false, tunnelLocked: false };
const ldap: AdStatus = { enabled: true, mode: 'ldap', passwordEnabled: false, tunnelLocked: false };

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const view = (props: Partial<React.ComponentProps<typeof AdSignInView>> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <AdSignInView status={entra} runtime="web" isTunnelLocked={false} onSignedIn={async () => true} {...props} />
  </I18nProvider>,
);

describe('AdSignInView', () => {
  test('Microsoft button on hosted web with Entra', () => {
    const html = view();
    expect(html).toContain(escaped(mittrT('mittr.uiAuth.microsoft')));
    expect(html).toContain('<button');
    expect(html).not.toContain('type="password"');
  });

  test('nothing on a local desktop, which has no remote host to sign in to', () => {
    expect(view({ runtime: 'desktop-local' })).toBe('');
    expect(view({ runtime: 'desktop-local', status: ldap })).toBe('');
  });

  test('a desktop window connected to a remote host gets the LDAP form', () => {
    const html = view({ runtime: 'desktop-remote', status: ldap });
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('type="password"');
  });

  test('a desktop window connected to a remote host is pointed to a browser for Microsoft', () => {
    const html = view({ runtime: 'desktop-remote' });
    expect(html).toContain(escaped(mittrT('mittr.uiAuth.microsoftInBrowser')));
    expect(html).not.toContain('<button');
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

describe('signInWithDirectory', () => {
  const signIn = async (runtime: 'web' | 'desktop-remote', { answer = 200, body = { authenticated: true, clientToken: 'issued' }, accept = true }: { answer?: number; body?: JsonValue; accept?: boolean } = {}) => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const signedIn: Array<string | undefined> = [];
    const result = await signInWithDirectory({
      fetch: async (path, init) => {
        calls.push({ path, init });
        return { ok: answer < 300, status: answer, json: async () => body };
      },
      username: 'u',
      password: 'p',
      trustDevice: false,
      runtime,
      onSignedIn: async (clientToken) => {
        signedIn.push(clientToken);
        return accept;
      },
    });
    return { result, calls, signedIn };
  };

  test('a successful remote-desktop sign-in requests a client token once and hands it on', async () => {
    const { result, calls, signedIn } = await signIn('desktop-remote');
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ username: 'u', password: 'p', trustDevice: false, issueClientToken: true, clientLabel: 'MittrCraft Desktop' });
    expect(signedIn).toEqual(['issued']);
  });

  test('a web sign-in asks for no client token, and the gate lets the person in', async () => {
    const { result, calls, signedIn } = await signIn('web', { body: { authenticated: true } });
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ username: 'u', password: 'p', trustDevice: false });
    expect(signedIn).toEqual([undefined]);
  });

  test('a server that gave no token leaves the gate to ask for one', async () => {
    const { signedIn } = await signIn('desktop-remote', { body: { authenticated: true } });
    expect(signedIn).toEqual([undefined]);
  });

  test('a gate that could not let the person in is a failed sign-in', async () => {
    expect((await signIn('desktop-remote', { accept: false })).result).toEqual({ ok: false, reason: 'failed' });
  });

  test('wrong credentials never reach the gate', async () => {
    const { result, signedIn } = await signIn('desktop-remote', { answer: 401, body: { error: 'Invalid credentials' } });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(signedIn).toEqual([]);
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
