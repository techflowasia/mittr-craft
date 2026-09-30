import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { QUOTA_PROVIDERS, resolveUsageTone } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { MITTR_PROVIDER_ID, useQuotaMeStore } from '@/lib/mittr-quota/quota-me-store';
import { mittrUsageTone, isMittrUsageOffered } from './mittrUsage';

interface UsageSidebarProps {
  onItemSelect?: () => void;
}

const getUsagePercent = (usage: { windows?: Record<string, { usedPercent: number | null }> } | null | undefined) => {
  const windows = usage?.windows ?? {};
  const values = Object.values(windows)
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === 'number');
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
};

const NOT_SET_STYLE: React.CSSProperties = { backgroundColor: 'var(--surface-muted-foreground)', opacity: 0.4 };

const toneStyle = (tone: 'safe' | 'warn' | 'critical' | null): React.CSSProperties => {
  if (tone === null) return NOT_SET_STYLE;
  if (tone === 'critical') return { backgroundColor: 'var(--status-error)' };
  if (tone === 'warn') return { backgroundColor: 'var(--status-warning)' };
  return { backgroundColor: 'var(--status-success)' };
};

const UsageProviderRow: React.FC<{
  providerId: string;
  name: string;
  selected: boolean;
  statusStyle: React.CSSProperties;
  notSetLabel?: string;
  onSelect: () => void;
}> = ({ providerId, name, selected, statusStyle, notSetLabel, onSelect }) => (
  <div
    className={cn(
      'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
      selected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
    )}
  >
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'page' : undefined}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={statusStyle} />
      <ProviderLogo providerId={providerId} className="h-4 w-4 flex-shrink-0" />
      <span className="typography-ui-label font-normal truncate flex-1 min-w-0 text-foreground">
        {name}
      </span>
      {notSetLabel ? (
        <span className="typography-micro text-muted-foreground flex-shrink-0">{notSetLabel}</span>
      ) : null}
    </button>
  </div>
);

export const UsageSidebar: React.FC<UsageSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const results = useQuotaStore((state) => state.results);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const usageDisplayMode = useQuotaStore((state) => state.displayMode);
  const setUsageDisplayMode = useQuotaStore((state) => state.setDisplayMode);
  const loadUsageSettings = useQuotaStore((state) => state.loadSettings);
  const mittrState = useQuotaMeStore((state) => state.state);
  const loadMittrQuota = useQuotaMeStore((state) => state.load);
  const mittrOffered = isMittrUsageOffered(mittrState);

  React.useEffect(() => {
    void loadUsageSettings();
  }, [loadUsageSettings]);

  React.useEffect(() => {
    void loadMittrQuota();
  }, [loadMittrQuota]);

  const persistUsageSettings = React.useCallback(async (changes: { usageDisplayMode?: 'usage' | 'remaining'; usageDropdownProviders?: string[] }) => {
    try {
      await updateDesktopSettings(changes);
    } catch (error) {
      console.warn('Failed to save usage settings:', error);
    }
  }, []);

  const handleUsageDisplayModeChange = React.useCallback((value: string) => {
    if (value !== 'usage' && value !== 'remaining') {
      return;
    }
    setUsageDisplayMode(value);
    void persistUsageSettings({ usageDisplayMode: value });
  }, [persistUsageSettings, setUsageDisplayMode]);

  const bgClass = 'bg-background';

  return (
    <div className={cn('flex h-full flex-col', bgClass)}>
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{t('settings.usage.sidebar.title')}</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.usage.sidebar.total', { count: QUOTA_PROVIDERS.length + (mittrOffered ? 1 : 0) })}</span>
          <div className="flex items-center gap-2">
            <Button size="sm"
              variant="ghost"
              className="h-7 w-7 px-0 text-muted-foreground"
              onClick={() => {
                void fetchAllQuotas();
                if (mittrOffered) void loadMittrQuota({ force: true });
              }}
              aria-label={t('settings.usage.sidebar.actions.refreshAria')}
              title={t('settings.usage.sidebar.actions.refreshTitle')}
              disabled={isLoading}
            >
              <Icon name="refresh" className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="typography-micro text-muted-foreground">{t('settings.usage.sidebar.field.display')}</span>
          <Select value={usageDisplayMode} onValueChange={handleUsageDisplayModeChange}>
            <SelectTrigger className="w-fit">
              <SelectValue placeholder={t('settings.usage.sidebar.field.displayModePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="usage">{t('settings.usage.sidebar.field.displayModeUsage')}</SelectItem>
              <SelectItem value="remaining">{t('settings.usage.sidebar.field.displayModeRemaining')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {mittrOffered ? (
          <UsageProviderRow
            providerId={MITTR_PROVIDER_ID}
            name="Mittr"
            selected={selectedProviderId === MITTR_PROVIDER_ID}
            statusStyle={toneStyle(mittrState.status === 'ok' ? mittrUsageTone(mittrState.quota.lines) : null)}
            onSelect={() => {
              setSelectedProvider(MITTR_PROVIDER_ID);
              onItemSelect?.();
            }}
          />
        ) : null}
        {QUOTA_PROVIDERS.map((provider) => {
          const result = results.find((entry) => entry.providerId === provider.id);
          const configured = result?.configured ?? false;
          return (
            <UsageProviderRow
              key={provider.id}
              providerId={provider.id}
              name={provider.name}
              selected={provider.id === selectedProviderId}
              statusStyle={configured ? toneStyle(resolveUsageTone(getUsagePercent(result?.usage))) : NOT_SET_STYLE}
              notSetLabel={configured ? undefined : t('settings.usage.sidebar.status.notSet')}
              onSelect={() => {
                setSelectedProvider(provider.id);
                onItemSelect?.();
              }}
            />
          );
        })}
      </ScrollableOverlay>
    </div>
  );
};
