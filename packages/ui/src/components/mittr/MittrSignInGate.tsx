import React from 'react';
import { Button } from '@/components/ui/button';
import { MittrCraftLogo } from '@/components/ui/MittrCraftLogo';
import { useI18n } from '@/lib/i18n';
import { AuditNotice } from './AuditNotice';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  gateStateFromStatus,
  parseAuthorizeUrl,
  parseSignInStatus,
  SIGN_IN_COMPLETED_EVENT,
  SIGN_IN_START_ENDPOINT,
  SIGN_IN_STATUS_ENDPOINT,
  type MittrSignInStatus,
} from './mittrSignInGateState';

/**
 * Nothing in the application works without a Mittr session — the engine's every
 * model call is authorised by it — so this stands in front rather than letting a
 * developer in to meet a wall of 401s.
 */
export function MittrSignInGate({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<MittrSignInStatus | null>(null);
  const [failed, setFailed] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const response = await runtimeFetch(SIGN_IN_STATUS_ENDPOINT);
      setStatus(parseSignInStatus(await response.json()));
    } catch {
      // Unreachable is not signed in. Showing the sign-in surface is something
      // the developer can act on; pretending the session is good is not.
      setStatus({ signedIn: false, displayName: '' });
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    // Focus is a hint, not the event. The desktop shell focuses this window to
    // deliver the callback deep link, which happens before the code has been
    // exchanged -- so a check driven by focus alone reads the session that has
    // not been stored yet and leaves the developer looking at a sign-in screen
    // that already succeeded.
    window.addEventListener('focus', refresh);
    // The shell announces the exchange once a session exists. Web surfaces
    // never emit it and keep the focus behaviour, which is all they have.
    window.addEventListener(SIGN_IN_COMPLETED_EVENT, refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(SIGN_IN_COMPLETED_EVENT, refresh);
    };
  }, [refresh]);

  const startSignIn = React.useCallback(async () => {
    setFailed(false);
    try {
      const response = await runtimeFetch(SIGN_IN_START_ENDPOINT, { method: 'POST' });
      const authorizeUrl = parseAuthorizeUrl(await response.json());
      if (!authorizeUrl) {
        setFailed(true);
        return;
      }
      // The desktop shell turns this into the system browser; a web tab opens
      // normally. Either way the server never launches a browser itself.
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch {
      setFailed(true);
    }
  }, []);

  const state = gateStateFromStatus(status);
  if (state === 'signed-in') return <>{children}</>;

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-background p-8">
      {/*
        Two washes of the brand ramp behind the card, blurred past recognition.
        They are what keeps the page from reading as a flat plane: the card can
        only look lifted if there is something behind it to lift away from.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 size-[38rem] -translate-x-1/2 rounded-full bg-[image:var(--grad-brand)] opacity-[0.07] blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 left-1/2 size-[30rem] -translate-x-1/2 rounded-full bg-[image:var(--grad-accent)] opacity-[0.05] blur-3xl"
      />

      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-[var(--elev-3)]">
        {/* The light falls from above: a sheen down the first stretch of the
            card, and a hairline where it catches the top edge. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[image:var(--grad-sheen)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[image:var(--grad-accent)] opacity-40"
        />

        <div className="relative flex flex-col items-start gap-5 p-8">
          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute inset-0 rounded-xl bg-[image:var(--grad-accent)] opacity-30 blur-lg"
            />
            <div className="relative flex size-14 items-center justify-center rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-background)] shadow-[var(--elev-2)]">
              <MittrCraftLogo className="size-8" />
            </div>
          </div>

          {state === 'checking' ? (
            <p className="typography-meta text-muted-foreground">{t('mittr.signIn.checking')}</p>
          ) : (
            <>
              <div className="flex flex-col gap-2 text-left">
                <h1 className="typography-settings-page-title font-semibold text-foreground">
                  {t('mittr.signIn.title')}
                </h1>
                <p className="typography-meta text-muted-foreground">{t('mittr.signIn.description')}</p>
              </div>

              <Button
                size="lg"
                onClick={() => { void startSignIn(); }}
                className="w-full shadow-[0_0_20px_-6px_var(--primary-muted)]"
              >
                {t('mittr.signIn.action')}
              </Button>

              {failed ? (
                <p className="typography-meta text-[var(--status-error)]">{t('mittr.signIn.error')}</p>
              ) : null}

              {/* Before first use, not buried in a settings page somebody may
                  never open. What is recorded is part of the deal being
                  accepted here. */}
              <AuditNotice className="text-left" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
