// The catalog is Mittr's answer to "what is this person offered". Availability
// is decided there; enablement stays here (spec §7).

const COLLECTIONS = ['models', 'mcp', 'skills', 'knowledge'];

// An absent collection and an empty one are different states. Conflating them
// has already emptied a screen in production: a field that stopped being sent
// read as "the administrator removed everything" and uninstalled the lot.
const parseCollection = (name, raw) => {
  if (raw === undefined || raw === null) return { configured: false, items: [] };
  if (!Array.isArray(raw)) throw new Error(`Catalog field ${name} must be an array`);
  return { configured: true, items: raw };
};

export function parseCatalog(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Catalog payload must be an object');
  if (!Number.isInteger(payload.bundleVersion)) throw new Error('Catalog bundleVersion is required');

  const parsed = { bundleVersion: payload.bundleVersion, subject: payload.subject ?? null };
  for (const name of COLLECTIONS) {
    parsed[name] = parseCollection(name, payload[name]);
  }

  // `alias` is an opaque key issued by Mittr. Nothing here may depend on its
  // shape: it has already changed once, from a hash of the provider and model
  // to the key of the agent a grant names, because several agents can sit on
  // the same backend model with different instructions and skills. Whatever it
  // looks like next, it is read from the catalog and sent back to the
  // completions surface exactly as it arrived.
  //
  // Only emptiness is rejected. Two entries may share a backend model on
  // purpose and are genuinely different agents, so nothing here collapses or
  // deduplicates them. A model with no alias cannot be selected or attributed
  // and would put a nameless entry in the provider list, so it is dropped
  // rather than repaired.
  parsed.models.items = parsed.models.items.filter(
    (model) => typeof model?.alias === 'string' && model.alias.trim(),
  );

  return parsed;
}
