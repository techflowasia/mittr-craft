export const AUDIT_FIELDS = Object.freeze([
  'startedAt',
  'endedAt',
  'repository',
  'model',
  'turns',
  'tokens',
  'actions',
  'prompts',
  'outcome',
]);

export function serializeAuditRecord(record) {
  const serialized = {};
  for (const field of AUDIT_FIELDS) {
    serialized[field] = record?.[field] ?? null;
  }

  if (Array.isArray(serialized.actions)) {
    serialized.actions = serialized.actions.map(({ tool, count }) => ({ tool, count }));
  }
  if (Array.isArray(serialized.prompts)) {
    serialized.prompts = serialized.prompts.map(({ at, text }) => ({ at, text }));
  }

  return serialized;
}
