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

  // `alias` is an opaque identifier minted by Mittr — a `pm_` prefix and a hash
  // of the provider and model behind it. It is never a readable name, it is
  // never constructed here, and it is sent back to the completions surface
  // exactly as it arrived. A model without one cannot be selected or
  // attributed, and registering it would put a nameless entry in the provider
  // list, so it is dropped rather than repaired.
  parsed.models.items = parsed.models.items.filter(
    (model) => typeof model?.alias === 'string' && model.alias.trim(),
  );

  return parsed;
}
