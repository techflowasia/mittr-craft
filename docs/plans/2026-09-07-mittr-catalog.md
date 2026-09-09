# Mittr Catalog Implementation Plan

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Mittr decide what models, MCP connectors and skills are available, while each developer keeps control of which of them are switched on.

**Architecture:** The broker serves a catalog for the signed-in person. The desktop caches it, then reconciles the organisation's MCP entries into the engine's configuration through the writers that already exist. Availability and enablement are stored separately: a sync replaces the catalog and never touches a developer's switches.

**Tech Stack:** Node ESM, Express 5, vitest, supertest, bun.

**Spec:** `docs/specs/2026-09-07-mittr-platform-integration.md` (§7)

**Depends on:** `docs/plans/2026-09-07-mittr-sign-in.md`

*(Corrected 2026-09-09: the code samples below originally used `mittr-craft-1-0`
as a stand-in alias — written before the alias contract was pinned down. A real
alias is opaque: the literal prefix `pm_` followed by a hash of the provider
and upstream model. The samples now use `pm_9f2c1d4e7b` as an illustrative
placeholder — it is not a real value, and nothing in this codebase may
construct, guess, or hardcode one. See
`docs/plans/2026-09-09-mittr-side-ready.md`.)*

## Global Constraints

- Packaged builds only; no `.env` a developer edits. (spec §4.1)
- The platform key never leaves Mittr. (spec §4.2)
- The engine fork carries string literals only. Behaviour belongs in `packages/`, not in a patch. (spec §4.4)
- A developer cannot add a model. MCP connectors and skills stay theirs to add. (spec §7)
- Everything in this repository is written in English. Thai appears only in UI strings.
- No mention of AI assistants in commits, code, or documentation.
- Run commands with `bun`.

---

### Task 1: Catalog parsing

An absent field and an empty list are different states, and conflating them has
already emptied a screen in production (spec §7).

**Files:**
- Create: `packages/web/server/lib/mittr/catalog.js`
- Test: `packages/web/server/lib/mittr/catalog.test.js`

**Interfaces:**
- Produces: `parseCatalog(payload) -> { bundleVersion, models, mcp, skills, knowledge }`
  where each collection is `{ configured: boolean, items: Array }`. Throws on a
  malformed payload.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { parseCatalog } from './catalog.js';

const base = { bundleVersion: 7, issuedAt: '2026-09-07T00:00:00Z', subject: { userId: 'u1' } };

describe('parseCatalog', () => {
  it('marks an absent collection as not configured', () => {
    expect(parseCatalog({ ...base }).mcp).toEqual({ configured: false, items: [] });
  });

  it('marks an empty collection as configured and empty', () => {
    expect(parseCatalog({ ...base, mcp: [] }).mcp).toEqual({ configured: true, items: [] });
  });

  it('keeps the items of a populated collection', () => {
    const parsed = parseCatalog({ ...base, models: [{ alias: 'pm_9f2c1d4e7b', label: 'MittrCraft 1.0' }] });
    expect(parsed.models).toEqual({
      configured: true,
      items: [{ alias: 'pm_9f2c1d4e7b', label: 'MittrCraft 1.0' }],
    });
  });

  it('drops a model entry with no alias rather than registering a nameless provider', () => {
    const parsed = parseCatalog({ ...base, models: [{ label: 'nameless' }, { alias: 'ok' }] });
    expect(parsed.models.items).toEqual([{ alias: 'ok' }]);
  });

  it('rejects a payload with no bundle version, because sync cannot compare it', () => {
    expect(() => parseCatalog({ issuedAt: '2026-09-07T00:00:00Z' })).toThrow(/bundleVersion/);
  });

  it('rejects a collection that is not an array', () => {
    expect(() => parseCatalog({ ...base, mcp: { a: 1 } })).toThrow(/mcp/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- lib/mittr/catalog
```

Expected: FAIL, cannot resolve `./catalog.js`.

- [ ] **Step 3: Write the implementation**

```javascript
const COLLECTIONS = ['models', 'mcp', 'skills', 'knowledge'];

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

  // A model without an alias cannot be selected or attributed, and registering
  // it would put an unnamed entry in the provider list.
  parsed.models.items = parsed.models.items.filter(
    (model) => typeof model?.alias === 'string' && model.alias.trim()
  );

  return parsed;
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- lib/mittr/catalog
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/catalog.js packages/web/server/lib/mittr/catalog.test.js
git commit -m "feat(mittr): parse the catalog and keep unset apart from empty"
```

---

### Task 2: Catalog cache

**Files:**
- Create: `packages/web/server/lib/mittr/catalog-cache.js`
- Test: `packages/web/server/lib/mittr/catalog-cache.test.js`

**Interfaces:**
- Produces: `createCatalogCache({ filePath, fsImpl }) -> { read(), write(catalog) }`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCatalogCache } from './catalog-cache.js';

let dir;
const catalog = {
  bundleVersion: 7,
  models: { configured: true, items: [{ alias: 'pm_9f2c1d4e7b' }] },
  mcp: { configured: false, items: [] },
  skills: { configured: false, items: [] },
  knowledge: { configured: false, items: [] },
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-catalog-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const cache = () => createCatalogCache({ filePath: path.join(dir, 'catalog.json') });

describe('catalog cache', () => {
  it('returns null before anything is cached', () => {
    expect(cache().read()).toBeNull();
  });

  it('round-trips a catalog', () => {
    cache().write(catalog);
    expect(cache().read()).toEqual(catalog);
  });

  it('treats an unparsable cache as absent rather than throwing at startup', () => {
    fs.writeFileSync(path.join(dir, 'catalog.json'), '{ not json');
    expect(cache().read()).toBeNull();
  });

  it('replaces the previous catalog wholesale', () => {
    const c = cache();
    c.write(catalog);
    c.write({ ...catalog, bundleVersion: 8, models: { configured: true, items: [] } });
    expect(c.read().bundleVersion).toBe(8);
    expect(c.read().models.items).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- catalog-cache
```

Expected: FAIL, cannot resolve `./catalog-cache.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import nodeFs from 'node:fs';
import path from 'node:path';

// The cache keeps configuration from disappearing while the network blips. It
// does not make the product work offline: without the broker there is no
// credential to call a model with (spec §7).
export function createCatalogCache({ filePath, fsImpl = nodeFs }) {
  const read = () => {
    try {
      return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  };

  const write = (catalog) => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(catalog, null, 2), 'utf8');
  };

  return { read, write };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- catalog-cache
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/catalog-cache.js packages/web/server/lib/mittr/catalog-cache.test.js
git commit -m "feat(mittr): cache the last catalog the broker served"
```

---

### Task 3: Local enablement, kept apart from availability

Mittr decides what exists. The developer decides what runs. A sync must never
flip a switch somebody set (spec §7).

**Files:**
- Create: `packages/web/server/lib/mittr/local-enablement.js`
- Test: `packages/web/server/lib/mittr/local-enablement.test.js`

**Interfaces:**
- Produces: `createEnablementStore({ filePath, fsImpl }) -> { isEnabled(kind, name), setEnabled(kind, name, enabled), all() }`.
  Anything never touched is enabled.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnablementStore } from './local-enablement.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-enable-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const store = () => createEnablementStore({ filePath: path.join(dir, 'enablement.json') });

describe('local enablement', () => {
  it('treats anything never touched as enabled', () => {
    expect(store().isEnabled('mcp', 'jira')).toBe(true);
  });

  it('remembers a disable across restarts', () => {
    store().setEnabled('mcp', 'jira', false);
    expect(store().isEnabled('mcp', 'jira')).toBe(false);
  });

  it('keeps kinds apart so a skill and a connector may share a name', () => {
    const s = store();
    s.setEnabled('mcp', 'jira', false);
    expect(s.isEnabled('skills', 'jira')).toBe(true);
  });

  it('re-enables when asked', () => {
    const s = store();
    s.setEnabled('mcp', 'jira', false);
    s.setEnabled('mcp', 'jira', true);
    expect(s.isEnabled('mcp', 'jira')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- local-enablement
```

Expected: FAIL, cannot resolve `./local-enablement.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import nodeFs from 'node:fs';
import path from 'node:path';

// Only disabled entries are recorded. Absence means enabled, so a catalog entry
// that appears later is on by default and a developer's disable survives every
// sync until they undo it themselves.
export function createEnablementStore({ filePath, fsImpl = nodeFs }) {
  const load = () => {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const save = (state) => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
  };

  return {
    isEnabled: (kind, name) => !load()[kind]?.[name]?.disabled,
    setEnabled: (kind, name, enabled) => {
      const state = load();
      state[kind] = state[kind] ?? {};
      if (enabled) delete state[kind][name];
      else state[kind][name] = { disabled: true, at: new Date().toISOString() };
      save(state);
    },
    all: () => load(),
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- local-enablement
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/local-enablement.js packages/web/server/lib/mittr/local-enablement.test.js
git commit -m "feat(mittr): keep local enablement apart from catalog availability"
```

---

### Task 4: Reconcile MCP entries into the engine

`packages/web/server/lib/opencode/mcp.js` exports the writers this task drives:

```
listMcpConfigs(workingDirectory)
createMcpConfig(name, mcpConfig, workingDirectory, scope)
updateMcpConfig(name, updates, workingDirectory)
deleteMcpConfig(name, workingDirectory)
```

Organisation entries are named `mittr/<name>` so the set this code owns is
identifiable, and a developer's own connector can never collide with one.

**Files:**
- Create: `packages/web/server/lib/mittr/mcp-reconciler.js`
- Test: `packages/web/server/lib/mittr/mcp-reconciler.test.js`

**Interfaces:**
- Consumes: `parseCatalog` output (Task 1), `createEnablementStore` (Task 3).
- Produces: `reconcileMcp({ catalog, enablement, workingDirectory, mcpApi }) -> { created, updated, removed }`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest';
import { reconcileMcp } from './mcp-reconciler.js';

const fakeMcpApi = (existing = []) => ({
  listMcpConfigs: vi.fn(() => existing),
  createMcpConfig: vi.fn(),
  updateMcpConfig: vi.fn(),
  deleteMcpConfig: vi.fn(),
});

const enablementAllOn = { isEnabled: () => true };

const catalogWith = (items) => ({
  mcp: { configured: true, items },
});

describe('reconcileMcp', () => {
  it('creates an organisation entry that is not present yet', () => {
    const mcpApi = fakeMcpApi([]);
    const result = reconcileMcp({
      catalog: catalogWith([{ name: 'jira', config: { type: 'remote', url: 'https://jira.test/mcp' } }]),
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.createMcpConfig).toHaveBeenCalledWith(
      'mittr/jira',
      { type: 'remote', url: 'https://jira.test/mcp' },
      '/repo',
      'user'
    );
    expect(result.created).toEqual(['mittr/jira']);
  });

  it('removes an organisation entry the catalog no longer lists', () => {
    const mcpApi = fakeMcpApi([{ name: 'mittr/retired' }, { name: 'mittr/jira' }]);
    reconcileMcp({
      catalog: catalogWith([{ name: 'jira', config: { type: 'remote', url: 'https://jira.test/mcp' } }]),
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).toHaveBeenCalledWith('mittr/retired', '/repo');
    expect(mcpApi.deleteMcpConfig).toHaveBeenCalledTimes(1);
  });

  it('never touches an entry a developer added themselves', () => {
    const mcpApi = fakeMcpApi([{ name: 'my-own-thing' }]);
    reconcileMcp({
      catalog: catalogWith([]),
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).not.toHaveBeenCalled();
  });

  it('does not install an entry the developer disabled', () => {
    const mcpApi = fakeMcpApi([]);
    reconcileMcp({
      catalog: catalogWith([{ name: 'jira', config: { type: 'remote', url: 'https://jira.test/mcp' } }]),
      enablement: { isEnabled: (kind, name) => !(kind === 'mcp' && name === 'jira') },
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.createMcpConfig).not.toHaveBeenCalled();
  });

  it('removes an entry that is present but has since been disabled', () => {
    const mcpApi = fakeMcpApi([{ name: 'mittr/jira' }]);
    reconcileMcp({
      catalog: catalogWith([{ name: 'jira', config: { type: 'remote', url: 'https://jira.test/mcp' } }]),
      enablement: { isEnabled: () => false },
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).toHaveBeenCalledWith('mittr/jira', '/repo');
  });

  it('does nothing at all when the catalog never configured mcp', () => {
    const mcpApi = fakeMcpApi([{ name: 'mittr/jira' }]);
    reconcileMcp({
      catalog: { mcp: { configured: false, items: [] } },
      enablement: enablementAllOn,
      workingDirectory: '/repo',
      mcpApi,
    });
    expect(mcpApi.deleteMcpConfig).not.toHaveBeenCalled();
    expect(mcpApi.createMcpConfig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- mcp-reconciler
```

Expected: FAIL, cannot resolve `./mcp-reconciler.js`.

- [ ] **Step 3: Write the implementation**

```javascript
const ORG_PREFIX = 'mittr/';

export function reconcileMcp({ catalog, enablement, workingDirectory, mcpApi }) {
  const collection = catalog?.mcp ?? { configured: false, items: [] };

  // An unconfigured collection is not an empty one. Treating it as empty would
  // delete every organisation connector the moment a field went missing.
  if (!collection.configured) return { created: [], updated: [], removed: [] };

  const wanted = new Map(
    collection.items
      .filter((item) => typeof item?.name === 'string' && item.name.trim())
      .filter((item) => enablement.isEnabled('mcp', item.name))
      .map((item) => [`${ORG_PREFIX}${item.name}`, item.config])
  );

  const present = new Set(
    (mcpApi.listMcpConfigs(workingDirectory) ?? [])
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string' && name.startsWith(ORG_PREFIX))
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
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- mcp-reconciler
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/mcp-reconciler.js packages/web/server/lib/mittr/mcp-reconciler.test.js
git commit -m "feat(mittr): reconcile organisation MCP entries without touching personal ones"
```

---

### Task 5: Sync routes and the model list

Plan 1 task 6 registered `pm_9f2c1d4e7b` as a hardcoded model. This task
replaces it with whatever the catalog says.

**Files:**
- Create: `packages/web/server/lib/mittr/catalog-routes.js`
- Test: `packages/web/server/lib/mittr/catalog-routes.test.js`
- Modify: `packages/web/server/lib/mittr/index.js`

**Interfaces:**
- Consumes: `parseCatalog` (Task 1), `createCatalogCache` (Task 2), `createEnablementStore` (Task 3), `reconcileMcp` (Task 4), the session store from plan 2.
- Produces: `registerMittrCatalogRoutes(app, { brokerBaseUrl, sessionStore, cache, enablement, syncModels, fetchImpl })`
  serving `POST /api/mittr/catalog/sync`, `GET /api/mittr/catalog`, `PUT /api/mittr/catalog/enablement`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrCatalogRoutes } from './catalog-routes.js';

const memoryCache = () => {
  let value = null;
  return { read: () => value, write: (v) => { value = v; } };
};

const catalogPayload = {
  bundleVersion: 7,
  models: [{ alias: 'pm_9f2c1d4e7b', label: 'MittrCraft 1.0' }],
  mcp: [],
};

const createApp = ({ fetchImpl, cache = memoryCache(), syncModels = vi.fn() } = {}) => {
  const app = express();
  app.use(express.json());
  const enablementState = {};
  registerMittrCatalogRoutes(app, {
    brokerBaseUrl: 'https://mittr.test',
    sessionStore: { read: () => ({ accessToken: 'at-1' }) },
    cache,
    enablement: {
      isEnabled: (kind, name) => !enablementState[`${kind}:${name}`],
      setEnabled: (kind, name, on) => { enablementState[`${kind}:${name}`] = !on; },
    },
    syncModels,
    fetchImpl,
  });
  return { app, cache, syncModels, enablementState };
};

const ok = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

describe('mittr catalog routes', () => {
  it('fetches, caches and hands the models to the provider registrar', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(catalogPayload));
    const { app, cache, syncModels } = createApp({ fetchImpl });

    await request(app).post('/api/mittr/catalog/sync').expect(200);

    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer at-1');
    expect(cache.read().bundleVersion).toBe(7);
    expect(syncModels).toHaveBeenCalledWith([{ alias: 'pm_9f2c1d4e7b', label: 'MittrCraft 1.0' }]);
  });

  it('keeps the cached catalog when the broker is unreachable', async () => {
    const cache = memoryCache();
    cache.write({ bundleVersion: 6, models: { configured: true, items: [] }, mcp: { configured: false, items: [] } });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { app } = createApp({ fetchImpl, cache });

    await request(app).post('/api/mittr/catalog/sync').expect(502);
    expect(cache.read().bundleVersion).toBe(6);
  });

  it('serves the cached catalog with each item marked enabled or not', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ...catalogPayload, mcp: [{ name: 'jira' }] }));
    const { app } = createApp({ fetchImpl });
    await request(app).post('/api/mittr/catalog/sync').expect(200);

    const res = await request(app).get('/api/mittr/catalog').expect(200);
    expect(res.body.mcp.items[0]).toEqual({ name: 'jira', enabled: true });
  });

  it('records a disable and reflects it on the next read', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ...catalogPayload, mcp: [{ name: 'jira' }] }));
    const { app } = createApp({ fetchImpl });
    await request(app).post('/api/mittr/catalog/sync').expect(200);

    await request(app)
      .put('/api/mittr/catalog/enablement')
      .send({ kind: 'mcp', name: 'jira', enabled: false })
      .expect(200);

    const res = await request(app).get('/api/mittr/catalog').expect(200);
    expect(res.body.mcp.items[0].enabled).toBe(false);
  });

  it('refuses to sync when nobody is signed in', async () => {
    const app = express();
    app.use(express.json());
    registerMittrCatalogRoutes(app, {
      brokerBaseUrl: 'https://mittr.test',
      sessionStore: { read: () => null },
      cache: memoryCache(),
      enablement: { isEnabled: () => true, setEnabled: () => {} },
      syncModels: vi.fn(),
      fetchImpl: vi.fn(),
    });
    await request(app).post('/api/mittr/catalog/sync').expect(401);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- catalog-routes
```

Expected: FAIL, cannot resolve `./catalog-routes.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { parseCatalog } from './catalog.js';

const withEnablement = (collection, kind, enablement) => ({
  configured: collection.configured,
  items: collection.items.map((item) => ({
    ...item,
    enabled: enablement.isEnabled(kind, item.name ?? item.alias),
  })),
});

export function registerMittrCatalogRoutes(app, {
  brokerBaseUrl,
  sessionStore,
  cache,
  enablement,
  syncModels,
  fetchImpl = fetch,
}) {
  app.post('/api/mittr/catalog/sync', async (_req, res) => {
    const session = sessionStore.read();
    if (!session?.accessToken) return res.status(401).json({ error: 'Not signed in to Mittr' });

    let response;
    try {
      response = await fetchImpl(new URL('/desktop/catalog', brokerBaseUrl).toString(), {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
    } catch (error) {
      // The previous catalog stays exactly as it was. Replacing it with nothing
      // would uninstall every organisation entry over a network blip.
      console.error('[mittr] catalog sync failed:', error?.message ?? error);
      return res.status(502).json({ error: 'Cannot reach Mittr' });
    }

    if (!response.ok) return res.status(response.status).json({ error: 'Mittr refused the catalog request' });

    let catalog;
    try {
      catalog = parseCatalog(await response.json());
    } catch (error) {
      return res.status(502).json({ error: `Mittr served an unusable catalog: ${error.message}` });
    }

    cache.write(catalog);
    if (catalog.models.configured) await syncModels(catalog.models.items);
    return res.json({ bundleVersion: catalog.bundleVersion });
  });

  app.get('/api/mittr/catalog', (_req, res) => {
    const catalog = cache.read();
    if (!catalog) return res.json({ bundleVersion: null, models: { configured: false, items: [] }, mcp: { configured: false, items: [] } });
    return res.json({
      bundleVersion: catalog.bundleVersion,
      models: withEnablement(catalog.models, 'models', enablement),
      mcp: withEnablement(catalog.mcp, 'mcp', enablement),
      skills: withEnablement(catalog.skills, 'skills', enablement),
    });
  });

  app.put('/api/mittr/catalog/enablement', (req, res) => {
    const kind = String(req.body?.kind ?? '');
    const name = String(req.body?.name ?? '');
    if (!['mcp', 'skills'].includes(kind) || !name) {
      // Models are not a developer's to switch off; the catalog is the whole
      // point of removing bring-your-own-key (spec §7).
      return res.status(400).json({ error: 'kind must be mcp or skills, and name is required' });
    }
    enablement.setEnabled(kind, name, req.body?.enabled !== false);
    return res.json({ ok: true });
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- catalog-routes
```

Expected: 5 passing.

- [ ] **Step 5: Replace the hardcoded model registration**

In `packages/web/server/lib/mittr/index.js`, delete the hardcoded
`models: { 'pm_9f2c1d4e7b': ... }` object that plan 1 task 6 added, and pass a
`syncModels` function that builds the same shape from the catalog:

```javascript
const syncModels = async (models) => {
  const config = {
    name: 'Mittr',
    options: { baseURL: mittrShim.baseUrl },
    models: Object.fromEntries(models.map((model) => [model.alias, { name: model.label ?? model.alias }])),
  };
  await fetch(`http://127.0.0.1:${port}/api/provider`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerID: 'mittr', scope: 'user', config }),
  });
};
```

- [ ] **Step 6: Sync after sign-in and at startup**

Call `POST /api/mittr/catalog/sync` when the sign-in callback in plan 2 stores a
session, and once at startup when a session already exists. A failure at startup
is logged and ignored; the cached catalog carries the application.

- [ ] **Step 7: Run the whole suite**

```bash
bun run type-check && bun run lint && bun run test
```

`packages/web/server/lib/github/pr-status.test.js` fails on `develop` already and
is unrelated; everything else must pass.

- [ ] **Step 8: Commit**

```bash
git add packages/web/server/lib/mittr
git commit -m "feat(mittr): drive the model and connector list from the catalog"
```


---

### Task 6: Say the right thing when a model is refused

A refusal from the completions surface has two unrelated causes, and one of them
the developer can fix without asking anybody. Collapsing them into a single
message sends people to an admin for something a button would have solved.

**Files:**
- Create: `packages/web/server/lib/mittr/model-refusal.js`
- Test: `packages/web/server/lib/mittr/model-refusal.test.js`
- Modify: `packages/ui/src/lib/i18n/messages/*.ts`

**Interfaces:**
- Produces: `describeModelRefusal(body) -> { reason: 'entitlement' | 'stale-catalog' | 'unknown', messageKey, canResync }`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { describeModelRefusal } from './model-refusal.js';

describe('describeModelRefusal', () => {
  it('sends an entitlement refusal to an admin', () => {
    expect(describeModelRefusal({ error: 'desktop_entitlement_required' })).toEqual({
      reason: 'entitlement',
      messageKey: 'mittr.model.refused.entitlement',
      canResync: false,
    });
  });

  it('offers a re-sync when the platform no longer grants the model', () => {
    expect(describeModelRefusal({ error: 'agent_not_granted' })).toEqual({
      reason: 'stale-catalog',
      messageKey: 'mittr.model.refused.staleCatalog',
      canResync: true,
    });
  });

  it('falls back without inventing a cause', () => {
    expect(describeModelRefusal({ error: 'something_else' }).reason).toBe('unknown');
    expect(describeModelRefusal(null).reason).toBe('unknown');
  });

  it('never offers a re-sync for an entitlement problem, which re-syncing cannot fix', () => {
    expect(describeModelRefusal({ error: 'desktop_entitlement_required' }).canResync).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- model-refusal
```

Expected: FAIL, cannot resolve `./model-refusal.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// Catalog models come from the same platform key grants that agent_not_granted
// reads, so that refusal means the cached catalog has drifted — something the
// client can repair itself. An entitlement refusal cannot be repaired here.
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
```

Add the three keys to every locale file. English values:

```
'mittr.model.refused.entitlement': 'You do not have access to this model. Ask a Mittr admin to grant it.',
'mittr.model.refused.staleCatalog': 'This model is no longer available from Mittr. Refresh your catalog to see what is.',
'mittr.model.refused.unknown': 'Mittr refused this request.',
```

Do not word the entitlement message as "not in your catalog". The catalog gate is
entitled-to-any, so a person can hold a catalog listing two models while being
entitled to only one of them. That wording would be wrong precisely when the
message appears.

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- model-refusal
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/model-refusal.js packages/web/server/lib/mittr/model-refusal.test.js packages/ui/src/lib/i18n/messages
git commit -m "feat(mittr): tell an access problem apart from a stale catalog"
```

---

## What this plan leaves to later plans

- **Skills materialisation.** The catalog carries skills and this plan exposes
  them, but writing them to disk needs the managed-directory work described in
  spec §6.3 and lands with the skills follow-up.
- **Knowledge.** Pointers are parsed and cached; wiring them to the engine is
  separate.
- **Audit.** Plan 4. **Updates.** Plan 5.
