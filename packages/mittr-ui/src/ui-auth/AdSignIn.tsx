import React from 'react';

import { Icon } from '../../../ui/src/components/icon/Icon';
import { Button } from '../../../ui/src/components/ui/button';
import { Checkbox } from '../../../ui/src/components/ui/checkbox';
import { Input } from '../../../ui/src/components/ui/input';
import type { SessionAuthMethodsProps } from '../../../ui/src/lib/product-plugins';
import { getRuntimeUrlResolver } from '../../../ui/src/lib/runtime-url';
import { useMittrT } from '../strings/mittrT';
import { entraLoginUrl, failureAfterWait, failureMessage, readStoredTrustDevice, signInWithDirectory, storeTrustDevice, type AdSessionResult } from './adApi';
import { defaultAdFetch, fetchAdStatus, type AdStatus } from './adStatus';

export function TrustDevice({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (next: boolean) => void }): React.ReactNode {
  const t = useMittrT();
  return (
    <label className="flex items-center justify-center gap-2 pt-1 text-center typography-micro text-muted-foreground">
      <Checkbox
        checked={checked}
        onChange={onChange}
        disabled={disabled}
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

const ERROR_ID = 'ad-sign-in-error';

type FailedSession = Extract<AdSessionResult, { ok: false }>;

export type LdapFormViewProps = {
  username: string;
  password: string;
  busy: boolean;
  blocked: boolean;
  failure: FailedSession | null;
  usernameRef: React.Ref<HTMLInputElement>;
  passwordRef: React.Ref<HTMLInputElement>;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
};

export function LdapFormView({ username, password, busy, blocked, failure, usernameRef, passwordRef, onUsername, onPassword, onSubmit }: LdapFormViewProps): React.ReactNode {
  const t = useMittrT();
  const described = failure ? ERROR_ID : undefined;
  return (
    <form onSubmit={onSubmit} className="w-full space-y-2">
      <div className="relative">
        <Icon name="user" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
        <Input
          ref={usernameRef}
          type="text"
          name="username"
          autoComplete="username"
          placeholder={t('mittr.uiAuth.username')}
          aria-label={t('mittr.uiAuth.username')}
          aria-describedby={described}
          value={username}
          onChange={(event) => { onUsername(event.target.value); }}
          className="pl-10"
          disabled={busy}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon name="lock" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
          <Input
            ref={passwordRef}
            type="password"
            name="password"
            autoComplete="current-password"
            placeholder={t('mittr.uiAuth.password')}
            aria-label={t('mittr.uiAuth.password')}
            aria-describedby={described}
            aria-invalid={failure ? true : undefined}
            value={password}
            onChange={(event) => { onPassword(event.target.value); }}
            className="pl-10"
            disabled={busy}
          />
        </div>
        <Button
          type="submit"
          size="icon"
          disabled={!username || !password || busy || blocked}
          aria-label={busy ? t('mittr.uiAuth.signingIn') : t('mittr.uiAuth.signIn')}
        >
          {busy ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : <Icon name="key" className="h-4 w-4" />}
        </Button>
      </div>
      {failure ? (
        <p id={ERROR_ID} role="alert" className="typography-meta text-destructive">{failureMessage(failure)}</p>
      ) : null}
    </form>
  );
}

type LdapFormProps = {
  trustDevice: () => boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  focusUsername: boolean;
} & Pick<SessionAuthMethodsProps, 'runtime' | 'onSignedIn'>;

function LdapForm({ trustDevice, busy, onBusyChange, focusUsername, runtime, onSignedIn }: LdapFormProps): React.ReactNode {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [failure, setFailure] = React.useState<FailedSession | null>(null);
  const [blockedUntil, setBlockedUntil] = React.useState(0);
  const usernameRef = React.useRef<HTMLInputElement | null>(null);
  const passwordRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (focusUsername) usernameRef.current?.focus();
  }, [focusUsername]);

  React.useEffect(() => {
    if (failure && !busy) passwordRef.current?.focus();
  }, [failure, busy]);

  React.useEffect(() => {
    const wait = blockedUntil - Date.now();
    if (wait <= 0) return;
    const timer = window.setTimeout(() => {
      setBlockedUntil(0);
      setFailure(failureAfterWait);
    }, wait);
    return () => { window.clearTimeout(timer); };
  }, [blockedUntil]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username || !password || busy || blockedUntil > Date.now()) return;
    const attempt = { username, password };
    setPassword('');
    onBusyChange(true);
    setFailure(null);
    const result = await signInWithDirectory({ fetch: defaultAdFetch, ...attempt, trustDevice: trustDevice(), runtime, onSignedIn });
    onBusyChange(false);
    if (result.ok) {
      setUsername('');
      return;
    }
    if (result.reason === 'rate-limited' && result.retryAfterSeconds !== undefined) {
      setBlockedUntil(Date.now() + result.retryAfterSeconds * 1000);
    }
    setFailure(result);
  };

  return (
    <LdapFormView
      username={username}
      password={password}
      busy={busy}
      blocked={blockedUntil > Date.now()}
      failure={failure}
      usernameRef={usernameRef}
      passwordRef={passwordRef}
      onUsername={(value) => { setUsername(value); setFailure(null); }}
      onPassword={(value) => { setPassword(value); setFailure(null); }}
      onSubmit={(event) => { void submit(event); }}
    />
  );
}

function AdMethods({ status, runtime, onSignedIn }: { status: AdStatus } & Pick<SessionAuthMethodsProps, 'runtime' | 'onSignedIn'>): React.ReactNode {
  const ownsTrustDevice = !status.passwordEnabled;
  const [trustDevice, setTrustDevice] = React.useState(readStoredTrustDevice);
  const [busy, setBusy] = React.useState(false);
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
      {status.mode === 'ldap' ? <LdapForm trustDevice={currentTrustDevice} busy={busy} onBusyChange={setBusy} focusUsername={ownsTrustDevice} runtime={runtime} onSignedIn={onSignedIn} /> : null}
      {ownsTrustDevice && !inBrowserOnly ? <TrustDevice checked={trustDevice} disabled={busy} onChange={changeTrustDevice} /> : null}
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
