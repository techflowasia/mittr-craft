import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../ui/src/lib/i18n';
import { mittrT } from '../strings/mittrT';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { MittrSignInGateBody, MittrSignInGateView, SignInGateFailed, type MittrSignInGateViewProps } from './MittrSignInGate';
import type { GateSnapshot } from './signInGateState';

const APP = <main data-testid="app">the app</main>;
const noop = () => {};

const view = (props: Partial<MittrSignInGateViewProps> & Pick<MittrSignInGateViewProps, 'state'>) => renderToStaticMarkup(
  <I18nProvider>
    <MittrSignInGateView onSignIn={noop} onRepair={noop} onCheckAgain={noop} {...props}>
      {APP}
    </MittrSignInGateView>
  </I18nProvider>,
);

const escaped = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(([, label]) => label.replace(/<[^>]+>/g, ''));

describe('MittrSignInGateView', () => {
  test('gate view shows the sign-in screen when signed out', () => {
    const html = view({ state: 'signed-out' });
    expect(buttons(html)).toEqual([mittrT('mittr.signIn.action')]);
    expect(html).toContain(escaped(mittrT('mittr.audit.notice')));
    expect(html).toContain('role="note"');
    expect(html).not.toContain('the app');
  });

  test('gate view shows the app when signed in', () => {
    const html = view({ state: 'signed-in' });
    expect(html).toBe('<main data-testid="app">the app</main>');
  });

  test('while checking there is nothing to press and no app', () => {
    const html = view({ state: 'checking' });
    expect(html).toContain(escaped(mittrT('mittr.signIn.checking')));
    expect(buttons(html)).toEqual([]);
    expect(html).not.toContain('the app');
  });

  test('a damaged account list offers Repair and no sign-in that would be refused', () => {
    const html = view({ state: 'signed-out', notice: 'accounts-damaged' });
    expect(html).toContain(escaped(mittrT('mittr.signIn.accountsDamaged')));
    expect(buttons(html)).toEqual([mittrT('mittr.signIn.repair')]);
  });

  test('a repair that failed says so and offers Repair again', () => {
    const html = view({ state: 'signed-out', notice: 'repair-failed' });
    expect(html).toContain(escaped(mittrT('mittr.signIn.repairFailed')));
    expect(buttons(html)).toEqual([mittrT('mittr.signIn.repair')]);
  });

  test('without a keychain the refusal is said plainly, with no button that could not work', () => {
    const html = view({ state: 'signed-out', notice: 'no-keychain' });
    expect(html).toContain(escaped(mittrT('mittr.signIn.noKeychain')));
    expect(buttons(html)).toEqual([]);
  });

  test('a sign-in that did not finish in the browser can be tried again', () => {
    const failed = view({ state: 'signed-out', notice: 'sign-in-failed' });
    expect(failed).toContain(escaped(mittrT('mittr.signIn.failed')));
    expect(buttons(failed)).toEqual([mittrT('mittr.signIn.action')]);

    const unreachable = view({ state: 'signed-out', notice: 'sign-in-unreachable' });
    expect(unreachable).toContain(escaped(mittrT('mittr.signIn.unreachable')));
    expect(buttons(unreachable)).toEqual([mittrT('mittr.signIn.action')]);
  });

  test('a start that failed and a browser trip under way keep the sign-in button', () => {
    const failed = view({ state: 'signed-out', notice: 'start-failed' });
    expect(failed).toContain(escaped(mittrT('mittr.signIn.error')));
    expect(buttons(failed)).toEqual([mittrT('mittr.signIn.action')]);

    const waiting = view({ state: 'signed-out', notice: 'waiting' });
    expect(waiting).toContain(escaped(mittrT('mittr.signIn.waiting')));
    expect(buttons(waiting)).toEqual([mittrT('mittr.signIn.action')]);
  });

  test('a status nobody could read offers to check again, not to sign in', () => {
    const html = view({ state: 'checking', notice: 'check-failed' });
    expect(html).toContain(escaped(mittrT('mittr.signIn.checkFailed')));
    expect(buttons(html)).toEqual([mittrT('mittr.signIn.checkAgain')]);
  });

  test('a button is disabled while its request is out', () => {
    expect(/<button[^>]*disabled=""/.test(view({ state: 'signed-out', busy: true }))).toBe(true);
    expect(/<button[^>]*disabled=""/.test(view({ state: 'signed-out' }))).toBe(false);
  });
});

describe('MittrErrorBoundary', () => {
  test('a failure shows the fallback, and only then', () => {
    expect(MittrErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new MittrErrorBoundary({ fallback: <p>fallback</p>, children: <p>ours</p> });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>ours</p>');
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toBe('<p>fallback</p>');
  });
});

describe('the gate fails closed', () => {
  const IDLE_SNAPSHOT: GateSnapshot = { status: null, checkFailed: false, actionFailed: null, waiting: false, busy: false };
  const SIGNED_OUT: GateSnapshot = { ...IDLE_SNAPSHOT, status: { signedIn: false } };

  const expectReloadOnly = (html: string) => {
    expect(html).toContain(escaped(mittrT('mittr.signIn.crashed')));
    expect(buttons(html)).toEqual([mittrT('mittr.signIn.reload')]);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('the app');
  };

  test('the failure screen offers Reload and never the app, with no i18n context to lean on', () => {
    expectReloadOnly(renderToStaticMarkup(<SignInGateFailed />));
  });

  test('a gate that could not start shows the failure screen, not the app', () => {
    expectReloadOnly(renderToStaticMarkup(
      <MittrSignInGateBody controller={null} snapshot={SIGNED_OUT} broken>{APP}</MittrSignInGateBody>,
    ));
  });

  test('when the sign-in screen throws, the boundary falls back to the failure screen, not the app', () => {
    const element = MittrSignInGateBody({ controller: null, snapshot: SIGNED_OUT, broken: false, children: APP });
    expect(React.isValidElement(element)).toBe(true);
    if (!React.isValidElement<{ fallback: React.ReactNode; children: React.ReactNode }>(element)) return;
    expect(element.type).toBe(MittrErrorBoundary);
    const boundary = new MittrErrorBoundary(element.props);
    boundary.state = { failed: true };
    expectReloadOnly(renderToStaticMarkup(<>{boundary.render()}</>));
  });

  test('a signed-in status opens the app', () => {
    const html = renderToStaticMarkup(
      <MittrSignInGateBody controller={null} snapshot={{ ...IDLE_SNAPSHOT, status: { signedIn: true, userId: 'u1' } }} broken={false}>
        {APP}
      </MittrSignInGateBody>,
    );
    expect(html).toBe('<main data-testid="app">the app</main>');
  });
});
