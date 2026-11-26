import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from '../../../ui/node_modules/happy-dom';

import type { MittrAccount } from './accountsApi';
import type { AccountSwitchDialogProps } from './AccountSwitchDialog';
import type { AccountSwitch } from './accountSwitch';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event,
  MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../../ui/src/lib/i18n');
const { mittrT } = await import('../strings/mittrT');
const { AccountSwitchDialog } = await import('./AccountSwitchDialog');
const { HttpError } = await import('./accountsApi');
const { createAccountSwitch } = await import('./accountSwitch');

afterAll(async () => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await browser.happyDOM.close();
});

const V1 = { code: 'MITTR_ENGINE_V1_HISTORY', message: 'Open MittrCraft 2.1.1 once.' };
const A: MittrAccount = { userId: 'u-a', displayName: 'Ann Lee', active: false };
const B: MittrAccount = { userId: 'u-b', displayName: 'Bo', active: true };

let root: Root;

beforeEach(() => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
});

type BoundProps = { accountSwitch: AccountSwitch; api: AccountSwitchDialogProps['api'] };

function Bound({ accountSwitch, api }: BoundProps): React.ReactNode {
  const state = React.useSyncExternalStore(accountSwitch.subscribe, accountSwitch.state, accountSwitch.state);
  const problem = React.useSyncExternalStore(accountSwitch.subscribe, accountSwitch.problem, accountSwitch.problem);
  return <AccountSwitchDialog accountSwitch={accountSwitch} state={state} problem={problem} api={api} />;
}

const mount = async () => {
  const log: string[] = [];
  const accountSwitch = createAccountSwitch({
    retrySwitch: async () => ({ signedIn: true }),
    reload: () => log.push('reload'),
    announce: () => log.push('announce'),
    holdGate: () => () => {},
  });
  const api: BoundProps['api'] = {
    fetchAccounts: async () => { log.push('list'); return [A, B]; },
    activateAccount: async (userId) => { log.push(`activate ${userId}`); return { signedIn: true, userId }; },
  };
  await act(async () => { root.render(<I18nProvider><Bound accountSwitch={accountSwitch} api={api} /></I18nProvider>); });
  return { accountSwitch, log };
};

const labels = () => [...document.querySelectorAll('button')].map((button) => button.textContent ?? '');

const press = (label: string) => act(async () => {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  button.click();
});

test('a refused switch is told why, and Close leaves the window as it was', async () => {
  const { accountSwitch, log } = await mount();
  await act(async () => { await accountSwitch.run(() => Promise.reject(new HttpError(409, { error: V1.message, code: V1.code }))); });
  expect(document.body.textContent).toContain(V1.message);
  expect(labels()).toEqual([mittrT('mittr.accounts.switch.close')]);

  await press(mittrT('mittr.accounts.switch.close'));
  expect(accountSwitch.state()).toBe('idle');
  expect(log).toEqual([]);
});

test('from an engine that refused to start, another signed-in account can be continued as', async () => {
  const { accountSwitch, log } = await mount();
  await act(async () => { await accountSwitch.run(async () => ({ signedIn: true, userId: 'u-b', engineRestarted: false, engineError: V1 })); });
  expect(document.body.textContent).toContain(V1.message);
  const back = mittrT('mittr.signIn.continueAs', { name: 'Ann Lee' });
  expect(labels()).toEqual([back, mittrT('mittr.accounts.switch.retry')]);

  await press(back);
  expect(log).toEqual(['list', 'activate u-a', 'announce', 'reload']);
});

test('an engine that failed for another reason lists no accounts', async () => {
  const { accountSwitch, log } = await mount();
  await act(async () => { await accountSwitch.run(async () => ({ signedIn: true, engineRestarted: false, engineError: { code: null, message: 'EPIPE' } })); });
  expect(labels()).toEqual([mittrT('mittr.accounts.switch.retry')]);
  expect(log).toEqual([]);
});
