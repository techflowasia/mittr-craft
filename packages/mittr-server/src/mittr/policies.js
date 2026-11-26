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
 * The managed-config share of the lock, as top-level `policies`: the engine
 * reads those after its deprecated `experimental.policies`, and the server
 * appends ours after its own, so the lock has the last word. Never empty: an
 * empty fragment would leave the engine open for as long as it stays that way.
 */
export const policiesFragment = ({ showOtherProviders }) => ({
  policies: policiesFor({ showOtherProviders, providerId: MITTR_PROVIDER_ID }),
});

const [DENY_ALL, ALLOW_MITTR] = policiesFor({ showOtherProviders: false, providerId: MITTR_PROVIDER_ID });
const [ALLOW_ALL] = policiesFor({ showOtherProviders: true, providerId: MITTR_PROVIDER_ID });

const isRule = (statement, rule) => statement !== null
  && typeof statement === 'object'
  && Object.keys(statement).length === 3
  && statement.action === rule.action && statement.resource === rule.resource && statement.effect === rule.effect;

export const withoutLock = (statements) => {
  const list = Array.isArray(statements) ? statements : [];
  const kept = [];
  for (let at = 0; at < list.length; at += 1) {
    if (isRule(list[at], DENY_ALL) && at + 1 < list.length && isRule(list[at + 1], ALLOW_MITTR)) at += 1;
    else kept.push(list[at]);
  }
  for (let at = kept.length - 1; at >= 0; at -= 1) {
    if (isRule(kept[at], ALLOW_ALL)) kept.splice(at, 1);
    else if (kept[at]?.action === ALLOW_ALL.action) break;
  }
  return kept;
};

export const userPolicies = (statements, { showOtherProviders }) => (showOtherProviders === true
  ? withoutLock(statements)
  : [...withoutLock(statements), ...policiesFor({ showOtherProviders, providerId: MITTR_PROVIDER_ID })]);

export function syncUserConfigLock({ userConfig, showOtherProviders }) {
  const config = userConfig.read();
  if (showOtherProviders === true && !Array.isArray(config.policies)) return false;
  const next = userPolicies(config.policies, { showOtherProviders });
  if (Array.isArray(config.policies) && JSON.stringify(config.policies) === JSON.stringify(next)) return false;
  if (next.length > 0) config.policies = next;
  else delete config.policies;
  userConfig.write(config);
  return true;
}
