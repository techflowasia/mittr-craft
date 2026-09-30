import { isVSCodeRuntime } from '@/lib/desktop';
import { quotaShare, quotaTonePercent } from '@/lib/mittr-quota/format';
import type { QuotaUsageLine } from '@/lib/mittr-quota/quota-me';
import { MITTR_PROVIDER_ID, type MittrProviderId, type QuotaMeState } from '@/lib/mittr-quota/quota-me-store';
import { QUOTA_PROVIDERS, resolveUsageTone } from '@/lib/quota';
import type { ProviderResult, QuotaProviderId } from '@/types';

type UsageSelection = QuotaProviderId | MittrProviderId | null;

export function isMittrUsageOffered(state: QuotaMeState, vscode = isVSCodeRuntime()): boolean {
  return !vscode && state.status !== 'not_available';
}

export function mittrUsageTone(lines: readonly QuotaUsageLine[]): 'safe' | 'warn' | 'critical' {
  const share = lines.reduce((most, line) => Math.max(most, quotaShare(line)), 0);
  return resolveUsageTone(quotaTonePercent(share));
}

export function resolveUsageSelection(
  selection: UsageSelection,
  mittrOffered: boolean,
  results: readonly Pick<ProviderResult, 'providerId' | 'configured'>[],
): UsageSelection {
  if (selection && (selection !== MITTR_PROVIDER_ID || mittrOffered)) return selection;
  if (!selection && mittrOffered) return MITTR_PROVIDER_ID;
  if (!selection && results.length === 0) return null;
  return firstThirdPartyUsage(results);
}

export function firstThirdPartyUsage(
  results: readonly Pick<ProviderResult, 'providerId' | 'configured'>[],
): QuotaProviderId | null {
  return results.find((entry) => entry.configured)?.providerId ?? QUOTA_PROVIDERS[0]?.id ?? null;
}
