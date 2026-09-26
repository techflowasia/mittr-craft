# Mittr Sign-In Implementation Plan

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary upstream credential from plan 1 with a real Mittr session obtained through the system browser and returned by deep link.

**Architecture:** Sign-in leaves the application entirely. The desktop opens the system browser at Mittr, Mittr runs the Microsoft exchange it already runs today, and the result comes back to `mittrcraft://auth/callback` as a one-time code bound to a verifier the desktop generated. The desktop exchanges that code for a session, keeps it in OS-encrypted storage, and the shim from plan 1 uses it instead of a static token.

**Tech Stack:** Node ESM, Express 5, Electron, vitest, supertest, bun.

**Spec:** `docs/specs/2026-09-07-mittr-platform-integration.md`

**Depends on:** `docs/plans/2026-09-07-loopback-shim.md` (tasks 1-6 complete)

**Wire contract:** `docs/specs/2026-09-07-mittr-broker-wire-contract.md`. Two
things in it change this plan and are carried through the tasks below:

- **The broker does not echo a client `state`.** Its callback carries an opaque
  state of its own and hands the desktop `<redirect_uri>?code=<code>`. The code
  is bound to the verifier, and a code minted against another challenge cannot be
  redeemed with ours, so the verifier is what actually protects the exchange.
  Task 1 keeps `state` only as a local marker that a sign-in is in progress, and
  `verifyCallback` no longer requires it in the URL.
- **A code is spent on first presentation, valid or not, and expires in ten
  minutes.** Never retry an exchange; restart sign-in.

Refresh moves into this plan rather than the next one: `POST /auth/desktop/refresh`
exists, the access token lasts an hour, and **refresh rotates both tokens**, so
two concurrent refreshes race and one loses. Task 7 adds it, serialised.

## Global Constraints

- Packaged builds only. No `.env` a developer edits. (spec §4.1)
- The platform key never leaves Mittr. Nothing here stores a Mittr API key. (spec §4.2)
- No Azure AD changes. The desktop never contacts Microsoft directly. (spec §4.3)
- The engine fork carries string literals only. Behaviour belongs in `packages/`, not in a patch. (spec §4.4)
- Everything in this repository is written in English. Thai appears only in UI strings.
- No mention of AI assistants in commits, code, or documentation.
- Run commands with `bun`.

---

### Task 1: Sign-in transaction

The desktop must prove that the code arriving on the deep link belongs to the
sign-in *it* started. Another application on the machine can register the same
URL scheme, so a code that anyone can redeem is a code that anyone can steal
(spec §6.2).

**Files:**
- Create: `packages/web/server/lib/mittr/sign-in-transaction.js`
- Test: `packages/web/server/lib/mittr/sign-in-transaction.test.js`

**Interfaces:**
- Produces:
  - `createTransaction({ randomBytes, now }) -> { state, verifier, challenge, createdAt }`
  - `verifyCallback(transaction, callbackUrl, { now }) -> { code: string }`, throws on any mismatch.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { createTransaction, verifyCallback } from './sign-in-transaction.js';

const txAt = (ms) => createTransaction({ now: () => ms });

describe('sign-in transaction', () => {
  it('produces a state, a verifier and a challenge derived from the verifier', () => {
    const tx = txAt(0);
    expect(tx.state).toMatch(/^[0-9a-f]{32}$/);
    expect(tx.verifier).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts a callback carrying a code', () => {
    const tx = txAt(0);
    expect(verifyCallback(tx, 'mittrcraft://auth/callback?code=abc123', { now: () => 1000 }))
      .toEqual({ code: 'abc123' });
  });

  it('rejects a callback with no code', () => {
    const tx = txAt(0);
    expect(() => verifyCallback(tx, 'mittrcraft://auth/callback', { now: () => 1000 }))
      .toThrow(/code/);
  });

  it('rejects a callback on the wrong scheme or path', () => {
    const tx = txAt(0);
    expect(() => verifyCallback(tx, 'https://evil.test/callback?code=x', { now: () => 1 }))
      .toThrow(/callback/);
    expect(() => verifyCallback(tx, 'mittrcraft://connect/callback?code=x', { now: () => 1 }))
      .toThrow(/callback/);
  });

  it('rejects a callback that arrives after the transaction expires', () => {
    const tx = txAt(0);
    const url = 'mittrcraft://auth/callback?code=abc123';
    expect(() => verifyCallback(tx, url, { now: () => 10 * 60 * 1000 + 1 })).toThrow(/expired/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- sign-in-transaction
```

Expected: FAIL, cannot resolve `./sign-in-transaction.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import nodeCrypto from 'node:crypto';

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export function createTransaction({
  randomBytes = nodeCrypto.randomBytes,
  now = Date.now,
} = {}) {
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(32).toString('hex');
  const challenge = nodeCrypto.createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge, createdAt: now() };
}

// The verifier never leaves this process; only its hash goes to Mittr. A caller
// that intercepts the deep link gets a code it cannot redeem.
export function verifyCallback(transaction, callbackUrl, { now = Date.now } = {}) {
  let url;
  try {
    url = new URL(String(callbackUrl));
  } catch {
    throw new Error('Sign-in callback is not a valid URL');
  }

  if (url.protocol !== 'mittrcraft:' || url.hostname !== 'auth') {
    throw new Error('Sign-in callback did not arrive on the auth deep link');
  }

  if (now() - transaction.createdAt > TRANSACTION_TTL_MS) {
    throw new Error('Sign-in transaction expired');
  }

  // The broker does not echo our state; it keeps an opaque one of its own and
  // returns only the code. The code is bound to the challenge we sent, so a code
  // minted for anybody else cannot be redeemed with our verifier — that binding,
  // not a matching state, is what protects this exchange.
  const code = (url.searchParams.get('code') ?? '').trim();
  if (!code) throw new Error('Sign-in callback carried no code');

  return { code };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- sign-in-transaction
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/sign-in-transaction.js packages/web/server/lib/mittr/sign-in-transaction.test.js
git commit -m "feat(mittr): bind the sign-in callback to the transaction that started it"
```

---

### Task 2: Session store

**Files:**
- Create: `packages/web/server/lib/mittr/session-store.js`
- Test: `packages/web/server/lib/mittr/session-store.test.js`

**Interfaces:**
- Produces: `createSessionStore({ filePath, encrypt, decrypt, fsImpl }) -> { read(), write(session), clear() }`
  where a session is `{ accessToken, refreshToken, expiresAt, subject }`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from './session-store.js';

let dir;
// Stand-in for Electron safeStorage: reversible, and distinguishable from
// plaintext so a test can prove the file is not readable as-is.
const encrypt = (text) => Buffer.from(`enc:${text}`);
const decrypt = (buffer) => Buffer.from(buffer).toString('utf8').replace(/^enc:/, '');

const session = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 1_800_000,
  subject: { userId: 'u1', displayName: 'Chaiwat' },
};

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-session-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const store = () => createSessionStore({ filePath: path.join(dir, 'session'), encrypt, decrypt });

describe('session store', () => {
  it('returns null before anything is written', () => {
    expect(store().read()).toBeNull();
  });

  it('round-trips a session', () => {
    store().write(session);
    expect(store().read()).toEqual(session);
  });

  it('never writes the token in plaintext', () => {
    store().write(session);
    const raw = fs.readFileSync(path.join(dir, 'session'));
    expect(raw.toString('utf8')).not.toContain('at-1');
  });

  it('writes owner-readable only', () => {
    store().write(session);
    expect(fs.statSync(path.join(dir, 'session')).mode & 0o777).toBe(0o600);
  });

  it('treats an undecryptable file as no session instead of throwing', () => {
    fs.writeFileSync(path.join(dir, 'session'), 'garbage');
    const broken = createSessionStore({
      filePath: path.join(dir, 'session'),
      encrypt,
      decrypt: () => { throw new Error('cannot decrypt'); },
    });
    expect(broken.read()).toBeNull();
  });

  it('clears the session', () => {
    const s = store();
    s.write(session);
    s.clear();
    expect(s.read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- session-store
```

Expected: FAIL, cannot resolve `./session-store.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import nodeFs from 'node:fs';
import path from 'node:path';

export function createSessionStore({ filePath, encrypt, decrypt, fsImpl = nodeFs }) {
  const read = () => {
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath);
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(decrypt(raw));
      if (!parsed || typeof parsed.accessToken !== 'string') return null;
      return parsed;
    } catch {
      // A session we cannot decrypt is a session we do not have. Signing in
      // again is cheap; crashing on startup is not.
      return null;
    }
  };

  const write = (session) => {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(filePath, encrypt(JSON.stringify(session)), { mode: 0o600 });
    if (process.platform !== 'win32') fsImpl.chmodSync(filePath, 0o600);
  };

  const clear = () => {
    try {
      fsImpl.rmSync(filePath, { force: true });
    } catch {
      // Already gone.
    }
  };

  return { read, write, clear };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- session-store
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/session-store.js packages/web/server/lib/mittr/session-store.test.js
git commit -m "feat(mittr): store the Mittr session encrypted at rest"
```

---

### Task 3: Deep-link branch in Electron

`packages/electron/main.mjs` already registers the `mittrcraft` scheme (line 184),
parses links with `parseDeepLink` into `{ type, value, raw }` where `type` is the
URL hostname (line 1987), and routes them in `dispatchDeepLink` (line 2202), which
today handles only `type === 'connect'`.

**Files:**
- Modify: `packages/electron/main.mjs:2202` (add an `auth` branch)
- Create: `packages/electron/auth-deep-link.mjs`
- Test: `packages/electron/auth-deep-link.test.mjs`

**Interfaces:**
- Produces: `isAuthCallbackLink(link) -> boolean` for a `parseDeepLink` result.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { isAuthCallbackLink } from './auth-deep-link.mjs';

describe('isAuthCallbackLink', () => {
  it('accepts the auth callback', () => {
    expect(isAuthCallbackLink({ type: 'auth', value: 'callback', raw: 'mittrcraft://auth/callback?code=x' }))
      .toBe(true);
  });

  it('ignores the pairing link so the existing branch keeps it', () => {
    expect(isAuthCallbackLink({ type: 'connect', value: '', raw: 'mittrcraft://connect?v=2' })).toBe(false);
  });

  it('ignores an auth link on another path', () => {
    expect(isAuthCallbackLink({ type: 'auth', value: 'logout', raw: 'mittrcraft://auth/logout' })).toBe(false);
  });

  it('ignores a malformed link', () => {
    expect(isAuthCallbackLink(null)).toBe(false);
    expect(isAuthCallbackLink({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/electron test -- auth-deep-link
```

Expected: FAIL, cannot resolve `./auth-deep-link.mjs`.

- [ ] **Step 3: Write the implementation**

```javascript
// parseDeepLink in main.mjs puts the URL hostname in `type` and the joined path
// segments in `value`, so mittrcraft://auth/callback arrives as
// { type: 'auth', value: 'callback' }.
export const isAuthCallbackLink = (link) => Boolean(
  link && link.type === 'auth' && link.value === 'callback' && typeof link.raw === 'string'
);
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/electron test -- auth-deep-link
```

Expected: 4 passing.

- [ ] **Step 5: Add the branch to `dispatchDeepLink`**

Add the import beside the other local imports at the top of `main.mjs`:

```javascript
import { isAuthCallbackLink } from './auth-deep-link.mjs';
```

Then, inside `dispatchDeepLink` at line 2202, add the new branch **before** the
existing `if (link.type === 'connect')`:

```javascript
  if (isAuthCallbackLink(link)) {
    // The renderer never sees the raw callback. The local server owns the
    // transaction and the verifier, so it is the only thing that can redeem it.
    void fetch(`http://127.0.0.1:${localServerPort}/api/mittr/auth/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: link.raw }),
    }).catch((error) => {
      log.warn('[electron] failed to hand the auth callback to the local server:', error?.message ?? error);
    });
    return;
  }
```

Use whichever identifier this file already holds the local server port in; read
the surrounding function and match it rather than introducing a new variable.

- [ ] **Step 6: Commit**

```bash
git add packages/electron/auth-deep-link.mjs packages/electron/auth-deep-link.test.mjs packages/electron/main.mjs
git commit -m "feat(mittr): route the auth callback deep link to the local server"
```

---

### Task 4: Sign-in routes

**Files:**
- Create: `packages/web/server/lib/mittr/auth-routes.js`
- Test: `packages/web/server/lib/mittr/auth-routes.test.js`

**Interfaces:**
- Consumes: `createTransaction`, `verifyCallback` (Task 1); `createSessionStore` (Task 2).
- Produces: `registerMittrAuthRoutes(app, { brokerBaseUrl, sessionStore, openExternal, fetchImpl })`
  serving `POST /api/mittr/auth/start`, `POST /api/mittr/auth/callback`, `GET /api/mittr/auth/status`, `DELETE /api/mittr/auth/session`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrAuthRoutes } from './auth-routes.js';

const memoryStore = () => {
  let value = null;
  return { read: () => value, write: (s) => { value = s; }, clear: () => { value = null; } };
};

const createApp = ({ fetchImpl = vi.fn(), openExternal = vi.fn(), sessionStore = memoryStore() } = {}) => {
  const app = express();
  app.use(express.json());
  registerMittrAuthRoutes(app, {
    brokerBaseUrl: 'https://mittr.test',
    sessionStore,
    openExternal,
    fetchImpl,
  });
  return { app, fetchImpl, openExternal, sessionStore };
};

describe('mittr auth routes', () => {
  it('reports signed out before any sign-in', async () => {
    const { app } = createApp();
    await request(app).get('/api/mittr/auth/status').expect(200, { signedIn: false });
  });

  it('opens the system browser with a challenge and a state', async () => {
    const { app, openExternal } = createApp();
    await request(app).post('/api/mittr/auth/start').send({}).expect(200);

    const opened = new URL(openExternal.mock.calls[0][0]);
    expect(opened.origin).toBe('https://mittr.test');
    expect(opened.searchParams.get('code_challenge')).toBeTruthy();
    expect(opened.searchParams.get('redirect_uri')).toBe('mittrcraft://auth/callback');
  });

  it('exchanges the callback code and stores the session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: 2_000_000,
      subject: { userId: 'u1', displayName: 'Chaiwat' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const { app, sessionStore, openExternal } = createApp({ fetchImpl });
    await request(app).post('/api/mittr/auth/start').send({}).expect(200);

    await request(app)
      .post('/api/mittr/auth/callback')
      .send({ url: 'mittrcraft://auth/callback?code=abc' })
      .expect(200, { signedIn: true, displayName: 'Chaiwat' });

    expect(sessionStore.read().accessToken).toBe('at-1');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).code_verifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a callback that does not match a pending transaction', async () => {
    const { app, fetchImpl } = createApp();
    await request(app).post('/api/mittr/auth/start').send({}).expect(200);
    await request(app)
      .post('/api/mittr/auth/callback')
      .send({ url: 'mittrcraft://auth/callback?code=abc' })
      .expect(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('consumes the transaction so a replayed callback fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 2_000_000, subject: { userId: 'u1', displayName: 'C' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { app, openExternal } = createApp({ fetchImpl });
    await request(app).post('/api/mittr/auth/start').send({}).expect(200);
    const url = 'mittrcraft://auth/callback?code=abc';

    await request(app).post('/api/mittr/auth/callback').send({ url }).expect(200);
    await request(app).post('/api/mittr/auth/callback').send({ url }).expect(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('signs out', async () => {
    const sessionStore = memoryStore();
    sessionStore.write({ accessToken: 'at-1', subject: { displayName: 'C' } });
    const { app } = createApp({ sessionStore });
    await request(app).delete('/api/mittr/auth/session').expect(200, { signedIn: false });
    expect(sessionStore.read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- auth-routes
```

Expected: FAIL, cannot resolve `./auth-routes.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { createTransaction, verifyCallback } from './sign-in-transaction.js';

const REDIRECT_URI = 'mittrcraft://auth/callback';

export function registerMittrAuthRoutes(app, {
  brokerBaseUrl,
  sessionStore,
  openExternal,
  fetchImpl = fetch,
}) {
  // One pending transaction at a time. A second sign-in replaces the first,
  // which also means a stale callback can never be redeemed later.
  let pending = null;

  app.post('/api/mittr/auth/start', async (_req, res) => {
    pending = createTransaction();
    const url = new URL('/auth/desktop/start', brokerBaseUrl);
    url.searchParams.set('code_challenge', pending.challenge);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    await openExternal(url.toString());
    return res.json({ started: true });
  });

  app.post('/api/mittr/auth/callback', async (req, res) => {
    if (!pending) return res.status(400).json({ error: 'No sign-in is in progress' });

    let code;
    try {
      ({ code } = verifyCallback(pending, req.body?.url, {}));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const transaction = pending;
    // Consume before the exchange: a code that fails upstream must not be
    // retryable against the same transaction.
    pending = null;

    let response;
    try {
      response = await fetchImpl(new URL('/auth/desktop/exchange', brokerBaseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: transaction.verifier, redirect_uri: REDIRECT_URI }),
      });
    } catch (error) {
      console.error('[mittr] sign-in exchange failed:', error?.message ?? error);
      return res.status(502).json({ error: 'Cannot reach Mittr' });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Mittr rejected the sign-in' });
    }

    const session = await response.json();
    sessionStore.write(session);
    return res.json({ signedIn: true, displayName: session.subject?.displayName ?? '' });
  });

  app.get('/api/mittr/auth/status', (_req, res) => {
    const session = sessionStore.read();
    if (!session) return res.json({ signedIn: false });
    return res.json({ signedIn: true, displayName: session.subject?.displayName ?? '' });
  });

  app.delete('/api/mittr/auth/session', (_req, res) => {
    sessionStore.clear();
    return res.json({ signedIn: false });
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- auth-routes
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/auth-routes.js packages/web/server/lib/mittr/auth-routes.test.js
git commit -m "feat(mittr): sign in through the system browser and store the session"
```

---

### Task 5: The shim uses the session

This removes `MITTRCRAFT_UPSTREAM_TOKEN`, the stand-in plan 1 introduced.

**Files:**
- Modify: `packages/web/server/lib/mittr/shim-routes.js`
- Modify: `packages/web/server/lib/mittr/shim-routes.test.js`
- Modify: `packages/web/server/lib/mittr/upstream-config.js` (drop the token requirement)
- Modify: `packages/web/server/lib/mittr/upstream-config.test.js`
- Modify: `packages/web/server/lib/mittr/index.js`

**Interfaces:**
- Changes: `resolveUpstream(env) -> { baseUrl }`; the `MITTRCRAFT_UPSTREAM_TOKEN` variable no longer exists.
- Changes: `registerMittrShimRoutes(app, { upstream, localToken, sessionStore, fetchImpl })`.

- [ ] **Step 1: Write the failing test**

Replace the forwarding tests in `shim-routes.test.js` with a session-backed
`createApp`, and add the signed-out case:

```javascript
const createApp = (fetchImpl, session = { accessToken: 'at-1' }) => {
  const app = express();
  app.use(express.json());
  registerMittrShimRoutes(app, {
    upstream: { baseUrl: 'https://upstream.test/v1' },
    localToken: 'mc_local_abc',
    sessionStore: { read: () => session, write: () => {}, clear: () => {} },
    fetchImpl,
  });
  return app;
};

it('sends the session token upstream, not a static key', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));
  await request(createApp(fetchImpl))
    .post('/v1/chat/completions')
    .set('authorization', 'Bearer mc_local_abc')
    .send({ model: 'agent-17okpqe', messages: [] })
    .expect(200);
  expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer at-1');
});

it('answers 401 with a sign-in hint when there is no session', async () => {
  const fetchImpl = vi.fn();
  const res = await request(createApp(fetchImpl, null))
    .post('/v1/chat/completions')
    .set('authorization', 'Bearer mc_local_abc')
    .send({ model: 'agent-17okpqe', messages: [] })
    .expect(401);
  expect(res.body.error).toMatch(/sign in/i);
  expect(fetchImpl).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- shim-routes
```

Expected: FAIL, the shim still reads `upstream.token`.

- [ ] **Step 3: Write the implementation**

In `shim-routes.js`, take `sessionStore` in the options, and replace the
`authorization` header construction with a lookup that fails closed:

```javascript
export function registerMittrShimRoutes(app, { upstream, localToken, sessionStore, fetchImpl = fetch }) {
```

and inside the handler, before the fetch:

```javascript
      const session = sessionStore.read();
      if (!session?.accessToken) {
        // The engine has no way to prompt anybody, so the message has to be
        // legible where it surfaces: in the developer's chat window.
        return res.status(401).json({ error: 'Not signed in to Mittr. Sign in to continue.' });
      }
```

then use it:

```javascript
            authorization: `Bearer ${session.accessToken}`,
```

In `upstream-config.js`, delete the `MITTRCRAFT_UPSTREAM_TOKEN` block and its
tests. In `index.js`, pass `sessionStore` through to `registerMittrShimRoutes`.

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- lib/mittr
```

Expected: every `lib/mittr` test passes and no test mentions `MITTRCRAFT_UPSTREAM_TOKEN`.

- [ ] **Step 5: Confirm the variable is gone**

```bash
git grep -n MITTRCRAFT_UPSTREAM_TOKEN || echo "removed"
```

Expected: `removed`.

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/mittr
git commit -m "feat(mittr): authorise upstream calls with the signed-in session"
```

---

### Task 6: Sign-in gate in the UI

**Files:**
- Create: `packages/ui/src/components/mittr/MittrSignInGate.tsx`
- Test: `packages/ui/src/components/mittr/MittrSignInGate.test.tsx`

**Interfaces:**
- Consumes: `GET /api/mittr/auth/status`, `POST /api/mittr/auth/start` (Task 4).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MittrSignInGate } from './MittrSignInGate';

const respondWith = (status: { signedIn: boolean; displayName?: string }) => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/status')) {
      return new Response(JSON.stringify(status), { status: 200 });
    }
    return new Response(JSON.stringify({ started: true }), { status: 200 });
  }) as typeof fetch;
};

beforeEach(() => vi.restoreAllMocks());

describe('MittrSignInGate', () => {
  it('hides the application until the session is known', () => {
    respondWith({ signedIn: false });
    render(<MittrSignInGate><div>workspace</div></MittrSignInGate>);
    expect(screen.queryByText('workspace')).toBeNull();
  });

  it('shows the application once signed in', async () => {
    respondWith({ signedIn: true, displayName: 'Chaiwat' });
    render(<MittrSignInGate><div>workspace</div></MittrSignInGate>);
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());
  });

  it('starts sign-in when the button is pressed', async () => {
    respondWith({ signedIn: false });
    render(<MittrSignInGate><div>workspace</div></MittrSignInGate>);
    await userEvent.click(await screen.findByRole('button', { name: /sign in/i }));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some(([url]) => String(url).includes('/api/mittr/auth/start'))).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/ui test -- MittrSignInGate
```

Expected: FAIL, cannot resolve `./MittrSignInGate`.

- [ ] **Step 3: Write the component**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n';

type Status = { signedIn: boolean; displayName?: string };

export function MittrSignInGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/mittr/auth/status');
    setStatus(await response.json());
  }, []);

  useEffect(() => {
    void refresh();
    // The browser returns focus to the app after the system browser hands the
    // deep link back, which is the moment the session may have appeared.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  if (status?.signedIn) return <>{children}</>;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <p>{t('mittr.signIn.description')}</p>
      <button
        type="button"
        onClick={() => { void fetch('/api/mittr/auth/start', { method: 'POST' }); }}
      >
        {t('mittr.signIn.action')}
      </button>
    </div>
  );
}
```

Add the two message keys to every locale file in
`packages/ui/src/lib/i18n/messages/`. English values:

```
'mittr.signIn.description': 'Sign in with your Mittr account to continue.',
'mittr.signIn.action': 'Sign in with Mittr',
```

Read `packages/ui/src/lib/i18n/messages/en.ts` first and match how that file
imports and exports, and follow the locale-ui-patterns guidance in `.agents/skills/`.

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/ui test -- MittrSignInGate
```

Expected: 3 passing.

- [ ] **Step 5: Mount the gate**

Wrap the application shell in `MittrSignInGate` at the same level the existing
`SessionAuthGate` is mounted. Read
`packages/ui/src/components/auth/SessionAuthGate.tsx` and its mount site first,
and follow that placement rather than inventing a new one.

- [ ] **Step 6: Run the whole suite**

```bash
bun run type-check && bun run lint && bun run test
```

`packages/web/server/lib/github/pr-status.test.js` fails on `develop` already and
is unrelated; everything else must pass.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/mittr packages/ui/src/lib/i18n/messages
git commit -m "feat(mittr): gate the application behind Mittr sign-in"
```

---

---

### Task 7: Refresh, serialised

The access token lasts an hour and refresh rotates both tokens, so a second
refresh started while the first is in flight redeems a token that is already
dead. One in-flight refresh at a time, shared by every caller.

**Files:**
- Modify: `packages/web/server/lib/mittr/auth-routes.js`
- Modify: `packages/web/server/lib/mittr/auth-routes.test.js`

**Interfaces:**
- Produces: `ensureFreshSession() -> Promise<session | null>`, exported from the
  module registering the routes so the shim can call it before forwarding.

- [ ] **Step 1: Write the failing test**

```javascript
it('refreshes once when two callers race', async () => {
  let resolveRefresh;
  const fetchImpl = vi.fn().mockImplementation(() => new Promise((resolve) => {
    resolveRefresh = () => resolve(new Response(JSON.stringify({
      accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 3_600_000,
      subject: { userId: 'u1', displayName: 'C' },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
  }));

  const sessionStore = memoryStore();
  sessionStore.write({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1 });
  const { ensureFreshSession } = buildAuth({ fetchImpl, sessionStore });

  const both = Promise.all([ensureFreshSession(), ensureFreshSession()]);
  resolveRefresh();
  const [first, second] = await both;

  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(first.accessToken).toBe('at-2');
  expect(second.accessToken).toBe('at-2');
});

it('clears the session when the refresh token is rejected', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
  const sessionStore = memoryStore();
  sessionStore.write({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1 });
  const { ensureFreshSession } = buildAuth({ fetchImpl, sessionStore });

  await expect(ensureFreshSession()).resolves.toBeNull();
  expect(sessionStore.read()).toBeNull();
});

it('does not refresh a session that is still valid', async () => {
  const fetchImpl = vi.fn();
  const sessionStore = memoryStore();
  sessionStore.write({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 });
  const { ensureFreshSession } = buildAuth({ fetchImpl, sessionStore });

  await expect(ensureFreshSession()).resolves.toMatchObject({ accessToken: 'at-1' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- auth-routes
```

Expected: FAIL, `ensureFreshSession` is not exported.

- [ ] **Step 3: Write the implementation**

```javascript
  // One in-flight refresh, shared. The broker kills the old refresh token the
  // moment it answers, so a second concurrent call would present a dead token
  // and sign the developer out in the middle of their work.
  let refreshing = null;
  const REFRESH_MARGIN_MS = 60_000;

  const ensureFreshSession = async () => {
    const session = sessionStore.read();
    if (!session?.refreshToken) return session ?? null;
    if (typeof session.expiresAt === 'number' && session.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return session;
    }

    if (!refreshing) {
      refreshing = (async () => {
        try {
          const response = await fetchImpl(new URL('/auth/desktop/refresh', brokerBaseUrl).toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refreshToken }),
          });
          if (!response.ok) {
            sessionStore.clear();
            return null;
          }
          const refreshed = await response.json();
          sessionStore.write(refreshed);
          return refreshed;
        } catch {
          // A network failure is not a rejected token: keep the session and let
          // the caller surface "cannot reach Mittr" instead of signing out.
          return sessionStore.read();
        } finally {
          refreshing = null;
        }
      })();
    }

    return refreshing;
  };
```

Return `ensureFreshSession` from `registerMittrAuthRoutes` and have the shim call
it in place of `sessionStore.read()`.

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- auth-routes
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/auth-routes.js packages/web/server/lib/mittr/auth-routes.test.js
git commit -m "feat(mittr): refresh the session once when callers race"
```


## What this plan leaves to later plans

- **Catalog.** Plan 3. **Audit.** Plan 4. **Updates.** Plan 5.
