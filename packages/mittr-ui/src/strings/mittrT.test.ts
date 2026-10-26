import { afterEach, describe, expect, test } from 'bun:test';

import { useI18nStore } from '../../../ui/src/lib/i18n/store';
import { DEFAULT_LOCALE } from '../../../ui/src/lib/i18n/runtime';
import { mittrEn } from './mittr.en';
import { mittrT, useMittrT } from './mittrT';

const waitForLocale = async (locale: string) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = useI18nStore.getState();
    if (state.locale === locale && state.loadingLocale === null) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`the UI never settled on ${locale}`);
};

afterEach(() => {
  useI18nStore.getState().setLocale(DEFAULT_LOCALE);
});

describe('Mittr strings', () => {
  test('Mittr strings are English in Japanese', async () => {
    useI18nStore.getState().setLocale('ja');
    await waitForLocale('ja');

    expect(mittrT('mittr.signIn.action')).toBe(mittrEn['mittr.signIn.action']);
    expect(mittrT('mittr.signIn.action')).toBe('Sign in with Mittr');
    expect(mittrT('mittr.signIn.action')).not.toBe('mittr.signIn.action');
  });

  test('every Mittr string has text, so none can show as its key', () => {
    const empty = Object.entries(mittrEn).filter(([key, value]) => !value.trim() || value === key).map(([key]) => key);
    expect(empty).toEqual([]);
  });

  test('the hook answers the same function, in every locale', () => {
    expect(useMittrT()).toBe(mittrT);
  });

  test('the refusals read exactly as the server words them', () => {
    expect(mittrEn['mittr.signIn.noKeychain']).toBe("MittrCraft can't find a secure keychain on this computer to keep your sign-in safe.");
    expect(mittrEn['mittr.signIn.accountsDamaged']).toBe('Your Mittr account list on this computer is damaged. Choose Repair to set it aside and sign in again.');
  });
});
