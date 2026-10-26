export const MITTR_PROVIDER_ID = 'mittr';

/**
 * The engine's `provider.use` rules. Locked (the default), every provider is
 * denied and only `providerId` is allowed back; the engine lets the later rule
 * of one list win. With other providers shown, every provider is allowed,
 * the hosted `opencode` one included, as in 1.22.
 */
export const policiesFor = ({ showOtherProviders, providerId }) =>
  showOtherProviders === true
    ? [{ action: 'provider.use', resource: '*', effect: 'allow' }]
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
