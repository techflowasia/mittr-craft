import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Button } from '../../../ui/src/components/ui/button';
import { Checkbox } from '../../../ui/src/components/ui/checkbox';
import { Input } from '../../../ui/src/components/ui/input';
import type { SessionAuthMethodsProps } from '../../../ui/src/lib/product-plugins';
import { getRuntimeUrlResolver } from '../../../ui/src/lib/runtime-url';
import { useMittrT } from '../strings/mittrT';
import { entraLoginUrl, readStoredTrustDevice, signInWithDirectory, storeTrustDevice, type AdSessionResult } from './adApi';
import { defaultAdFetch, fetchAdStatus, type AdStatus } from './adStatus';

function TrustDevice({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }): React.ReactNode {
  const t = useMittrT();
  return (
    <label className="flex items-center justify-center gap-2 pt-1 text-center typography-micro text-muted-foreground">
      <Checkbox
        checked={checked}
        onChange={onChange}
        ariaLabel={t('mittr.uiAuth.trustDevice')}
        className="size-4"
        iconClassName="size-4"
      />
      <span>{t('mittr.uiAuth.trustDevice')}</span>
    </label>
  );
}

function Divider(): React.ReactNode {
  const t = useMittrT();
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-background px-2 text-muted-foreground">{t('mittr.uiAuth.or')}</span>
      </div>
    </div>
  );
}

function MicrosoftInBrowser(): React.ReactNode {
  const t = useMittrT();
  return <p className="text-center typography-meta text-muted-foreground">{t('mittr.uiAuth.microsoftInBrowser')}</p>;
}

function MicrosoftButton({ trustDevice }: { trustDevice: () => boolean }): React.ReactNode {
  const t = useMittrT();
  const go = () => {
    window.location.assign(entraLoginUrl(getRuntimeUrlResolver().auth, window.location, trustDevice()));
  };
  return (
    <Button type="button" variant="outline" className="w-full" onClick={go}>
      <Icon name="user" className="h-4 w-4" />
      <span>{t('mittr.uiAuth.microsoft')}</span>
    </Button>
  );
}

const FAILURE_KEY = {
  invalid: 'mittr.uiAuth.invalid',
  'rate-limited': 'mittr.uiAuth.rateLimited',
  failed: 'mittr.uiAuth.failed',
} as const;

function LdapForm({ trustDevice, runtime, onSignedIn }: { trustDevice: () => boolean } & Pick<SessionAuthMethodsProps, 'runtime' | 'onSignedIn'>): React.ReactNode {
  const t = useMittrT();
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<AdSessionResult | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username || !password || busy) return;
    const attempt = { username, password };
    setPassword('');
    setBusy(true);
    setFailure(null);
    const result = await signInWithDirectory({ fetch: defaultAdFetch, ...attempt, trustDevice: trustDevice(), runtime, onSignedIn });
    setBusy(false);
    if (result.ok) {
      setUsername('');
      return;
    }
    setFailure(result);
  };

  return (
    <form onSubmit={(event) => { void submit(event); }} className="w-full space-y-2">
      <div className="relative">
        <Icon name="user" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
        <Input
          type="text"
          name="username"
          autoComplete="username"
          placeholder={t('mittr.uiAuth.username')}
          aria-label={t('mittr.uiAuth.username')}
          value={username}
          onChange={(event) => { setUsername(event.target.value); setFailure(null); }}
          className="pl-10"
          disabled={busy}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon name="lock" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            placeholder={t('mittr.uiAuth.password')}
            aria-label={t('mittr.uiAuth.password')}
            value={password}
            onChange={(event) => { setPassword(event.target.value); setFailure(null); }}
            className="pl-10"
            aria-invalid={failure ? true : undefined}
            disabled={busy}
          />
        </div>
        <Button
          type="submit"
          size="icon"
          disabled={!username || !password || busy}
          aria-label={busy ? t('mittr.uiAuth.signingIn') : t('mittr.uiAuth.signIn')}
        >
          {busy ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : <Icon name="key" className="h-4 w-4" />}
        </Button>
      </div>
      {failure && !failure.ok ? (
        <p className="typography-meta text-destructive">{t(FAILURE_KEY[failure.reason])}</p>
      ) : null}
    </form>
  );
}

function AdMethods({ status, runtime, onSignedIn }: { status: AdStatus } & Pick<SessionAuthMethodsProps, 'runtime' | 'onSignedIn'>): React.ReactNode {
  const ownsTrustDevice = !status.passwordEnabled;
  const [trustDevice, setTrustDevice] = React.useState(readStoredTrustDevice);
  const changeTrustDevice = (next: boolean) => {
    setTrustDevice(next);
    storeTrustDevice(next);
  };
  const currentTrustDevice = ownsTrustDevice ? () => trustDevice : readStoredTrustDevice;
  const inBrowserOnly = status.mode === 'entra' && runtime === 'desktop-remote';
  return (
    <div className="w-full space-y-2">
      {status.passwordEnabled ? <Divider /> : null}
      {inBrowserOnly ? <MicrosoftInBrowser /> : null}
      {!inBrowserOnly && status.mode === 'entra' ? <MicrosoftButton trustDevice={currentTrustDevice} /> : null}
      {status.mode === 'ldap' ? <LdapForm trustDevice={currentTrustDevice} runtime={runtime} onSignedIn={onSignedIn} /> : null}
      {ownsTrustDevice && !inBrowserOnly ? <TrustDevice checked={trustDevice} onChange={changeTrustDevice} /> : null}
    </div>
  );
}

export type AdSignInViewProps = SessionAuthMethodsProps & {
  status: AdStatus | null;
};

export function AdSignInView({ status, runtime, isTunnelLocked, onSignedIn }: AdSignInViewProps): React.ReactNode {
  if (runtime === 'desktop-local' || isTunnelLocked || !status || !status.enabled || status.tunnelLocked) return null;
  return <AdMethods status={status} runtime={runtime} onSignedIn={onSignedIn} />;
}

export function AdSignIn({ isTunnelLocked, runtime, onSignedIn }: SessionAuthMethodsProps): React.ReactNode {
  const [status, setStatus] = React.useState<AdStatus | null>(null);
  const skipped = runtime === 'desktop-local' || isTunnelLocked;

  React.useEffect(() => {
    if (skipped) return;
    let current = true;
    void fetchAdStatus().then((next) => {
      if (current) setStatus(next);
    });
    return () => { current = false; };
  }, [skipped]);

  return <AdSignInView status={status} runtime={runtime} isTunnelLocked={isTunnelLocked} onSignedIn={onSignedIn} />;
}
