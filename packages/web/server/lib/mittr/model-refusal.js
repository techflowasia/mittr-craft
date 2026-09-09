// A refusal from the completions surface has two unrelated causes, and the
// developer can fix only one of them without asking anybody. Collapsing them
// into a single message sends people to an admin for something a button would
// have solved.
//
// Catalog models come from the same platform grants that `agent_not_granted`
// reads, so that refusal means the cached catalog has drifted — repairable
// here. An entitlement refusal cannot be repaired here at all.
const REFUSALS = {
  desktop_entitlement_required: {
    reason: 'entitlement',
    messageKey: 'mittr.model.refused.entitlement',
    canResync: false,
  },
  agent_not_granted: {
    reason: 'stale-catalog',
    messageKey: 'mittr.model.refused.staleCatalog',
    canResync: true,
  },
};

export function describeModelRefusal(body) {
  return REFUSALS[String(body?.error ?? '')] ?? {
    reason: 'unknown',
    messageKey: 'mittr.model.refused.unknown',
    canResync: false,
  };
}
