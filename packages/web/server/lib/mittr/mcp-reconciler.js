// Organisation entries are named `mittr/<name>`, so the set this code owns is
// identifiable from the config alone and a developer's own connector can never
// collide with one — or be deleted by one.
const ORG_PREFIX = 'mittr/';

export function reconcileMcp({ catalog, enablement, workingDirectory, mcpApi }) {
  const collection = catalog?.mcp ?? { configured: false, items: [] };

  // An unconfigured collection is not an empty one. Treating it as empty would
  // uninstall every organisation connector the moment a field went missing.
  if (!collection.configured) return { created: [], updated: [], removed: [] };

  const wanted = new Map(
    collection.items
      .filter((item) => typeof item?.name === 'string' && item.name.trim())
      .filter((item) => enablement.isEnabled('mcp', item.name))
      .map((item) => [`${ORG_PREFIX}${item.name}`, item.config]),
  );

  const present = new Set(
    (mcpApi.listMcpConfigs(workingDirectory) ?? [])
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string' && name.startsWith(ORG_PREFIX)),
  );

  const created = [];
  const updated = [];
  const removed = [];

  for (const [name, config] of wanted) {
    if (present.has(name)) {
      mcpApi.updateMcpConfig(name, config, workingDirectory);
      updated.push(name);
    } else {
      mcpApi.createMcpConfig(name, config, workingDirectory, 'user');
      created.push(name);
    }
  }

  // Anything under the organisation prefix that the catalog no longer wants is
  // ours to remove. Entries outside the prefix belong to the developer and are
  // never touched.
  for (const name of present) {
    if (!wanted.has(name)) {
      mcpApi.deleteMcpConfig(name, workingDirectory);
      removed.push(name);
    }
  }

  return { created, updated, removed };
}
