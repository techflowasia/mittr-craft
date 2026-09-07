# Mittr Audit Implementation Plan

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record who used the product, on which repository, with which model, and what they typed — and make it structurally impossible for code to travel with it.

**Architecture:** The desktop accumulates one record per working session: the instructions the person typed, tool names with counts, and the repository's git remote. It sends that record to the broker, which stamps the verified identity. Serialisation goes through an allowlist so a field carrying content cannot be added by accident.

**Tech Stack:** Node ESM, Express 5, vitest, supertest, bun.

**Spec:** `docs/specs/2026-09-07-mittr-platform-integration.md` (§8, §11.3)

**Depends on:** `docs/plans/2026-09-07-mittr-sign-in.md`

## Global Constraints

- Never recorded: assembled prompts, model responses, file contents, tool arguments, shell commands, terminal output. (spec §8)
- What the person typed is recorded in full, and the application says so. (spec §8)
- `where` is the git remote, never a local path. (spec §8)
- Audit failures never block work. (spec §9)
- Everything in this repository is written in English. Thai appears only in UI strings.
- No mention of AI assistants in commits, code, or documentation.
- Run commands with `bun`.

---

### Task 1: The record aggregator

**Files:**
- Create: `packages/web/server/lib/mittr/audit-record.js`
- Test: `packages/web/server/lib/mittr/audit-record.test.js`

**Interfaces:**
- Produces: `createAuditRecord({ now }) -> { addPrompt(text), addToolUse(name), addTurn({ tokens }), setRepository(remote), finish(outcome) -> record }`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { createAuditRecord } from './audit-record.js';

const at = (...times) => {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
};

describe('audit record', () => {
  it('counts turns and tokens', () => {
    const record = createAuditRecord({ now: at(0) });
    record.addTurn({ tokens: 1200 });
    record.addTurn({ tokens: 800 });
    const finished = record.finish('completed');
    expect(finished.turns).toBe(2);
    expect(finished.tokens).toBe(2000);
  });

  it('counts tool uses by name and keeps no arguments', () => {
    const record = createAuditRecord({ now: at(0) });
    record.addToolUse('edit');
    record.addToolUse('edit');
    record.addToolUse('bash');
    // The broker accepts [{ tool, count }]. An object map is dropped silently by
    // its allowlist, which would look like a working audit with no tool data.
    expect(record.finish('completed').actions).toEqual([
      { tool: 'edit', count: 2 },
      { tool: 'bash', count: 1 },
    ]);
  });

  it('keeps typed instructions in full and in order', () => {
    const record = createAuditRecord({ now: at(10, 20) });
    record.addPrompt('first thing');
    record.addPrompt('second thing');
    expect(record.finish('completed').prompts).toEqual([
      { at: 10, text: 'first thing' },
      { at: 20, text: 'second thing' },
    ]);
  });

  it('records the repository remote', () => {
    const record = createAuditRecord({ now: at(0) });
    record.setRepository('techflowasia/mittr-craft');
    expect(record.finish('completed').repository).toBe('techflowasia/mittr-craft');
  });

  it('spans from the first event to the finish', () => {
    const record = createAuditRecord({ now: at(100, 400) });
    record.addTurn({ tokens: 1 });
    expect(record.finish('completed')).toMatchObject({ startedAt: 100, endedAt: 400 });
  });

  it('carries the outcome through', () => {
    expect(createAuditRecord({ now: at(0) }).finish('failed').outcome).toBe('failed');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- audit-record
```

Expected: FAIL, cannot resolve `./audit-record.js`.

- [ ] **Step 3: Write the implementation**

```javascript
export function createAuditRecord({ now = Date.now } = {}) {
  let startedAt = null;
  let turns = 0;
  let tokens = 0;
  let repository = null;
  const actions = {};
  const prompts = [];

  const mark = () => {
    const at = now();
    if (startedAt === null) startedAt = at;
    return at;
  };

  return {
    addTurn: ({ tokens: turnTokens = 0 } = {}) => {
      mark();
      turns += 1;
      tokens += turnTokens;
    },
    // Only the tool's name. Its arguments are the file paths, shell commands
    // and payloads this record must never carry (spec §8).
    addToolUse: (name) => {
      mark();
      actions[name] = (actions[name] ?? 0) + 1;
    },
    addPrompt: (text) => {
      prompts.push({ at: mark(), text: String(text) });
    },
    setRepository: (remote) => { repository = remote; },
    finish: (outcome) => ({
      startedAt: startedAt ?? now(),
      endedAt: now(),
      repository,
      turns,
      tokens,
      // Counted in an object because that is cheap to accumulate, emitted as an
      // array because that is the shape the broker accepts. Capped at 100
      // entries and 200 prompts to match its limits.
      actions: Object.entries(actions).slice(0, 100).map(([tool, count]) => ({ tool, count })),
      prompts: prompts.slice(0, 200).map(({ at, text }) => ({ at, text: text.slice(0, 4000) })),
      outcome,
    }),
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- audit-record
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/audit-record.js packages/web/server/lib/mittr/audit-record.test.js
git commit -m "feat(mittr): accumulate one audit record per working session"
```

---

### Task 2: The allowlist serialiser

This is spec §11.3, the invariant whose violation nobody would notice until it
was too late. The serialiser copies named fields rather than filtering unwanted
ones, so a new field is absent by default instead of leaking by default.

**Files:**
- Create: `packages/web/server/lib/mittr/audit-serializer.js`
- Test: `packages/web/server/lib/mittr/audit-serializer.test.js`

**Interfaces:**
- Consumes: the record from Task 1.
- Produces: `serializeAuditRecord(record) -> object` and `AUDIT_FIELDS` (the allowlist).

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { serializeAuditRecord, AUDIT_FIELDS } from './audit-serializer.js';

const record = {
  startedAt: 100,
  endedAt: 200,
  repository: 'techflowasia/mittr-craft',
  turns: 2,
  tokens: 2000,
  actions: [{ tool: 'edit', count: 2 }],
  prompts: [{ at: 100, text: 'do the thing' }],
  outcome: 'completed',
};

describe('audit serialiser', () => {
  it('emits exactly the allowlisted fields', () => {
    expect(Object.keys(serializeAuditRecord(record)).sort()).toEqual([...AUDIT_FIELDS].sort());
  });

  it('drops any field that is not on the allowlist', () => {
    const withExtras = {
      ...record,
      messages: [{ role: 'user', content: 'const secret = "..."' }],
      fileContents: 'export const x = 1;',
      toolArguments: { path: '/Users/someone/client-work/secret.ts' },
    };
    const serialized = serializeAuditRecord(withExtras);
    expect(serialized).not.toHaveProperty('messages');
    expect(serialized).not.toHaveProperty('fileContents');
    expect(serialized).not.toHaveProperty('toolArguments');
    expect(JSON.stringify(serialized)).not.toContain('secret');
  });

  it('keeps action names but strips anything else off an action', () => {
    const serialized = serializeAuditRecord({
      ...record,
      actions: [{ tool: 'bash', count: 3, args: { command: 'rm -rf /' } }],
    });
    // The broker drops `args` too, but relying on that would mean the command
    // still left this machine. Strip it here, at the last point we control.
    expect(serialized.actions).toEqual([{ tool: 'bash', count: 3 }]);
    expect(JSON.stringify(serialized)).not.toContain('rm -rf');
  });

  it('keeps typed prompts intact', () => {
    expect(serializeAuditRecord(record).prompts).toEqual([{ at: 100, text: 'do the thing' }]);
  });

  it('locks the allowlist so widening it is a deliberate edit', () => {
    // Adding a field here without discussing it is the failure mode this guards
    // against. If this assertion fails, read spec section 8 before changing it.
    expect([...AUDIT_FIELDS].sort()).toEqual([
      'actions', 'endedAt', 'model', 'outcome', 'prompts', 'repository', 'startedAt', 'tokens', 'turns',
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- audit-serializer
```

Expected: FAIL, cannot resolve `./audit-serializer.js`.

- [ ] **Step 3: Write the implementation**

```javascript
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
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- audit-serializer
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/audit-serializer.js packages/web/server/lib/mittr/audit-serializer.test.js
git commit -m "feat(mittr): serialise audit records through a locked allowlist"
```

---

### Task 3: Repository identity

`packages/web/server/lib/git/service.js` exposes `getRemoteUrl(directory, remoteName)`,
documented in `packages/web/server/lib/git/DOCUMENTATION.md`.

**Files:**
- Create: `packages/web/server/lib/mittr/repository-identity.js`
- Test: `packages/web/server/lib/mittr/repository-identity.test.js`

**Interfaces:**
- Produces: `resolveRepositoryIdentity(directory, { getRemoteUrl }) -> Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest';
import { resolveRepositoryIdentity } from './repository-identity.js';

const withRemote = (url) => ({ getRemoteUrl: vi.fn().mockResolvedValue(url) });

describe('resolveRepositoryIdentity', () => {
  it('reduces an https remote to owner and repository', async () => {
    await expect(resolveRepositoryIdentity('/repo', withRemote('https://github.com/techflowasia/mittr-craft.git')))
      .resolves.toBe('techflowasia/mittr-craft');
  });

  it('reduces an ssh remote the same way', async () => {
    await expect(resolveRepositoryIdentity('/repo', withRemote('git@bitbucket.org:techflowasia/allkons.git')))
      .resolves.toBe('techflowasia/allkons');
  });

  it('returns null when the repository has no remote', async () => {
    await expect(resolveRepositoryIdentity('/repo', withRemote(''))).resolves.toBeNull();
  });

  it('returns null rather than a local path when the lookup throws', async () => {
    const getRemoteUrl = vi.fn().mockRejectedValue(new Error('not a git repository'));
    await expect(resolveRepositoryIdentity('/Users/someone/client-secret', { getRemoteUrl }))
      .resolves.toBeNull();
  });

  it('never returns anything containing the local path', async () => {
    const identity = await resolveRepositoryIdentity(
      '/Users/someone/client-secret',
      withRemote('https://github.com/techflowasia/mittr-craft.git')
    );
    expect(identity).not.toContain('/Users');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- repository-identity
```

Expected: FAIL, cannot resolve `./repository-identity.js`.

- [ ] **Step 3: Write the implementation**

```javascript
// A folder name can itself be confidential — a client's name, an unannounced
// product. Only the remote is reported, and a repository without one is
// reported as nothing at all (spec §8).
export async function resolveRepositoryIdentity(directory, { getRemoteUrl }) {
  let url;
  try {
    url = await getRemoteUrl(directory, 'origin');
  } catch {
    return null;
  }

  const raw = String(url ?? '').trim();
  if (!raw) return null;

  const withoutSuffix = raw.replace(/\.git$/, '');
  const match = withoutSuffix.match(/[:/]([^/:]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- repository-identity
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/repository-identity.js packages/web/server/lib/mittr/repository-identity.test.js
git commit -m "feat(mittr): identify a repository by its remote, never by its path"
```

---

### Task 4: Sending records

**Files:**
- Create: `packages/web/server/lib/mittr/audit-routes.js`
- Test: `packages/web/server/lib/mittr/audit-routes.test.js`

**Interfaces:**
- Consumes: Tasks 1-3, the session store from plan 2.
- Produces: `registerMittrAuditRoutes(app, { brokerBaseUrl, sessionStore, resolveRepository, fetchImpl })`
  serving `POST /api/mittr/audit/prompt`, `POST /api/mittr/audit/tool`, `POST /api/mittr/audit/finish`.
  `resolveRepository` is `resolveRepositoryIdentity` from Task 3 with the git library's
  `getRemoteUrl` already bound to it, so this module never imports the git layer directly.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrAuditRoutes } from './audit-routes.js';

const createApp = (fetchImpl, session = { accessToken: 'at-1' }) => {
  const app = express();
  app.use(express.json());
  registerMittrAuditRoutes(app, {
    brokerBaseUrl: 'https://mittr.test',
    sessionStore: { read: () => session },
    resolveRepository: async () => 'techflowasia/mittr-craft',
    fetchImpl,
  });
  return app;
};

const ok = () => new Response('', { status: 204 });

describe('mittr audit routes', () => {
  it('sends one record on finish, not one per event', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);

    await request(app).post('/api/mittr/audit/prompt').send({ sessionId: 's1', text: 'do the thing' }).expect(204);
    await request(app).post('/api/mittr/audit/tool').send({ sessionId: 's1', name: 'edit' }).expect(204);
    expect(fetchImpl).not.toHaveBeenCalled();

    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.prompts[0].text).toBe('do the thing');
    expect(body.actions).toEqual([{ tool: 'edit', count: 1 }]);
    expect(body.repository).toBe('techflowasia/mittr-craft');
  });

  it('never sends a field outside the allowlist even if the client supplies one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);
    await request(app).post('/api/mittr/audit/prompt').send({ sessionId: 's1', text: 'hi' }).expect(204);
    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo', fileContents: 'const secret = 1;' })
      .expect(204);
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('secret');
  });

  it('does not send anything the client claims about identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    const app = createApp(fetchImpl);
    await request(app).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo', userId: 'somebody-else' })
      .expect(204);
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('somebody-else');
  });

  it('answers 204 even when the broker rejects the record', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    await request(createApp(fetchImpl)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
  });

  it('answers 204 even when the broker is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await request(createApp(fetchImpl)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
  });

  it('drops the record when nobody is signed in', async () => {
    const fetchImpl = vi.fn();
    await request(createApp(fetchImpl, null)).post('/api/mittr/audit/finish')
      .send({ sessionId: 's1', outcome: 'completed', directory: '/repo' })
      .expect(204);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- audit-routes
```

Expected: FAIL, cannot resolve `./audit-routes.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { createAuditRecord } from './audit-record.js';
import { serializeAuditRecord } from './audit-serializer.js';

export function registerMittrAuditRoutes(app, {
  brokerBaseUrl,
  sessionStore,
  resolveRepository,
  fetchImpl = fetch,
}) {
  const open = new Map();

  const recordFor = (sessionId) => {
    if (!open.has(sessionId)) open.set(sessionId, createAuditRecord({}));
    return open.get(sessionId);
  };

  app.post('/api/mittr/audit/prompt', (req, res) => {
    const text = String(req.body?.text ?? '');
    if (text) recordFor(String(req.body?.sessionId ?? '')).addPrompt(text);
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/tool', (req, res) => {
    const name = String(req.body?.name ?? '');
    // The name only. Arguments are never read off this request.
    if (name) recordFor(String(req.body?.sessionId ?? '')).addToolUse(name);
    return res.status(204).end();
  });

  app.post('/api/mittr/audit/finish', async (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    const record = recordFor(sessionId);
    open.delete(sessionId);

    record.setRepository(await resolveRepository(String(req.body?.directory ?? '')));
    const payload = serializeAuditRecord(record.finish(String(req.body?.outcome ?? 'unknown')));

    // Identity is the broker's to determine from the session it verified. Any
    // user identifier on this request is ignored (spec §11.2).
    const session = sessionStore.read();
    if (!session?.accessToken) return res.status(204).end();

    try {
      await fetchImpl(new URL('/desktop/audit', brokerBaseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // Never block work on the audit trail. It exists to understand usage, not
      // to gate access (spec §9).
      console.warn('[mittr] audit record was not delivered:', error?.message ?? error);
    }

    return res.status(204).end();
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- audit-routes
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/audit-routes.js packages/web/server/lib/mittr/audit-routes.test.js
git commit -m "feat(mittr): send one audit record per session and never block on it"
```

---

### Task 5: Tell the developer they are being recorded

Recording what somebody types and not telling them is the version of this
feature that damages trust (spec §8). The notice is part of the feature, not
decoration.

**Files:**
- Create: `packages/ui/src/components/mittr/AuditNotice.tsx`
- Test: `packages/ui/src/components/mittr/AuditNotice.test.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/*.ts`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuditNotice } from './AuditNotice';

describe('AuditNotice', () => {
  it('says that instructions are recorded and who can read them', () => {
    render(<AuditNotice />);
    const text = screen.getByRole('note').textContent ?? '';
    expect(text).toMatch(/record/i);
    expect(text).toMatch(/admin/i);
  });

  it('is present without needing to be opened', () => {
    render(<AuditNotice />);
    expect(screen.getByRole('note')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/ui test -- AuditNotice
```

Expected: FAIL, cannot resolve `./AuditNotice`.

- [ ] **Step 3: Write the component**

```tsx
import { useTranslation } from '@/lib/i18n';

export function AuditNotice() {
  const { t } = useTranslation();
  return (
    <p role="note" className="typography-meta opacity-75">
      {t('mittr.audit.notice')}
    </p>
  );
}
```

Add the key to every locale file. English value:

```
'mittr.audit.notice': 'Your instructions are recorded and visible to Mittr admins. Your code and files are not.',
```

The second sentence matters as much as the first: without it the notice reads as
though everything is captured, and people stop using the product for real work.

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/ui test -- AuditNotice
```

Expected: 2 passing.

- [ ] **Step 5: Place the notice**

Render `AuditNotice` on the sign-in screen from plan 2 and in the settings page
that lists Mittr status, so it is seen before first use and findable afterwards.

- [ ] **Step 6: Run the whole suite**

```bash
bun run type-check && bun run lint && bun run test
```

`packages/web/server/lib/github/pr-status.test.js` fails on `develop` already and
is unrelated; everything else must pass.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/mittr packages/ui/src/lib/i18n/messages
git commit -m "feat(mittr): tell developers what the audit trail records"
```

---

## What this plan leaves to later plans

- **Wiring the engine's tool events.** This plan exposes
  `POST /api/mittr/audit/tool`; connecting the engine's tool lifecycle to it is a
  follow-up once the event surface is chosen.
- **Retention.** Ninety days and automatic deletion are the broker's to
  implement (spec §8).
- **Updates.** Plan 5.
