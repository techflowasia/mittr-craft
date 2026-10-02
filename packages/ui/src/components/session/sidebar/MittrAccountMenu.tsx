import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SIGN_IN_COMPLETED_EVENT } from '@/components/mittr/mittrSignInGateState';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import {
  activateMittrAccount,
  fetchMittrAccounts,
  signOutActiveMittrAccount,
  startMittrAccountSignIn,
  type MittrAccount,
} from '@/lib/mittrAccountsApi';
import { getSidebarUserInitials } from './sidebarUserProfile';

const reloadInto = () => window.location.reload();

function AccountBadge({ name, size }: { name: string; size: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-interactive-selection font-semibold text-interactive-selection-foreground',
        size === 'sm' ? 'size-7 text-[11px]' : 'size-8 text-xs',
      )}
    >
      {getSidebarUserInitials(name)}
    </span>
  );
}

export function MittrAccountMenu(): React.ReactNode {
  const { t } = useI18n();
  const [accounts, setAccounts] = React.useState<MittrAccount[]>([]);
  const [busy, setBusy] = React.useState(false);
  const runningCount = useGlobalSessionStatusStore((state) => state.statusById.size);
  const activeRef = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    const next = await fetchMittrAccounts().catch(() => []);
    const active = next.find((account) => account.active)?.userId ?? null;
    if (activeRef.current && active && activeRef.current !== active) {
      reloadInto();
      return;
    }
    activeRef.current = active;
    setAccounts(next);
  }, []);

  React.useEffect(() => {
    void load();
    window.addEventListener(SIGN_IN_COMPLETED_EVENT, load);
    window.addEventListener('focus', load);
    return () => {
      window.removeEventListener(SIGN_IN_COMPLETED_EVENT, load);
      window.removeEventListener('focus', load);
    };
  }, [load]);

  const active = accounts.find((account) => account.active) ?? null;

  const switchTo = React.useCallback(async (account: MittrAccount) => {
    setBusy(true);
    const pending = toast.loading(t('sessions.sidebar.footer.mittrAccounts.switching', { name: account.displayName }));
    try {
      await activateMittrAccount(account.userId);
      reloadInto();
    } catch {
      toast.dismiss(pending);
      toast.error(t('sessions.sidebar.footer.mittrAccounts.switchFailed'));
      setBusy(false);
    }
  }, [t]);

  const requestSwitch = React.useCallback((account: MittrAccount) => {
    if (runningCount === 0) {
      void switchTo(account);
      return;
    }
    toast.warning(t('sessions.sidebar.footer.mittrAccounts.runningTitle'), {
      description: t('sessions.sidebar.footer.mittrAccounts.runningDescription', { count: runningCount }),
      duration: 10_000,
      action: {
        label: t('sessions.sidebar.footer.mittrAccounts.switchAnyway'),
        onClick: () => { void switchTo(account); },
      },
    });
  }, [runningCount, switchTo, t]);

  const addAccount = React.useCallback(async () => {
    if (!await startMittrAccountSignIn().catch(() => false)) {
      toast.error(t('sessions.sidebar.footer.mittrAccounts.addFailed'));
    }
  }, [t]);

  const signOut = React.useCallback(async () => {
    setBusy(true);
    try {
      await signOutActiveMittrAccount();
      reloadInto();
    } catch {
      toast.error(t('sessions.sidebar.footer.mittrAccounts.signOutFailed'));
      setBusy(false);
    }
  }, [t]);

  if (!active) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              className="size-8 rounded-full p-0"
              aria-label={t('sessions.sidebar.footer.mittrAccounts.trigger', { name: active.displayName })}
            >
              <AccountBadge name={active.displayName} size="sm" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <p>{t('sessions.sidebar.footer.mittrAccounts.trigger', { name: active.displayName })}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-72 p-2">
        <DropdownMenuLabel className="px-1 pb-1 typography-micro text-muted-foreground">
          {t('sessions.sidebar.footer.mittrAccounts.title')}
        </DropdownMenuLabel>
        {accounts.map((account) => (
          <DropdownMenuItem
            key={account.userId}
            disabled={busy}
            aria-current={account.active ? 'true' : undefined}
            onSelect={() => { if (!account.active) requestSwitch(account); }}
            className="flex min-h-10 items-center gap-3"
          >
            <AccountBadge name={account.displayName} size="md" />
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={account.displayName}>
              {account.displayName}
            </span>
            {account.active ? (
              <>
                <Icon name="check" className="size-4 shrink-0 text-[var(--status-success)]" aria-hidden="true" />
                <span className="sr-only">{t('sessions.sidebar.footer.mittrAccounts.current')}</span>
              </>
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={() => { void addAccount(); }} className="flex items-center gap-2">
          <Icon name="add" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t('sessions.sidebar.footer.mittrAccounts.add')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={() => { void signOut(); }} className="flex items-center gap-2">
          <span className="size-4 shrink-0" aria-hidden="true" />
          {t('sessions.sidebar.footer.mittrAccounts.signOut', { name: active.displayName })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
