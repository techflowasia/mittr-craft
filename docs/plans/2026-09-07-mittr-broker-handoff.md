# Mittr Broker Implementation Plan — handoff to the platform team

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **This plan is executed in a different repository:** `techflowasia/mittr` (checked out at `~/Documents/ai-agent-platform`). It lives here because the design it implements lives here.

**Goal:** Let the MittrCraft desktop application authenticate as a person, draw its models from Mittr, and report what it did — without any Mittr credential ever reaching a developer's machine.

**Architecture:** Mittr already has almost all of this. `apps/api/src/openai/openai.controller.ts` is an OpenAI-compatible surface that authorises a machine client, enforces per-key model grants and passes through to the gateway. The work is to let that surface accept a desktop *session* as well as an API key, resolve the platform credential server-side, and add three small endpoints beside it.

**Tech Stack:** NestJS, better-auth, Postgres, jest, **pnpm 8.15.0** (this repository is not bun).

**Spec:** `docs/specs/2026-09-07-mittr-platform-integration.md` in `techflowasia/mittr-craft`

**Consumed by:** the five MittrCraft plans in the same directory. Plans 2 through 5 can only be finished once tasks 1, 3, 4 and 5 below exist.

*(Corrected 2026-09-09: the code samples below originally used `mittr-craft-1-0`
as a stand-in alias, written before the alias contract was pinned down. The
samples now use `agent-17okpqe` as an illustrative placeholder, not a real
value.)*

*(Corrected again 2026-09-10: the 2026-09-09 pass described the alias as the
literal prefix `pm_` followed by a hash of the provider and upstream model.
That is also wrong. The alias is the opaque key of the agent a grant names —
not derived from provider or model at all, and with no fixed prefix. It has
been redefined twice now, which is why nothing here may depend on its shape:
read it from the catalog and echo it back verbatim, never construct or
pattern-match it. See `docs/plans/2026-09-09-mittr-side-ready.md`.)*

## What already exists — read these before writing anything

| File | What it gives you |
| --- | --- |
| `apps/api/src/openai/openai.controller.ts` | `@AllowApiKey() @Controller('v1')`, `POST chat/completions`, `GET models`, `enforceExternalPolicy`, `passthrough` |
| `apps/api/src/keys/external-api-key.service.ts` | `issue`, `activate`, `list`, `revoke` for governed keys |
| `apps/api/src/keys/external-api-key-runtime.service.ts` | `authorize()`, and the `agent_not_granted` denial |
| `apps/api/src/keys/keys.controller.ts` | `@Controller('api/keys')`, the admin surface behind the API Keys screen |
| `apps/api/src/auth/auth.decorators.ts` | `@Public()`, `@AllowApiKey()`, `@CredentialAction()` |
| `apps/api/src/common/api-key-meta.ts` | `keyMemoryEnabled(req)` |

## Global Constraints

- Follow this repository's existing conventions for language, structure and tests. Do not import conventions from the MittrCraft repository.
- `pnpm`, never npm or bun. Tests are jest.
- Branch from `develop` and open a pull request back into it.
- The platform credential never appears in a response body, a log line, or anything sent to a desktop client.
- Identity is always taken from the verified session. A user identifier in a request body or header is ignored.

---

## Read this first: what the implementation found

**Status: implemented in `techflowasia/mittr` on `feat/desktop-surface` (7 commits, not yet
pushed).** Two things in this plan were wrong about the target repository. Both were checked
against the real code before anything was written, and both are corrected below rather than in
the commits, so the next reader of this plan does not re-derive them.

### 1. The Memory conflict is smaller than this plan claimed — and points the other way

This plan said `openai.controller.ts` calls `memory.autoExtract(userId, lastUserText)` after
every turn, that riding the surface unchanged would persist code, and that turning Memory off
for desktop traffic is a product decision needing the Memory owner's sign-off.

The first half is right. The conclusion is not. `memoryOwnerId()` reads:

```ts
private memoryOwnerId(req: Request): string | null {
  const grant = this.grantOf(req);
  if (grant) return grant.ownerUserId;
  return keyMemoryEnabled(req) ? getUserId(req) : null;
}
```

A **governed key** always uses Memory — the grant is present, so its owner is returned
unconditionally, and `OwnerIssuanceOptionsSchema` pins this with `memoryRequired: z.literal(true)`.
But with **no grant and no `req.apiKey`**, `keyMemoryEnabled` is false and this returns `null`.
**Memory is already off for session-authenticated requests**, and desktop traffic authenticates
as a session.

So the real risk is the inverse of the one described. If the desktop path had resolved the
platform key by attaching an `externalKeyGrant` to the request — the obvious reading of "resolve
the platform credential server-side" — Memory would have switched **on**, and every developer's
tool output and file contents would have been extracted into the platform key owner's long-term
store. That is a bug to avoid, not a policy to change.

**Decision (owner, 2026-09-07): do not attach a grant.** Desktop traffic carries no
`externalKeyGrant`, so `memoryOwnerId()` returns `null` by the rule that already exists. No new
special case, no divergence from how any existing key behaves, and nothing to escalate to
whoever owns Memory, because no existing behaviour changes. The platform key's grants are
enforced on a separate path that does not touch the request's grant field.

Spec §14 question 4 is answered by this and can be closed.

### 2. The platform key is not forwarded to the gateway

Task 3 below asserts `upstream.lastRequest.headers.authorization === Bearer ${platformKeySecret}`.
That does not describe this platform. In `mittr`, the credential that goes upstream to LiteLLM
comes from `this.providers.authHeaders(providerKey)` inside `MastraService.passthrough` — it is
the gateway credential, it is configured per provider, and it already never leaves the server.

The platform key is a different object: it is a **Mittr** governed key, the kind a client
presents *to* Mittr. Its job in this design is to carry the policy that says which agents
MittrCraft may use. It is never sent onward to the gateway, so there is no request whose
`authorization` header could equal it.

The **intent** behind that assertion is implementable exactly, and is what was built: the client
never holds or names a credential, the server resolves the policy itself, and nothing
credential-shaped appears in a response. The tests assert those three things instead.

### What else changed against the plan as written

- **Entitlement** (question 3 below, spec §14 question 2) is `ExternalResourceEligibilityService.requireAllowed(userId, 'agent', alias)` —
  the existing per-person, admin-decided, default-deny grant that governed keys already go
  through. It is checked live, so revoking one person takes effect on the next request without
  rotating the key every developer shares. No new table and no new admin screen.
- **Update artifacts** (question 2 below, spec §14 question 1) are served from a directory this
  API owns, with the root configurable so it can be repointed without a code change.
- The service signatures sketched below do not match the real ones (`issue(actor, input)`,
  `list()` returning `{ policies }`, everything behind a repository in `@mittr/database`). The
  sketches were kept as intent; the committed tests are written against the real shapes.
- A **refresh** endpoint was added alongside `exchange`. The plan's own return type includes a
  `refreshToken`, and spec §6.2 requires silent refresh, so leaving it out would have shipped a
  token nothing could redeem.
- The audit **retention sweep** is wired to a running timer. `purgeExpired` with no caller would
  have made "retention is ninety days" false while looking implemented.

---

### Task 1: Desktop sign-in

The desktop cannot hold a client secret and cannot use cookies, because the
system browser's cookies do not authenticate an Electron renderer. It opens the
browser at Mittr, and Mittr hands back a one-time code on a custom URL scheme.

**Files:**
- Create: `apps/api/src/desktop/desktop-auth.controller.ts`
- Create: `apps/api/src/desktop/desktop-auth.service.ts`
- Create: `apps/api/src/desktop/desktop-auth.service.spec.ts`
- Create: `apps/api/src/desktop/desktop.module.ts`
- Modify: `apps/api/src/app.module.ts` (register `DesktopModule`)

**Interfaces:**
- Produces: `GET /auth/desktop/start?state&code_challenge&redirect_uri` (public, redirects into the existing Microsoft flow)
- Produces: `POST /auth/desktop/exchange { code, code_verifier, redirect_uri }` (public) returning `{ accessToken, refreshToken, expiresAt, subject: { userId, displayName } }`

- [x] **Step 1: Write the failing test**

```typescript
import { DesktopAuthService } from './desktop-auth.service';

const ALLOWED = 'mittrcraft://auth/callback';

describe('DesktopAuthService', () => {
  let service: DesktopAuthService;

  beforeEach(() => {
    service = new DesktopAuthService({ allowedRedirectUris: [ALLOWED] } as never);
  });

  it('accepts the allowlisted redirect', () => {
    expect(() => service.assertRedirectAllowed(ALLOWED)).not.toThrow();
  });

  it('rejects any other redirect, so this endpoint is not an open redirect', () => {
    expect(() => service.assertRedirectAllowed('https://evil.test/steal')).toThrow();
    expect(() => service.assertRedirectAllowed('mittrcraft://auth/callback/../elsewhere')).toThrow();
    expect(() => service.assertRedirectAllowed('')).toThrow();
  });

  it('redeems a code once', async () => {
    const verifier = 'a'.repeat(64);
    const challenge = DesktopAuthService.challengeFor(verifier);
    const code = await service.mintCode({ userId: 'u1', challenge });

    await expect(service.redeem({ code, verifier, redirectUri: ALLOWED })).resolves.toMatchObject({
      subject: { userId: 'u1' },
    });
    await expect(service.redeem({ code, verifier, redirectUri: ALLOWED })).rejects.toThrow();
  });

  it('rejects a code redeemed with the wrong verifier', async () => {
    const challenge = DesktopAuthService.challengeFor('a'.repeat(64));
    const code = await service.mintCode({ userId: 'u1', challenge });
    await expect(service.redeem({ code, verifier: 'b'.repeat(64), redirectUri: ALLOWED }))
      .rejects.toThrow();
  });

  it('rejects a code after it expires', async () => {
    jest.useFakeTimers().setSystemTime(0);
    const verifier = 'a'.repeat(64);
    const code = await service.mintCode({ userId: 'u1', challenge: DesktopAuthService.challengeFor(verifier) });
    jest.setSystemTime(11 * 60 * 1000);
    await expect(service.redeem({ code, verifier, redirectUri: ALLOWED })).rejects.toThrow();
    jest.useRealTimers();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
pnpm --filter api test -- desktop-auth
```

Expected: FAIL, cannot resolve `./desktop-auth.service`.

- [x] **Step 3: Implement the service and controller**

The verifier is never sent to Mittr; only its SHA-256 is, at sign-in start. A
process that intercepts the deep link therefore holds a code it cannot redeem.
Codes are single-use, expire in ten minutes, and are bound to the redirect they
were minted for.

Mount the controller with `@Public()` on both routes, because a client that is
signing in has no session yet by definition. Reuse the existing better-auth
Microsoft flow to establish who the person is; do not add a second identity path.

- [x] **Step 4: Run the tests**

```bash
pnpm --filter api test -- desktop-auth
```

Expected: 5 passing.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/desktop apps/api/src/app.module.ts
git commit -m "feat(desktop): issue desktop sessions through a single-use bound code"
```

---

### Task 2: The platform key

Governed keys today are personal, non-shareable, expire in 30 days, and attribute
activity to their owner — the API Keys screen says so to the person issuing one.
A platform key is a different thing: it belongs to an application, it does not
expire, and attribution comes from the session on each request.

**Files:**
- Modify: `apps/api/src/keys/external-api-key.service.ts`
- Modify: `apps/api/src/keys/external-api-key.service.spec.ts`
- Modify: `apps/api/src/keys/keys.controller.ts`

- [x] **Step 1: Write the failing test**

```typescript
describe('platform keys', () => {
  it('issues a platform key with no expiry', async () => {
    const key = await service.issue({ kind: 'platform', label: 'mittrcraft' } as never);
    expect(key.expiresAt).toBeNull();
  });

  it('keeps two platform keys active at once so rotation is not an outage', async () => {
    await service.issue({ kind: 'platform', label: 'mittrcraft' } as never);
    await service.issue({ kind: 'platform', label: 'mittrcraft' } as never);
    const active = (await service.list({ kind: 'platform' } as never)).filter((k) => k.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('refuses a third active platform key for the same label', async () => {
    await service.issue({ kind: 'platform', label: 'mittrcraft' } as never);
    await service.issue({ kind: 'platform', label: 'mittrcraft' } as never);
    await expect(service.issue({ kind: 'platform', label: 'mittrcraft' } as never)).rejects.toThrow();
  });

  it('still expires personal keys at 30 days', async () => {
    const key = await service.issue({ kind: 'personal', ownerId: 'u1' } as never);
    expect(key.expiresAt).not.toBeNull();
  });

  it('never returns the secret when listing', async () => {
    await service.issue({ kind: 'platform', label: 'mittrcraft' } as never);
    const listed = await service.list({ kind: 'platform' } as never);
    expect(JSON.stringify(listed)).not.toMatch(/sk-/);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
pnpm --filter api test -- external-api-key.service
```

Expected: FAIL, `kind` is not part of the draft type.

- [x] **Step 3: Implement**

Add the `platform` kind alongside the existing personal one. Two active keys per
label is the rotation window: publish the new one, move traffic, revoke the old.
A third means somebody forgot to revoke, which is exactly when a stale credential
lives longest — so it fails instead.

Revocation of a platform key cuts every desktop at once. Per-person removal
belongs to the entitlement check in Task 3, not here, and the admin screen should
say so where the revoke button lives.

- [x] **Step 4: Run the tests**

```bash
pnpm --filter api test -- external-api-key.service
```

Expected: 5 new tests passing and the existing suite still green.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/keys
git commit -m "feat(keys): add a non-expiring platform key with a rotation window"
```

---

### Task 3: Accept a desktop session on the completions surface

**Files:**
- Modify: `apps/api/src/openai/openai.controller.ts`
- Modify: `apps/api/src/openai/openai.controller.spec.ts` (create if absent)

- [x] **Step 1: Write the failing test**

```typescript
describe('desktop traffic on the completions surface', () => {
  // Corrected: the platform key is a Mittr key a client presents TO Mittr, not something
  // Mittr forwards to the gateway (the gateway credential is providers.authHeaders(), already
  // server-side). What matters is that the CLIENT never names or holds one.
  it('authorises a desktop session without the client naming a credential', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${desktopSessionToken}`)
      .send({ model: 'agent-17okpqe', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    // Looked up here, never sent by the desktop.
    expect(desktopAccess.platformPolicyFor).toHaveBeenCalledWith('agent-17okpqe');
  });

  it('never lets a credential reach the client', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${desktopSessionToken}`)
      .send({ model: 'agent-17okpqe', messages: [] });
    expect(JSON.stringify(res.body)).not.toMatch(/mitr_|sk-|ekp-/);
  });

  it('refuses a model the platform key was not granted', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${desktopSessionToken}`)
      .send({ model: 'some-other-agent', messages: [] });
    expect(res.status).toBe(403);
  });

  it('refuses a person without the MittrCraft entitlement', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${sessionWithoutEntitlement}`)
      .send({ model: 'agent-17okpqe', messages: [] });
    expect(res.status).toBe(403);
  });

  it('does not read or write Memory for desktop traffic', async () => {
    await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${desktopSessionToken}`)
      .send({ model: 'agent-17okpqe', messages: [{ role: 'user', content: 'const secret = 1' }] });
    expect(memory.recall).not.toHaveBeenCalled();
    expect(memory.autoExtract).not.toHaveBeenCalled();
  });

  it('disables upstream response caching for desktop traffic', async () => {
    await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${desktopSessionToken}`)
      .send({ model: 'agent-17okpqe', messages: [] });
    expect(upstream.lastRequest.headers['cache-control']).toBe('no-store');
  });

  it('still serves API-key clients exactly as before', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/chat/completions')
      .set('authorization', `Bearer ${rooApiKey}`)
      .send({ model: 'coder', messages: [] });
    expect(res.status).toBe(200);
    expect(memory.recall).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
pnpm --filter api test -- openai.controller
```

Expected: FAIL, the surface rejects a session token.

- [x] **Step 3: Implement**

Three behaviours change, and only for desktop traffic:

1. A desktop session is accepted as a credential, and the platform key is looked
   up server-side. The client never names a key.
2. Memory is not touched — but NOT by skipping `injectMemory`/`extractAfter`. See the
   corrections at the top: a governed grant is deliberately not attached to the request, so
   `memoryOwnerId()` returns null by the rule that already exists. The tests assert `recall`
   and `autoExtract` were never called; nothing about any existing key changes.
3. `cache-control: no-store` goes upstream. The gateway caches on
   `(model, messages)`, and an agent that retries with identical input would get
   its previous answer back instead of reconsidering — a loop nobody can see.

The existing API-key path must keep working unchanged, memory included. The last
test exists to make a regression there impossible to miss.

- [x] **Step 4: Run the tests**

```bash
pnpm --filter api test -- openai.controller
```

Expected: 6 passing, and the existing controller suite still green.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/openai
git commit -m "feat(desktop): authorise desktop sessions without Memory or upstream caching"
```

---

### Task 4: Catalog endpoint

**Files:**
- Create: `apps/api/src/desktop/desktop-catalog.controller.ts`
- Create: `apps/api/src/desktop/desktop-catalog.service.ts`
- Create: `apps/api/src/desktop/desktop-catalog.service.spec.ts`

**Interfaces:**
- Produces: `GET /desktop/catalog` returning
  `{ bundleVersion, issuedAt, subject, models[], mcp[], skills[], knowledge[] }`.

- [x] **Step 1: Write the failing test**

```typescript
describe('DesktopCatalogService', () => {
  it('returns only model aliases, never the backend model behind them', async () => {
    const catalog = await service.forUser('u1');
    expect(catalog.models).toEqual([{ alias: 'agent-17okpqe', label: expect.any(String) }]);
    expect(JSON.stringify(catalog)).not.toContain('mittr-prod/');
  });

  it('omits a collection entirely when an admin has never configured it', async () => {
    const catalog = await service.forUser('u-no-mcp');
    expect(catalog).not.toHaveProperty('mcp');
  });

  it('returns an empty array when an admin configured it as empty', async () => {
    const catalog = await service.forUser('u-empty-mcp');
    expect(catalog.mcp).toEqual([]);
  });

  it('increments bundleVersion when an admin changes the catalog', async () => {
    const before = (await service.forUser('u1')).bundleVersion;
    await service.setMcpForEveryone([{ name: 'jira', config: { type: 'remote', url: 'https://jira.test/mcp' } }]);
    expect((await service.forUser('u1')).bundleVersion).toBeGreaterThan(before);
  });

  it('refuses a person without the entitlement', async () => {
    await expect(service.forUser('u-no-entitlement')).rejects.toThrow();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
pnpm --filter api test -- desktop-catalog
```

Expected: FAIL, cannot resolve `./desktop-catalog.service`.

- [x] **Step 3: Implement**

An absent field and an empty array must stay distinguishable all the way to the
wire. This is the `studio_agents` lesson: `null` meaning "never configured" and
`[]` meaning "deliberately nothing" were once conflated and the screen went empty
for everybody. The desktop reads these as different states.

`bundleVersion` is what lets a client skip work when nothing changed. It must
increase on every admin edit, including a deletion.

- [x] **Step 4: Run the tests**

```bash
pnpm --filter api test -- desktop-catalog
```

Expected: 5 passing.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/desktop
git commit -m "feat(desktop): serve a per-person catalog of aliases and shared tooling"
```

---

### Task 5: Audit endpoint

**Files:**
- Create: `apps/api/src/desktop/desktop-audit.controller.ts`
- Create: `apps/api/src/desktop/desktop-audit.service.ts`
- Create: `apps/api/src/desktop/desktop-audit.service.spec.ts`
- Create: a migration for the audit table

**Interfaces:**
- Produces: `POST /desktop/audit` accepting
  `{ startedAt, endedAt, repository, turns, tokens, actions, prompts, outcome }`.

- [x] **Step 1: Write the failing test**

```typescript
describe('DesktopAuditService', () => {
  it('stamps the identity from the session and ignores anything the client claims', async () => {
    const stored = await service.record(
      { userId: 'u1', displayName: 'Chaiwat' },
      { ...validRecord, userId: 'somebody-else', displayName: 'Somebody Else' } as never,
    );
    expect(stored.userId).toBe('u1');
    expect(JSON.stringify(stored)).not.toContain('somebody-else');
  });

  it('drops any field outside the accepted set', async () => {
    const stored = await service.record({ userId: 'u1' }, {
      ...validRecord,
      messages: [{ role: 'user', content: 'const secret = 1' }],
      fileContents: 'export const x = 1;',
    } as never);
    expect(stored).not.toHaveProperty('messages');
    expect(stored).not.toHaveProperty('fileContents');
    expect(JSON.stringify(stored)).not.toContain('secret');
  });

  it('keeps typed instructions and tool counts', async () => {
    const stored = await service.record({ userId: 'u1' }, validRecord);
    expect(stored.prompts).toEqual(validRecord.prompts);
    expect(stored.actions).toEqual(validRecord.actions);
  });

  it('deletes records older than ninety days', async () => {
    await service.record({ userId: 'u1' }, { ...validRecord, endedAt: Date.now() - 91 * 864e5 });
    await service.purgeExpired();
    expect(await service.listForAdmin()).toHaveLength(0);
  });

  it('is readable by an admin and by nobody else', async () => {
    await expect(service.listFor({ role: 'member' } as never)).rejects.toThrow();
    await expect(service.listFor({ role: 'admin' } as never)).resolves.toBeDefined();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
pnpm --filter api test -- desktop-audit
```

Expected: FAIL, cannot resolve `./desktop-audit.service`.

- [x] **Step 3: Implement**

Accept named fields and ignore the rest, rather than stripping known-bad ones. A
field that arrives without being named here is dropped by default, which is what
keeps a future desktop change from quietly persisting code (spec §11.3).

Retention is ninety days with automatic deletion. The records contain what people
typed, so keeping them indefinitely turns a usage log into a personnel file.

- [x] **Step 4: Run the tests**

```bash
pnpm --filter api test -- desktop-audit
```

Expected: 5 passing.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/desktop
git commit -m "feat(desktop): record audit entries under the verified identity"
```

---

### Task 6: Update feed

**Files:**
- Create: `apps/api/src/desktop/desktop-updates.controller.ts`
- Create: `apps/api/src/desktop/desktop-updates.controller.spec.ts`

- [x] **Step 1: Write the failing test**

```typescript
describe('desktop update feed', () => {
  it('refuses an unauthenticated manifest request', async () => {
    await request(app.getHttpServer()).get('/desktop/updates/latest-mac.yml').expect(401);
  });

  it('serves the manifest to a signed-in person', async () => {
    await request(app.getHttpServer())
      .get('/desktop/updates/latest-mac.yml')
      .set('authorization', `Bearer ${desktopSessionToken}`)
      .expect(200);
  });

  it('refuses a path that climbs out of the artifact directory', async () => {
    await request(app.getHttpServer())
      .get('/desktop/updates/../../etc/passwd')
      .set('authorization', `Bearer ${desktopSessionToken}`)
      .expect(400);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```bash
pnpm --filter api test -- desktop-updates
```

Expected: FAIL, cannot resolve `./desktop-updates.controller`.

- [x] **Step 3: Implement**

Serve manifests and installers from a directory this endpoint owns, gated by the
same desktop session. Resolve every requested path and reject anything that lands
outside that directory.

Publishing an installer without its manifest makes it invisible to every client,
so the release job must upload both.

- [x] **Step 4: Run the tests**

```bash
pnpm --filter api test -- desktop-updates
```

Expected: 3 passing.

- [ ] **Step 5: Run the whole suite and open the pull request** — suite run (5,579 passing);
  the push and PR are held pending the owner's go-ahead.

```bash
pnpm --filter api test
```

```bash
git push -u origin feat/desktop-surface
```

Open the pull request against `develop`.

---

## Questions for the platform team — all three answered (owner, 2026-09-07)

1. ~~**Memory for desktop traffic.**~~ **Closed, and it was not the decision this plan
   expected.** Memory is already off for session traffic; the work was to keep it that way by
   not attaching a governed grant. No existing behaviour changes, so nothing needed escalating.
   See the corrections at the top.
2. ~~**Where update artifacts live.**~~ **A directory this API serves**, session-gated, with the
   root configurable (`DESKTOP_UPDATES_DIR`) so it can be repointed to object storage later
   without a code change. Task 6 and MittrCraft plan 5 stand as written.
3. ~~**How the MittrCraft entitlement is expressed.**~~ **The existing per-person eligibility
   decision** — `requireAllowed(userId, 'agent', alias)`. Per-person, admin-decided,
   default-deny, checked live. No new mechanism.

## Still open, and owned outside this repository

- **Code signing and notarisation** (spec §10). Without a company certificate an unsigned macOS
  build downloads updates and then fails to install them, retrying forever. The update endpoint
  is done; the update *path* does not work until IT provides this.
- **Gateway-side work** (spec §13): token pricing in `config.yaml` so usage figures stop
  reporting zero. Caching and the two-key rotation window are handled from this side —
  `cache-control: no-store` goes upstream per request, and two active platform keys are
  accepted — but the gateway team should confirm it honours the header.
- **The pre-flight in spec §12** — calling `agent-17okpqe` through the real gateway with a
  prompt that forces a tool call — has not been run. It needs the real gateway, and per spec if
  it fails the design changes rather than proceeds.
