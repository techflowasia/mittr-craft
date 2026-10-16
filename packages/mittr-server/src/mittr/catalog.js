// The catalog is Mittr's answer to "what is this person offered": the
// organisation's roster, read from the platform's desktop route. Availability
// is decided there; enablement stays here.

export const CATALOG_COLLECTIONS = ['models', 'mcp', 'skills', 'knowledge'];

// An absent collection and an empty one are different states. Conflating them
// once emptied a screen in production: a field that stopped being sent read
// as "the administrator removed everything" and uninstalled the lot.
const parseCollection = (name, raw) => {
  if (raw === undefined || raw === null) return { configured: false, items: [] };
  if (!Array.isArray(raw)) throw new Error(`Catalog field ${name} must be an array`);
  return { configured: true, items: raw };
};

/**
 * The platform's catalog payload as `{ bundleVersion, subject, models, mcp,
 * skills, knowledge }`, each collection `{ configured, items }`. Throws on a
 * payload that cannot be trusted as a whole.
 *
 * `alias` is an opaque key issued by Mittr and sent back exactly as it
 * arrived; it has changed shape before. Only a missing or blank alias is
 * dropped, since such a model could not be selected or attributed. Two
 * entries on the same backend model are different agents and both stay.
 */
export function parseCatalog(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Catalog payload must be an object');
  if (!Number.isInteger(payload.bundleVersion)) throw new Error('Catalog bundleVersion is required');

  const parsed = { bundleVersion: payload.bundleVersion, subject: payload.subject ?? null };
  for (const name of CATALOG_COLLECTIONS) {
    parsed[name] = parseCollection(name, payload[name]);
  }
  parsed.models.items = parsed.models.items.filter((model) => typeof model?.alias === 'string' && model.alias.trim());
  return parsed;
}
