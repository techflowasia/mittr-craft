import React from 'react';
import { Button } from '@/components/ui/button';
import { MittrCraftLogo } from '@/components/ui/MittrCraftLogo';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  gateStateFromStatus,
  parseAuthorizeUrl,
  parseSignInStatus,
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
    // Sign-in finishes in the system browser and returns here by deep link, so
    // regaining focus is the moment a session may have appeared.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
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
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-background p-8 text-center">
      <MittrCraftLogo className="size-12" />
      {state === 'checking' ? (
        <p className="text-muted-foreground">{t('mittr.signIn.checking')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h1 className="text-lg font-medium text-foreground">{t('mittr.signIn.title')}</h1>
            <p className="text-muted-foreground">{t('mittr.signIn.description')}</p>
          </div>
          <Button onClick={() => { void startSignIn(); }}>{t('mittr.signIn.action')}</Button>
          {failed ? <p className="text-destructive">{t('mittr.signIn.error')}</p> : null}
        </>
      )}
    </div>
  );
}
