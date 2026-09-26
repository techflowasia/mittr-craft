// Copying named fields, rather than deleting unwanted ones, is what makes a new
// field absent by default. Anything added to a record without being added here
// never leaves the machine (spec §11.3).
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

  // Actions and prompts are the two fields carrying nested objects, so they get
  // rebuilt from named keys rather than copied. Copying would let an `args` key
  // ride along inside an entry and defeat the allowlist one level down.
  if (Array.isArray(serialized.actions)) {
    serialized.actions = serialized.actions.map(({ tool, count }) => ({ tool, count }));
  }
  if (Array.isArray(serialized.prompts)) {
    serialized.prompts = serialized.prompts.map(({ at, text }) => ({ at, text }));
  }

  return serialized;
}
