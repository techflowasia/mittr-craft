import React from 'react';

import { toast } from '../../../ui/src/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../ui/src/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/src/components/ui/tooltip';
import { isDesktopShell } from '../../../ui/src/lib/desktop';
import { FOOTER_BUTTON_CLASS } from '../accounts/footerButtonClass';
import { initialsOf } from '../accounts/accountsApi';
import { mittrT, useMittrT } from '../strings/mittrT';
import { loadAdProfile, signOutAd, type AdProfile } from './adApi';

export type SidebarProfileItemsProps = {
  profile: AdProfile;
  signingOut: boolean;
  onSignOut: () => void;
};

export function SidebarProfileItems({ profile, signingOut, onSignOut }: SidebarProfileItemsProps): React.ReactNode {
  const t = useMittrT();
  return (
    <>
      <DropdownMenuLabel className="text-foreground">{profile.displayName}</DropdownMenuLabel>
      {profile.title ? <DropdownMenuLabel className="py-0 font-normal">{profile.title}</DropdownMenuLabel> : null}
      {profile.department ? <DropdownMenuLabel className="py-0 font-normal">{profile.department}</DropdownMenuLabel> : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={signingOut} onClick={onSignOut}>{t('mittr.uiAuth.signOut')}</DropdownMenuItem>
    </>
  );
}

export type SidebarProfileViewProps = SidebarProfileItemsProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SidebarProfileView({ open, onOpenChange, ...items }: SidebarProfileViewProps): React.ReactNode {
  const t = useMittrT();
  const { profile } = items;
  const label = t('mittr.uiAuth.profile.label', { name: profile.displayName });
  return (
    <DropdownMenu open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button type="button" className={FOOTER_BUTTON_CLASS} aria-label={label}>
              <span className="flex size-6 items-center justify-center rounded-full border border-border typography-micro font-medium">{initialsOf(profile.displayName)}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}><p>{profile.displayName}</p></TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
        <SidebarProfileItems {...items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HostedProfile(): React.ReactNode {
  const [profile, setProfile] = React.useState<AdProfile | null>(null);
  const [open, setOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  React.useEffect(() => {
    let current = true;
    void loadAdProfile().then((loaded) => {
      if (current) setProfile(loaded);
    });
    return () => { current = false; };
  }, []);

  if (!profile) return null;

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    if (await signOutAd()) {
      window.location.reload();
      return;
    }
    setSigningOut(false);
    toast.error(mittrT('mittr.uiAuth.signOutFailed'));
  };

  return (
    <SidebarProfileView
      profile={profile}
      open={open}
      signingOut={signingOut}
      onOpenChange={setOpen}
      onSignOut={() => { void signOut(); }}
    />
  );
}

export function SidebarProfileHost({ isDesktop }: { isDesktop: boolean }): React.ReactNode {
  return isDesktop ? null : <HostedProfile />;
}

export function SidebarProfile(): React.ReactNode {
  return <SidebarProfileHost isDesktop={isDesktopShell()} />;
}
