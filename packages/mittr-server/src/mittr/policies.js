export const MITTR_PROVIDER_ID = 'mittr';

/**
 * The engine's `provider.use` rules. Locked (the default), every provider is
 * denied and only `providerId` is allowed back; the engine lets the later rule
 * of one list win. With other providers shown, the hosted `opencode` provider
 * stays denied (R52), so company prompts never reach a keyless third-party
 * service just because the switch is on.
 */
export const policiesFor = ({ showOtherProviders, providerId }) =>
  showOtherProviders === true
    ? [{ action: 'provider.use', resource: 'opencode', effect: 'deny' }]
    : [
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: providerId, effect: 'allow' },
      ];

/**
 * The managed-config share of the lock. Never empty: an empty fragment would
 * leave the engine open for as long as it stays that way.
 */
export const policiesFragment = ({ showOtherProviders }) => ({
  experimental: { policies: policiesFor({ showOtherProviders, providerId: MITTR_PROVIDER_ID }) },
});
