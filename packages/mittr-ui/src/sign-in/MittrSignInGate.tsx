import React from 'react';

import { Button } from '../../../ui/src/components/ui/button';
import { runtimeFetch } from '../../../ui/src/lib/runtime-fetch';
import { openExternalUrl } from '../../../ui/src/lib/url';
import { MittrCraftLogo } from '../MittrCraftLogo';
import { MittrErrorBoundary } from '../MittrErrorBoundary';
import { mittrT, useMittrT } from '../strings/mittrT';
import type { MittrKey } from '../strings/mittrT';
import { gateHeld, listenAccountChanged, onGateRelease } from './accountChange';
import { AuditNotice } from './AuditNotice';
import { createSignInGateController, desktopBridge, type SignInGateController } from './signInGateController';
import { gateNotice, gateStateFromStatus, type GateNotice, type GateSnapshot, type GateState } from './signInGateState';

type GateButton = 'sign-in' | 'repair' | 'check-again' | null;

type GateButtonAction = { onClick: (() => void) | undefined; label: MittrKey };

type NoticeTone = 'error' | 'warning' | 'quiet';

type NoticeText = { key: MittrKey; tone: NoticeTone };

const NOTICE_TEXT = {
  'no-keychain': { key: 'mittr.signIn.noKeychain', tone: 'error' },
  'accounts-damaged': { key: 'mittr.signIn.accountsDamaged', tone: 'warning' },
  'repair-failed': { key: 'mittr.signIn.repairFailed', tone: 'error' },
  'check-failed': { key: 'mittr.signIn.checkFailed', tone: 'error' },
  'start-failed': { key: 'mittr.signIn.error', tone: 'error' },
  waiting: { key: 'mittr.signIn.waiting', tone: 'quiet' },
  'sign-in-failed': { key: 'mittr.signIn.failed', tone: 'error' },
  'sign-in-unreachable': { key: 'mittr.signIn.unreachable', tone: 'error' },
} satisfies Record<GateNotice, NoticeText>;

const TONE_CLASS = {
  error: 'rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 text-[var(--status-error-text)]',
  warning: 'rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 text-foreground',
  quiet: 'text-muted-foreground',
} satisfies Record<NoticeTone, string>;

// Only a button that can do something: without a keychain nothing here can
// help, and while a damaged list stands a sign-in would be refused.
const buttonFor = (state: GateState, notice: GateNotice | null): GateButton => {
  if (notice === 'check-failed') return 'check-again';
  if (notice === 'no-keychain') return null;
  if (notice === 'accounts-damaged' || notice === 'repair-failed') return 'repair';
  return state === 'signed-out' ? 'sign-in' : null;
};

const TITLEBAR_DRAG_STYLE: React.CSSProperties = {
  height: 'var(--oc-wco-titlebar-height, 0px)',
  right: 'var(--oc-wco-right-inset, 0px)',
};

export type MittrSignInGateViewProps = {
  state: GateState;
  notice?: GateNotice | null;
  busy?: boolean;
  onSignIn: () => void;
  onRepair?: () => void;
  onCheckAgain?: () => void;
  children: React.ReactNode;
};

export function MittrSignInGateView({
  state,
  notice = null,
  busy = false,
  onSignIn,
  onRepair,
  onCheckAgain,
  children,
}: MittrSignInGateViewProps): React.ReactNode {
  const t = useMittrT();
  if (state === 'signed-in') return <>{children}</>;

  const button = buttonFor(state, notice);
  const handlers = {
    'sign-in': { onClick: onSignIn, label: 'mittr.signIn.action' },
    repair: { onClick: onRepair, label: 'mittr.signIn.repair' },
    'check-again': { onClick: onCheckAgain, label: 'mittr.signIn.checkAgain' },
  } satisfies Record<Exclude<GateButton, null>, GateButtonAction>;
  const action = button ? handlers[button] : null;
  const text = notice ? NOTICE_TEXT[notice] : null;
  const checking = state === 'checking' && notice !== 'check-failed';

  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center overflow-hidden bg-background text-foreground">
      <div className="app-region-drag fixed left-0 top-0 z-20" style={TITLEBAR_DRAG_STYLE} aria-hidden />
      <div className="app-region-no-drag relative z-10 flex w-full justify-center px-4 py-12 sm:px-6">
        <div className="flex w-full max-w-xs flex-col items-center gap-6 text-center">
          <MittrCraftLogo width={56} height={56} />
          {checking ? (
            <p role="status" className="typography-meta text-muted-foreground">{t('mittr.signIn.checking')}</p>
          ) : (
            <>
              <div className="flex flex-col items-center gap-1">
                <h1 className="text-xl font-semibold text-foreground">{t('mittr.signIn.title')}</h1>
                <p className="typography-meta text-muted-foreground">{t('mittr.signIn.description')}</p>
              </div>
              {text ? (
                <p
                  role={text.tone === 'quiet' ? 'status' : 'alert'}
                  className={`w-full typography-meta ${TONE_CLASS[text.tone]}`}
                >
                  {t(text.key)}
                </p>
              ) : null}
              {action?.onClick ? (
                <Button size="lg" className="w-full" disabled={busy} onClick={action.onClick}>
                  {t(action.label)}
                </Button>
              ) : null}
              <AuditNotice />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shown when the sign-in screen itself cannot be shown. It stays closed: the
 * app never opens without a sign-in. It calls no hook that could fail again
 * (no logo, no i18n context), so it renders wherever the gate did.
 */
export function SignInGateFailed(): React.ReactNode {
  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center bg-background text-foreground">
      <div className="app-region-drag fixed left-0 top-0 z-20" style={TITLEBAR_DRAG_STYLE} aria-hidden />
      <div className="app-region-no-drag relative z-10 flex w-full max-w-xs flex-col items-center gap-6 px-4 py-12 text-center">
        <p role="alert" className="typography-meta text-foreground">{mittrT('mittr.signIn.crashed')}</p>
        <Button size="lg" className="w-full" onClick={() => window.location.reload()}>
          {mittrT('mittr.signIn.reload')}
        </Button>
      </div>
    </div>
  );
}

const IDLE: GateSnapshot = { status: null, checkFailed: false, actionFailed: null, waiting: false, busy: false };

const watchFocus = (handler: () => void) => {
  window.addEventListener('focus', handler);
  return () => window.removeEventListener('focus', handler);
};

const createGateController = (): SignInGateController => createSignInGateController({
  fetch: (path, init) => runtimeFetch(path, init),
  listen: desktopBridge()?.listen,
  onFocus: watchFocus,
  openUrl: openExternalUrl,
  held: gateHeld,
  onRelease: onGateRelease,
});

type SignInGateBinding = { controller: SignInGateController | null; snapshot: GateSnapshot; broken: boolean };

const useSignInGate = (): SignInGateBinding => {
  const [controller, setController] = React.useState<SignInGateController | null>(null);
  const [broken, setBroken] = React.useState(false);

  React.useEffect(() => {
    let created: SignInGateController;
    try {
      created = createGateController();
    } catch (error) {
      console.error('[mittr] the sign-in gate could not start:', error);
      setBroken(true);
      return undefined;
    }
    setController(created);
    return () => created.dispose();
  }, []);

  React.useEffect(() => listenAccountChanged(() => window.location.reload()), []);

  const subscribe = React.useCallback(
    (listener: () => void) => (controller ? controller.subscribe(listener) : () => {}),
    [controller],
  );
  const read = React.useCallback(() => (controller ? controller.snapshot() : IDLE), [controller]);
  const snapshot = React.useSyncExternalStore(subscribe, read, read);
  return { controller, snapshot, broken };
};

type MittrSignInGateBodyProps = SignInGateBinding & { children: React.ReactNode };

export function MittrSignInGateBody({ controller, snapshot, broken, children }: MittrSignInGateBodyProps): React.ReactNode {
  if (broken) return <SignInGateFailed />;
  const state = gateStateFromStatus(snapshot.status);
  if (state === 'signed-in') return <>{children}</>;

  return (
    <MittrErrorBoundary fallback={<SignInGateFailed />}>
      <MittrSignInGateView
        state={state}
        notice={gateNotice(snapshot)}
        busy={snapshot.busy || !controller}
        onSignIn={() => { void controller?.signIn(); }}
        onRepair={() => { void controller?.repair(); }}
        onCheckAgain={() => { void controller?.refresh(); }}
      >
        {children}
      </MittrSignInGateView>
    </MittrErrorBoundary>
  );
}

/**
 * Nothing in MittrCraft works without a Mittr session, so this stands in
 * front of the app on every surface instead of letting someone in to a wall
 * of refused model calls. It fails closed: if the gate cannot start, or its
 * screen throws, a Reload screen is shown and never the app. Only our screen
 * sits inside the error boundary, so errors in the app never pass through it.
 */
export function MittrSignInGate({ children }: { children: React.ReactNode }): React.ReactNode {
  const binding = useSignInGate();
  return <MittrSignInGateBody {...binding}>{children}</MittrSignInGateBody>;
}
