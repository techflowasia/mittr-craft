# Loopback Shim Implementation Plan

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a loopback proxy between the embedded engine and Mittr so the engine keeps a credential that never changes while the Mittr session behind it rotates.

**Architecture:** A new route module on the MittrCraft server exposes an OpenAI-compatible endpoint bound to `127.0.0.1`. The engine is configured to use it as a custom provider with a machine-local token. The shim forwards to an upstream base URL, streaming responses through untouched. Plan 2 replaces the temporary upstream credential with a real Mittr session; this plan hardcodes it through configuration so the path can be proven end to end first.

**Tech Stack:** Node ESM, Express 5, vitest, supertest, bun as package manager.

**Spec:** `docs/specs/2026-09-07-mittr-platform-integration.md`

## Global Constraints

- Packaged builds only. No `.env` a developer edits; configuration ships in the build or is fetched at runtime. (spec §4.1)
- The platform key never leaves Mittr. Nothing in this repository may store it. (spec §4.2)
- The engine is never patched or forked. (spec §4.4)
- The shim binds loopback only; any other bind address fails at startup. (spec §11.1)
- Everything committed to this repository is written in English. Thai appears only in UI strings.
- No mention of AI assistants in commit messages, file contents, or documentation.
- Run commands with `bun`, never `npm` or `pnpm`.

---

### Task 0: Prove the gateway can call tools

This is the gate the spec puts before all other work (spec §12). Its output is an
answer, not code. Anything written here is throwaway and must not be committed.

**Files:**
- Create (throwaway, delete when done): `/tmp/tool-probe.mjs`

- [ ] **Step 1: Write the probe**

```javascript
// Throwaway. Do not commit.
const BASE = process.env.PROBE_BASE_URL;   // e.g. https://llm-dev.mittr.asia/v1
const KEY = process.env.PROBE_API_KEY;
const MODEL = process.env.PROBE_MODEL;     // mittr-craft-1-0

const body = {
  model: MODEL,
  messages: [{ role: 'user', content: 'What is in the file src/index.js? Use the tool.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the project',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  }],
  tool_choice: 'auto',
  max_tokens: 256,
};

const res = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify(body),
});

const json = await res.json();
const message = json.choices?.[0]?.message ?? {};
console.log('status        ', res.status);
console.log('tool_calls    ', JSON.stringify(message.tool_calls ?? null));
console.log('content       ', JSON.stringify(message.content ?? null));
```

- [ ] **Step 2: Run it against the real gateway**

```bash
PROBE_BASE_URL=... PROBE_API_KEY=... PROBE_MODEL=mittr-craft-1-0 node /tmp/tool-probe.mjs
```

Expected: `tool_calls` is a non-empty array naming `read_file`.

- [ ] **Step 3: Judge the result**

Three outcomes, and only the first lets this plan continue:

- `tool_calls` populated → the design holds. Continue to Task 1.
- `tool_calls` empty **and** `content` contains raw markup such as
  `<|tool_call>` or `<function=` → the gateway's tool parser does not match the
  model. This is the silent failure the spec calls out (§9.2). **Stop.** The fix
  is on the gateway (`--tool-call-parser`), not in this repository. Report it and
  wait.
- Any non-200 status → report the status and body. A 403 `agent_not_granted`
  means the key lacks the `mittr-craft-1-0` grant and an admin must extend it.

- [ ] **Step 4: Delete the probe**

```bash
rm /tmp/tool-probe.mjs
```

Nothing is committed by this task.

---

### Task 1: Upstream configuration

**Files:**
- Create: `packages/web/server/lib/mittr/upstream-config.js`
- Test: `packages/web/server/lib/mittr/upstream-config.test.js`

**Interfaces:**
- Produces: `resolveUpstream(env) -> { baseUrl: string, token: string }`, throws
  `Error` when configuration is absent or malformed.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { resolveUpstream } from './upstream-config.js';

describe('resolveUpstream', () => {
  it('returns the configured upstream', () => {
    expect(resolveUpstream({
      MITTRCRAFT_UPSTREAM_URL: 'https://llm-dev.mittr.asia/v1',
      MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test',
    })).toEqual({ baseUrl: 'https://llm-dev.mittr.asia/v1', token: 'sk-test' });
  });

  it('strips a trailing slash so path joining stays predictable', () => {
    expect(resolveUpstream({
      MITTRCRAFT_UPSTREAM_URL: 'https://llm-dev.mittr.asia/v1/',
      MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test',
    }).baseUrl).toBe('https://llm-dev.mittr.asia/v1');
  });

  it('fails closed when the url is missing', () => {
    expect(() => resolveUpstream({ MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test' }))
      .toThrow(/MITTRCRAFT_UPSTREAM_URL/);
  });

  it('fails closed when the token is missing', () => {
    expect(() => resolveUpstream({ MITTRCRAFT_UPSTREAM_URL: 'https://x/v1' }))
      .toThrow(/MITTRCRAFT_UPSTREAM_TOKEN/);
  });

  it('rejects a non-https upstream that is not loopback', () => {
    expect(() => resolveUpstream({
      MITTRCRAFT_UPSTREAM_URL: 'http://llm-dev.mittr.asia/v1',
      MITTRCRAFT_UPSTREAM_TOKEN: 'sk-test',
    })).toThrow(/https/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- upstream-config
```

Expected: FAIL, cannot resolve `./upstream-config.js`.

- [ ] **Step 3: Write the implementation**

```javascript
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Configuration is absent far more often than it is wrong, and a shim that
// starts without an upstream would fail later inside a request, where the
// message reaches a developer as an unexplained model error.
export function resolveUpstream(env = process.env) {
  const rawUrl = String(env.MITTRCRAFT_UPSTREAM_URL ?? '').trim();
  if (!rawUrl) throw new Error('MITTRCRAFT_UPSTREAM_URL is required');

  const token = String(env.MITTRCRAFT_UPSTREAM_TOKEN ?? '').trim();
  if (!token) throw new Error('MITTRCRAFT_UPSTREAM_TOKEN is required');

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`MITTRCRAFT_UPSTREAM_URL is not a valid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`MITTRCRAFT_UPSTREAM_URL must use https outside loopback: ${rawUrl}`);
  }

  return { baseUrl: rawUrl.replace(/\/+$/, ''), token };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- upstream-config
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/upstream-config.js packages/web/server/lib/mittr/upstream-config.test.js
git commit -m "feat(mittr): resolve and validate the upstream configuration"
```

---

### Task 2: Loopback bind guard

**Files:**
- Create: `packages/web/server/lib/mittr/loopback-guard.js`
- Test: `packages/web/server/lib/mittr/loopback-guard.test.js`

**Interfaces:**
- Produces: `assertLoopbackHost(host) -> void`, throws `Error` for any host that
  is not loopback.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { assertLoopbackHost } from './loopback-guard.js';

describe('assertLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('accepts %s', (host) => {
    expect(() => assertLoopbackHost(host)).not.toThrow();
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'mittr.asia', ''])('rejects %s', (host) => {
    expect(() => assertLoopbackHost(host)).toThrow(/loopback/);
  });

  it('rejects a host that merely looks loopback', () => {
    expect(() => assertLoopbackHost('127.0.0.1.evil.example')).toThrow(/loopback/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- loopback-guard
```

Expected: FAIL, cannot resolve `./loopback-guard.js`.

- [ ] **Step 3: Write the implementation**

```javascript
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// A shim reachable off-host hands every machine on the network a free,
// authenticated route into Mittr, and the audit trail credits whoever owns the
// machine it ran on. Refusing to start is the only safe response.
export function assertLoopbackHost(host) {
  const normalized = String(host ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(`The Mittr shim may only bind a loopback address, refusing: ${host}`);
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- loopback-guard
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/loopback-guard.js packages/web/server/lib/mittr/loopback-guard.test.js
git commit -m "feat(mittr): refuse to bind the shim off loopback"
```

---

### Task 3: Machine-local token

**Files:**
- Create: `packages/web/server/lib/mittr/local-token.js`
- Test: `packages/web/server/lib/mittr/local-token.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ensureLocalToken({ tokenPath, fsImpl, randomBytes }) -> string`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLocalToken } from './local-token.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-token-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureLocalToken', () => {
  it('creates a token on first call', () => {
    const token = ensureLocalToken({ tokenPath: path.join(dir, 'shim-token') });
    expect(token).toMatch(/^mc_local_[0-9a-f]{64}$/);
  });

  it('returns the same token on the next call', () => {
    const tokenPath = path.join(dir, 'shim-token');
    expect(ensureLocalToken({ tokenPath })).toBe(ensureLocalToken({ tokenPath }));
  });

  it('writes the file owner-readable only', () => {
    const tokenPath = path.join(dir, 'shim-token');
    ensureLocalToken({ tokenPath });
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('replaces a corrupted token file instead of failing', () => {
    const tokenPath = path.join(dir, 'shim-token');
    fs.writeFileSync(tokenPath, 'not-a-token');
    expect(ensureLocalToken({ tokenPath })).toMatch(/^mc_local_/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- local-token
```

Expected: FAIL, cannot resolve `./local-token.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import nodeFs from 'node:fs';
import nodeCrypto from 'node:crypto';
import path from 'node:path';

const TOKEN_PATTERN = /^mc_local_[0-9a-f]{64}$/;

// This token authorises the engine to reach the server running beside it on the
// same machine. It carries no authority at Mittr, which is why regenerating it
// after corruption is safe: the engine is reconfigured from the same process
// that writes it.
export function ensureLocalToken({
  tokenPath,
  fsImpl = nodeFs,
  randomBytes = nodeCrypto.randomBytes,
}) {
  try {
    const existing = fsImpl.readFileSync(tokenPath, 'utf8').trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
  } catch {
    // Missing or unreadable: fall through and mint a new one.
  }

  const token = `mc_local_${randomBytes(32).toString('hex')}`;
  fsImpl.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fsImpl.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fsImpl.chmodSync(tokenPath, 0o600);
  return token;
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- local-token
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/local-token.js packages/web/server/lib/mittr/local-token.test.js
git commit -m "feat(mittr): mint and persist the machine-local shim token"
```

---

### Task 4: Shim route, non-streaming

**Files:**
- Create: `packages/web/server/lib/mittr/shim-routes.js`
- Test: `packages/web/server/lib/mittr/shim-routes.test.js`

**Interfaces:**
- Consumes: `resolveUpstream` (Task 1), `ensureLocalToken` (Task 3).
- Produces: `registerMittrShimRoutes(app, { upstream, localToken, fetchImpl })`,
  where `upstream` is the `{ baseUrl, token }` object Task 1 returns.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerMittrShimRoutes } from './shim-routes.js';

const createApp = (fetchImpl) => {
  const app = express();
  app.use(express.json());
  registerMittrShimRoutes(app, {
    upstream: { baseUrl: 'https://upstream.test/v1', token: 'sk-upstream' },
    localToken: 'mc_local_abc',
    fetchImpl,
  });
  return app;
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

describe('mittr shim routes', () => {
  it('rejects a request without the local token', async () => {
    const fetchImpl = vi.fn();
    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .send({ model: 'mittr-craft-1-0', messages: [] })
      .expect(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards an authorised request and swaps in the upstream credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));

    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [{ role: 'user', content: 'hi' }] })
      .expect(200, { choices: [] });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://upstream.test/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-upstream');
    expect(JSON.parse(init.body).model).toBe('mittr-craft-1-0');
  });

  it('never leaks the local token upstream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));
    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [] });
    expect(JSON.stringify(fetchImpl.mock.calls[0][1])).not.toContain('mc_local_abc');
  });

  it('passes an upstream failure through with its status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'agent_not_granted' }, 403)
    );
    await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [] })
      .expect(403, { error: 'agent_not_granted' });
  });

  it('reports an unreachable upstream as 502, not 500', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [] })
      .expect(502);
    expect(res.body.error).toMatch(/Mittr/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- shim-routes
```

Expected: FAIL, cannot resolve `./shim-routes.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import express from 'express';

const bearerOf = (header) => {
  const value = String(header ?? '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
};

export function registerMittrShimRoutes(app, { upstream, localToken, fetchImpl = fetch }) {
  const requireLocalToken = (req, res, next) => {
    if (bearerOf(req.headers.authorization) !== localToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };

  app.post(
    '/v1/chat/completions',
    requireLocalToken,
    express.json({ limit: '32mb' }),
    async (req, res) => {
      let upstreamResponse;
      try {
        // The local token authenticates the engine to this process and stops
        // here. Only the upstream credential travels onward.
        upstreamResponse = await fetchImpl(`${upstream.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${upstream.token}`,
          },
          body: JSON.stringify(req.body),
        });
      } catch (error) {
        console.error('[mittr] upstream request failed:', error?.message ?? error);
        return res.status(502).json({ error: 'Cannot reach Mittr' });
      }

      const text = await upstreamResponse.text();
      res.status(upstreamResponse.status);
      res.setHeader('content-type', upstreamResponse.headers.get('content-type') ?? 'application/json');
      return res.send(text);
    }
  );
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- shim-routes
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/shim-routes.js packages/web/server/lib/mittr/shim-routes.test.js
git commit -m "feat(mittr): forward chat completions through the loopback shim"
```

---

### Task 5: Shim route, streaming

A buffered shim makes the agent look frozen and delivers every tool call in one
late burst (spec §6.1). This task proves bytes leave as they arrive.

**Files:**
- Modify: `packages/web/server/lib/mittr/shim-routes.js`
- Modify: `packages/web/server/lib/mittr/shim-routes.test.js`

**Interfaces:**
- Consumes: `registerMittrShimRoutes` (Task 4). Signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `shim-routes.test.js`:

```javascript
const sseResponse = (chunks) => new Response(
  new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

describe('mittr shim streaming', () => {
  it('passes server-sent events through and keeps their order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));

    const res = await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [], stream: true })
      .expect(200);

    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text.indexOf('"he"')).toBeLessThan(res.text.indexOf('"llo"'));
    expect(res.text).toContain('data: [DONE]');
  });

  it('disables buffering so a proxy in front cannot re-buffer the stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    const res = await request(createApp(fetchImpl))
      .post('/v1/chat/completions')
      .set('authorization', 'Bearer mc_local_abc')
      .send({ model: 'mittr-craft-1-0', messages: [], stream: true })
      .expect(200);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['x-accel-buffering']).toBe('no');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- shim-routes
```

Expected: FAIL on the content type, because the non-streaming path returns JSON.

- [ ] **Step 3: Write the implementation**

In `shim-routes.js`, replace the block that begins `const text = await upstreamResponse.text();`
with:

```javascript
      const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json';
      const isStream = Boolean(req.body?.stream) && upstreamResponse.body;

      if (!isStream) {
        const text = await upstreamResponse.text();
        res.status(upstreamResponse.status);
        res.setHeader('content-type', contentType);
        return res.send(text);
      }

      res.status(upstreamResponse.status);
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      // Anything that buffers this stream turns a live agent into a long pause
      // followed by a wall of text.
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();

      try {
        for await (const chunk of upstreamResponse.body) {
          res.write(chunk);
        }
      } catch (error) {
        console.error('[mittr] upstream stream failed:', error?.message ?? error);
      }
      return res.end();
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- shim-routes
```

Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/mittr/shim-routes.js packages/web/server/lib/mittr/shim-routes.test.js
git commit -m "feat(mittr): stream completions through the shim without buffering"
```

---

### Task 6: Start the shim and point the engine at it

**Files:**
- Create: `packages/web/server/lib/mittr/index.js`
- Test: `packages/web/server/lib/mittr/index.test.js`
- Modify: `packages/web/server/index.js` (import and call `startMittrShim`)

**Interfaces:**
- Consumes: `resolveUpstream` (Task 1), `assertLoopbackHost` (Task 2),
  `ensureLocalToken` (Task 3), `registerMittrShimRoutes` (Tasks 4-5).
- Produces: `startMittrShim({ app, host, port, tokenPath, env }) -> { localToken, baseUrl }`.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMittrShim } from './index.js';

let dir;
const env = {
  MITTRCRAFT_UPSTREAM_URL: 'https://upstream.test/v1',
  MITTRCRAFT_UPSTREAM_TOKEN: 'sk-upstream',
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mittr-shim-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('startMittrShim', () => {
  it('returns the local token and the loopback base url', () => {
    const result = startMittrShim({
      app: express(),
      host: '127.0.0.1',
      port: 3902,
      tokenPath: path.join(dir, 'shim-token'),
      env,
    });
    expect(result.localToken).toMatch(/^mc_local_/);
    expect(result.baseUrl).toBe('http://127.0.0.1:3902/v1');
  });

  it('refuses to start when the host is not loopback', () => {
    expect(() => startMittrShim({
      app: express(),
      host: '0.0.0.0',
      port: 3902,
      tokenPath: path.join(dir, 'shim-token'),
      env,
    })).toThrow(/loopback/);
  });

  it('refuses to start when the upstream is unconfigured', () => {
    expect(() => startMittrShim({
      app: express(),
      host: '127.0.0.1',
      port: 3902,
      tokenPath: path.join(dir, 'shim-token'),
      env: {},
    })).toThrow(/MITTRCRAFT_UPSTREAM_URL/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/web test -- lib/mittr/index
```

Expected: FAIL, cannot resolve `./index.js`.

- [ ] **Step 3: Write the implementation**

```javascript
import { resolveUpstream } from './upstream-config.js';
import { assertLoopbackHost } from './loopback-guard.js';
import { ensureLocalToken } from './local-token.js';
import { registerMittrShimRoutes } from './shim-routes.js';

// Both guards run before a single route is mounted, so a misconfigured install
// fails at startup where somebody is watching, rather than inside the first
// request where it reaches a developer as an unexplained model error.
export function startMittrShim({ app, host, port, tokenPath, env = process.env }) {
  assertLoopbackHost(host);
  const upstream = resolveUpstream(env);
  const localToken = ensureLocalToken({ tokenPath });

  registerMittrShimRoutes(app, { upstream, localToken });

  return { localToken, baseUrl: `http://${host}:${port}/v1` };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/web test -- lib/mittr/index
```

Expected: 3 passing.

- [ ] **Step 5: Wire it into the server**

`packages/web/server/index.js` already defines the data directory at line 291:

```javascript
const MITTRCRAFT_DATA_DIR = process.env.MITTRCRAFT_DATA_DIR
```

The bind host and port are not module-level constants. They are resolved inside
the server start function around line 1321:

```javascript
const port = Number.isFinite(options.port) && options.port >= 0 ? Math.trunc(options.port) : DEFAULT_PORT;
const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : undefined;
```

so the shim must start inside that function, after `port` and `host` are
assigned and before the server listens. Add the import beside the other
`./lib/**` imports at the top of the file:

```javascript
import { startMittrShim } from './lib/mittr/index.js';
```

and the call after those two lines:

```javascript
const mittrShim = startMittrShim({
  app,
  host: host || '127.0.0.1',
  port,
  tokenPath: path.join(MITTRCRAFT_DATA_DIR, 'mittr-shim-token'),
});
```

`host` is `undefined` when no bind address was requested, and the server's own
default is loopback, so the fallback above matches existing behaviour rather than
widening it. If `host` is set to anything non-loopback, `assertLoopbackHost`
throws here and the process exits — which is the intent of spec §11.1.

- [ ] **Step 6: Register the shim as an engine provider**

Two different stores are involved, and they are not the same call.

The provider *config* goes through `PUT /api/provider`, whose handler at
`packages/web/server/lib/opencode/routes.js:586` reads `providerID`, `config` and
`scope` — not a flat object:

```javascript
await fetch(`http://127.0.0.1:${port}/api/provider`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    providerID: 'mittr',
    scope: 'user',
    config: {
      name: 'Mittr',
      options: { baseURL: mittrShim.baseUrl },
      models: { 'mittr-craft-1-0': { name: 'MittrCraft 1.0' } },
    },
  }),
});
```

The *credential* is stored separately. `packages/web/server/lib/opencode/auth.js`
exports `readAuthFile` and `writeAuthFile` but no setter, so read, mutate, write:

```javascript
import { readAuthFile, writeAuthFile } from './lib/opencode/auth.js';

const auth = readAuthFile();
auth.mittr = { type: 'api', key: mittrShim.localToken };
writeAuthFile(auth);
```

`writeAuthFile` already writes with mode `0600` and keeps a backup, so no file
permission handling belongs here.

The token written here is the machine-local one. The engine may hold it forever
because it grants nothing outside this machine, which is the whole reason the
shim exists (spec §6.1).

- [ ] **Step 7: Verify against the real gateway**

Start the app with the upstream pointed at the gateway and the same key used in
Task 0:

```bash
MITTRCRAFT_UPSTREAM_URL=... MITTRCRAFT_UPSTREAM_TOKEN=... bun run dev
```

Open a real repository, select the Mittr provider, and give an instruction that
must edit a file. Confirm the file actually changed on disk. A 200 response is
not the result (spec §12).

- [ ] **Step 8: Run the whole suite**

```bash
bun run type-check && bun run lint && bun run test
```

`packages/web/server/lib/github/pr-status.test.js` fails on `develop` already and
is unrelated to this work; every other test must pass.

- [ ] **Step 9: Commit**

```bash
git add packages/web/server/lib/mittr/index.js packages/web/server/lib/mittr/index.test.js packages/web/server/index.js
git commit -m "feat(mittr): start the shim and register it as the engine provider"
```

---

## What this plan deliberately leaves to later plans

- **Sign-in.** `MITTRCRAFT_UPSTREAM_TOKEN` is a temporary stand-in so the data
  path can be proven before the session work begins. Plan 2 replaces it with a
  Mittr session and removes the variable.
- **Catalog.** The model list registered in Task 6 is hardcoded to
  `mittr-craft-1-0`. Plan 3 replaces it with the catalog the broker serves.
- **Audit.** Plan 4.
- **Updates.** Plan 5.
