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
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { requestSessionLogin } from '@/components/auth/sessionAuthGateState';
import {
  fetchSidebarUserProfile,
  getSidebarUserInitials,
  logoutSidebarUserProfile,
  type SidebarUserProfile,
} from './sidebarUserProfile';

type Props = {
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onOpenUpdate: () => void;
  showRuntimeButtons?: boolean;
  showUpdateButton?: boolean;
  requireProfileSession: boolean;
};

const footerButtonClassName = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

type ProfileState =
  | { status: 'loading' | 'unavailable' }
  | { status: 'ready'; profile: SidebarUserProfile };

const useSidebarUserProfile = (enabled: boolean, requireProfileSession: boolean): SidebarUserProfile | null => {
  const [state, setState] = React.useState<ProfileState>({ status: 'loading' });

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;
    let controller: AbortController | null = null;

    const loadProfile = () => {
      controller?.abort();
      controller = new AbortController();
      const requestController = controller;
      setState({ status: 'loading' });

      void fetchSidebarUserProfile(requestController.signal).then(
        (result) => {
          if (!disposed && !requestController.signal.aborted) {
            if (result.status === 'ready') {
              setState({ status: 'ready', profile: result.profile });
            } else {
              setState({ status: 'unavailable' });
              if (result.status === 'auth-required' && requireProfileSession) requestSessionLogin();
            }
          }
        },
        () => {
          if (!disposed && !requestController.signal.aborted) {
            setState({ status: 'unavailable' });
          }
        },
      );
    };

    loadProfile();
    const unsubscribe = subscribeRuntimeEndpointChanged(loadProfile);
    return () => {
      disposed = true;
      controller?.abort();
      unsubscribe();
    };
  }, [enabled, requireProfileSession]);

  return enabled && state.status === 'ready' ? state.profile : null;
};

export function SidebarFooter({
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  onOpenUpdate,
  showRuntimeButtons = true,
  showUpdateButton = true,
  requireProfileSession,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const [isLoggingOut, setIsLoggingOut] = React.useState(false);
  const logoutControllerRef = React.useRef<AbortController | null>(null);
  const profile = useSidebarUserProfile(showRuntimeButtons, requireProfileSession);
  const profileDetails = profile ? [
    { label: t('sessions.sidebar.footer.profile.details.username'), value: profile.username },
    { label: t('sessions.sidebar.footer.profile.details.displayName'), value: profile.displayName },
    { label: t('sessions.sidebar.footer.profile.details.email'), value: profile.email },
    { label: t('sessions.sidebar.footer.profile.details.department'), value: profile.department },
    { label: t('sessions.sidebar.footer.profile.details.jobTitle'), value: profile.title },
    { label: t('sessions.sidebar.footer.profile.details.groups'), value: profile.groups.length > 0 ? profile.groups.join(', ') : null },
  ].filter((detail): detail is { label: string; value: string } => Boolean(detail.value)) : [];

  React.useEffect(() => () => {
    const controller = logoutControllerRef.current;
    logoutControllerRef.current = null;
    controller?.abort();
  }, []);

  const handleLogout = React.useCallback(async () => {
    if (isLoggingOut) return;
    const controller = new AbortController();
    logoutControllerRef.current?.abort();
    logoutControllerRef.current = controller;
    setIsLoggingOut(true);
    try {
      if (!await logoutSidebarUserProfile(controller.signal)) {
        throw new Error('Session logout failed');
      }
      requestSessionLogin();
    } catch {
      if (!controller.signal.aborted) toast.error(t('sessions.sidebar.footer.profile.logoutError'));
    } finally {
      if (logoutControllerRef.current === controller) {
        logoutControllerRef.current = null;
        setIsLoggingOut(false);
      }
    }
  }, [isLoggingOut, t]);

  if (!showRuntimeButtons && !showUpdateButton) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center justify-start gap-1 px-2.5 py-2">
      {showRuntimeButtons ? (
        <>
          {profile ? (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-full p-0"
                      aria-label={t('sessions.sidebar.footer.profile.signedInAs', { name: profile.displayName })}
                    >
                      <span className="flex size-7 items-center justify-center rounded-full bg-interactive-selection text-[11px] font-semibold text-interactive-selection-foreground">
                        {getSidebarUserInitials(profile.displayName)}
                      </span>
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.profile.tooltip')}</p></TooltipContent>
              </Tooltip>
              <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-72 p-2">
                <div className="flex min-w-0 items-center gap-3 px-1 py-1.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-interactive-selection text-xs font-semibold text-interactive-selection-foreground">
                    {getSidebarUserInitials(profile.displayName)}
                  </span>
                  <div className="min-w-0 leading-tight">
                    <p className="truncate typography-ui-label font-medium text-foreground">{profile.displayName}</p>
                    {profile.secondaryLabel ? (
                      <p className="mt-0.5 truncate typography-micro text-muted-foreground">{profile.secondaryLabel}</p>
                    ) : null}
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="px-1 pt-1.5 typography-micro text-muted-foreground">
                  {t('sessions.sidebar.footer.profile.details.title')}
                </DropdownMenuLabel>
                <dl className="space-y-1 px-1 pb-1">
                  {profileDetails.map((detail) => (
                    <div key={detail.label} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 py-0.5">
                      <dt className="typography-micro text-muted-foreground">{detail.label}</dt>
                      <dd className="break-words text-right typography-micro text-foreground">{detail.value}</dd>
                    </div>
                  ))}
                </dl>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={isLoggingOut} onSelect={() => { void handleLogout(); }}>
                  {t('sessions.sidebar.footer.profile.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenSettings} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.settings')}>
                <Icon name="settings-3" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.settings')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenShortcuts} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.shortcuts')}>
                <Icon name="command" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.shortcuts')}</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={onOpenAbout} className={footerButtonClassName} aria-label={t('sessions.sidebar.footer.actions.aboutOpenChamber')}>
                <Icon name="information" className="h-4.5 w-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{t('sessions.sidebar.footer.actions.aboutOpenChamber')}</p></TooltipContent>
          </Tooltip>
        </>
      ) : null}
      {showUpdateButton ? (
        <Button
          type="button"
          variant="default"
          size="xs"
          className="ml-auto border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info)] hover:bg-[var(--status-info-background)]/80 hover:text-[var(--status-info)] dark:border-[var(--status-info-border)] dark:bg-[var(--status-info-background)] dark:hover:bg-[var(--status-info-background)]/80"
          onClick={onOpenUpdate}
        >
          {t('sessions.sidebar.footer.actions.update')}
        </Button>
      ) : null}
    </div>
  );
}
