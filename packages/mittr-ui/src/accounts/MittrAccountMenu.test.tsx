import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DropdownMenu } from '../../../ui/src/components/ui/dropdown-menu';
import { I18nProvider } from '../../../ui/src/lib/i18n';
import { mittrT } from '../strings/mittrT';
import { AccountSwitchStatus } from './AccountSwitchDialog';
import { initialsOf } from './accountsApi';
import { menuActions } from './menuActions';
import { MittrAccountMenuItems, MittrAccountMenuView, type MittrAccountMenuViewProps } from './MittrAccountMenu';

const A = { userId: 'u-a', displayName: 'Ann Lee', active: false };
const B = { userId: 'u-b', displayName: 'Bo', active: true };

const noop = () => {};

const handlers = { onActivate: noop, onAddAccount: noop, onCancelAddAccount: noop, onSignOut: noop };

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const items = (props: Partial<React.ComponentProps<typeof MittrAccountMenuItems>> = {}) => renderToStaticMarkup(
  <DropdownMenu open>
    <MittrAccountMenuItems accounts={[A, B]} loadFailed={false} finishingSignIn={false} {...handlers} {...props} />
  </DropdownMenu>,
);

const view = (props: Partial<MittrAccountMenuViewProps> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <MittrAccountMenuView accounts={[A, B]} open loadFailed={false} finishingSignIn={false} onOpenChange={noop} {...handlers} {...props} />
  </I18nProvider>,
);

const menuItems = (html: string) => [...html.matchAll(/<div role="menuitem"[^>]*>([\s\S]*?)<\/div>/g)].map((match) => match[1]);

describe('MittrAccountMenu', () => {
  test('menu lists A and B with B active', () => {
    const rows = menuItems(items());
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('Ann Lee');
    expect(rows[0]).not.toContain('oc-check');
    expect(rows[1]).toContain('Bo');
    expect(rows[1]).toContain('oc-check');
    expect(rows[2]).toContain(mittrT('mittr.accounts.menu.add'));
    expect(rows[3]).toContain(mittrT('mittr.accounts.signOut'));
  });

  test('the footer button shows the active account\'s initials and names the menu and the account', () => {
    const html = view();
    expect(html).toContain('>B<');
    expect(html).toContain(`aria-label="${escaped(mittrT('mittr.accounts.menu.labelFor', { name: 'Bo' }))}"`);
    expect(view({ accounts: null })).toContain(`aria-label="${escaped(mittrT('mittr.accounts.menu.label'))}"`);
    expect(view({ accounts: [{ ...A, active: true }] })).toContain('>AL<');
    expect(view({ accounts: null })).toContain('oc-user');
  });

  test('a list that could not be read says so and still offers add and sign out', () => {
    const rows = menuItems(items({ accounts: null, loadFailed: true }));
    expect(items({ accounts: null, loadFailed: true })).toContain(escaped(mittrT('mittr.accounts.menu.loadFailed')));
    expect(rows).toHaveLength(2);
  });

  test('while an added account is finishing its sign-in, switching and signing out are held back', () => {
    const html = items({ finishingSignIn: true });
    expect(html).toContain(escaped(mittrT('mittr.accounts.add.finishing')));
    const rows = [...html.matchAll(/<div([^>]*role="menuitem"[^>]*)>([\s\S]*?)<\/div>/g)].map((match) => ({ attrs: match[1], body: match[2] }));
    const disabled = rows.filter((row) => row.attrs.includes('aria-disabled="true"')).map((row) => row.body);
    expect(disabled).toHaveLength(2);
    expect(disabled[0]).toContain('Ann Lee');
    expect(disabled[1]).toContain(mittrT('mittr.accounts.signOut'));
    expect(items()).not.toContain('aria-disabled="true"');
  });

  test('while an added account is finishing its sign-in, the note says it waits on the browser and offers Cancel', () => {
    const html = items({ finishingSignIn: true });
    expect(mittrT('mittr.accounts.add.finishing')).toBe('Waiting for sign-in in the browser…');
    const rows = [...html.matchAll(/<div([^>]*role="menuitem"[^>]*)>([\s\S]*?)<\/div>/g)].map((match) => ({ attrs: match[1], body: match[2] }));
    expect(rows).toHaveLength(5);
    expect(rows[0].body).toContain(escaped(mittrT('mittr.accounts.add.cancel')));
    expect(rows[0].attrs).not.toContain('aria-disabled="true"');
    expect(html.indexOf(escaped(mittrT('mittr.accounts.add.finishing')))).toBeLessThan(html.indexOf(escaped(mittrT('mittr.accounts.add.cancel'))));
    expect(items()).not.toContain(escaped(mittrT('mittr.accounts.add.cancel')));
  });

  test('the menu\'s actions start the add, cancel it, switch and sign out through the flows', () => {
    const log: string[] = [];
    const actions = menuActions({
      addAccount: { start: async () => { log.push('start'); }, cancel: () => { log.push('cancel'); } },
      runSwitch: (change) => { log.push('switch'); void change(); },
      api: {
        activateAccount: async (userId) => { log.push(`activate ${userId}`); return { signedIn: true }; },
        signOutActive: async () => { log.push('sign out'); return { signedIn: false }; },
      },
    });
    actions.onAddAccount();
    actions.onCancelAddAccount();
    actions.onActivate('u-a');
    actions.onSignOut();
    expect(log).toEqual(['start', 'cancel', 'switch', 'activate u-a', 'switch', 'sign out']);
  });

  test('an account with no name is listed by its id', () => {
    expect(items({ accounts: [{ userId: 'u-z', displayName: '', active: true }] })).toContain('u-z');
  });

  test('initials take the first letter of the first and last word', () => {
    expect(initialsOf('Ann Lee')).toBe('AL');
    expect(initialsOf('  chai  wat  tan ')).toBe('CT');
    expect(initialsOf('Bo')).toBe('B');
    expect(initialsOf('')).toBe('');
  });
});

describe('the switch wait state', () => {
  const status = (state: React.ComponentProps<typeof AccountSwitchStatus>['state']) => renderToStaticMarkup(
    <AccountSwitchStatus state={state} onRetry={noop} onDismiss={noop} />,
  );
  const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1].replace(/<[^>]+>/g, ''));

  test('a switch under way says so and offers nothing to press', () => {
    const html = status('switching');
    expect(html).toContain(mittrT('mittr.accounts.switch.waiting'));
    expect(html).toContain('role="status"');
    expect(buttons(html)).toEqual([]);
  });

  test('an engine that did not restart offers Retry only', () => {
    const html = status('not-restarted');
    expect(html).toContain(escaped(mittrT('mittr.accounts.switch.notRestarted')));
    expect(html).toContain(escaped(mittrT('mittr.accounts.switch.quitHint')));
    expect(buttons(html)).toEqual([mittrT('mittr.accounts.switch.retry')]);
  });

  test('a failed request offers Retry and Close', () => {
    const html = status('failed');
    expect(html).toContain(escaped(mittrT('mittr.accounts.switch.failed')));
    expect(html).not.toContain(escaped(mittrT('mittr.accounts.switch.quitHint')));
    expect(buttons(html)).toEqual([mittrT('mittr.accounts.switch.retry'), mittrT('mittr.accounts.switch.close')]);
  });
});
