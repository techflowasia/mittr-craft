# Upstream Rebase — Phase 2: Sign-in, Accounts, Models, Quota — Implementation Plan

**Goal:** A MittrCraft Dev build on upstream 2.1.1 that signs in to Mittr (several accounts, switch, sign out), answers chats only through Mittr models from the catalog, shows and enforces the weekly quota as 1.22 does, keeps the hosted-web AD/Entra login and the audit routes, and starts one engine.

**Architecture:** Everything Mittr lives in `packages/mittr-server` (in-process server plugin), `packages/mittr-ui` (UI plugin) and a new `packages/mittr-opencode` (the engine plugin source), and reaches upstream through generic hooks:
- a widened server-plugin context, plus a managed-config contributor;
- Electron host services: a secret store and a deep-link handler registry;
- a UI root wrapper and named slots;
- quota provider registration, server and UI;
- a UI-auth provider registry.

The Mittr provider, the provider lock and the identity plugin are written into upstream's watched `opencode.managed.json`. The engine calls a loopback OpenAI-compatible shim that forwards to the Mittr platform with the signed-in account's token.

**Tech Stack:**
- Bun workspaces (installed bun 1.3.14 per R3; the base declares 1.4.2), Node ≥ 22 via `nvm use` (R4).
- Electron 43 + electron-builder 26, React/Vite UI (`bun:test` through `scripts/run-isolated-tests.mjs`).
- Web server tests in vitest, `packages/mittr-*` server tests in `node:test`.
- OpenCode 2.0.22 (bundled CLI, `@opencode/client` 2.0.22).
- Mittr platform NestJS routes under `/auth/desktop/*`, `/desktop/*`, `/api/quota/me` and `/v1/*`.

**Spec:** `docs/specs/2026-10-16-upstream-rebase-design.md` and `docs/plans/2026-10-17-feature-inventory.md` §2

## Global Constraints

- Branch `rebase/upstream-2.1.1` in `~/Documents/mittr-craft/.worktrees/rebase-2x`. Upstream base `e302062e3` (`brand/UPSTREAM`). Never touch the main checkout, other worktrees, `develop`, `main` or any remote. **No push.**
- Run every node/bun command after `source ~/.nvm/nvm.sh && nvm use` in the worktree (R4). Use the installed bun 1.3.14 and do not install another (R3).
- Files we own: `packages/mittr-*/**`, `brand/**`, `scripts/mittr/**`, `patches/**`, `docs/**`. Everything else is upstream.
- Every commit that edits an upstream file has subject `hook(<name>): …` and a body with one paragraph saying why. The hook names no Mittr concept, keeps upstream behaviour when unused, and has one call site.
- Upstream-file budget:
  - The cap is 40 (R35/R36). It is 20 counted today.
  - New generic upstream-side files (for example `server-plugins.js`, `product-plugins.ts`, the new `packages/electron/secret-store.mjs`) are reviewed as hooks and not counted.
  - Test files that travel with a hook are listed, not counted (R25). `bun.lock` counts and is re-resolved, never hand-merged (R15).
- Every new upstream module or symbol mittr-server or mittr-ui relies on gets an entry in `packages/mittr-server/src/upstream-contract.js` and its check in `upstream-contract.test.js`, in the task that starts relying on it.
- Do not add dependencies, with one named exception that needs the owner's word: `ldapjs@^3.0.7` in `packages/mittr-server` for AD/LDAP (Task 25). `jose` is already an upstream dependency.
- Do not run the engine binary without temp `XDG_*` and `HOME` (phase-1 incident: `opencode --version` wrote to the real `~/.local/share/opencode/log`).
- **Safety, every runtime check:**
  - Never open, signal, drive or replace the owner's running `/Applications/MittrCraft.app`, nor the installed MittrCraft Dev 1.x.
  - Never write to `~/.config/mittrcraft*`, `~/.local/{share,state}/mittrcraft`, `~/.cache/mittrcraft`, `~/.config/openchamber`, `~/.local/share/opencode`, `~/.config/opencode` or `~/Library/Application Support/{MittrCraft,MittrCraft Dev,OpenChamber}`.
  - Launches are isolated: a fresh `mktemp -d "$TMPDIR/p2.XXXX"` HOME, `OPENCHAMBER_DESKTOP_USER_DATA_DIR=<temp>/userData`, the Dev binary launched directly, and quit with `kill -TERM <recorded pid>`.
  - Never click "Open MittrCraft Dev" on a browser prompt: LaunchServices may hand the link to the installed 1.x Dev, which registers the same scheme.
- Platform:
  - Dev product points at `https://api-dev.mittr.asia` by default. An env `MITTRCRAFT_BROKER_URL` still overrides it in Dev (R41).
  - Prod is fixed to `https://api.mittr.asia`, and no override is honoured in prod (R41).
  - No platform change is planned. Every route below exists on platform `main` and `develop` (inventory §2).
- Sign-in redirect URIs (platform allowlist `DESKTOP_REDIRECT_URIS`, exact match): `mittrcraft://auth/callback` (prod) and `mittrcraft-dev://auth/callback` (Dev).
- Platform token lifetimes: access 3600 s, refresh 30 days, both rotated on refresh (`POST /auth/desktop/refresh` returns new `accessToken` and `refreshToken`).
- Refresh margin `REFRESH_MARGIN_MS = 60_000`. Sign-in transaction TTL `TRANSACTION_TTL_MS = 600_000`.
- Provider id `mittr`, display name `Mittr`. Engine package `aisdk:@ai-sdk/openai-compatible`.
- The shim's base URL is `http://127.0.0.1:<server port>/mittr-shim/v1`. It sits outside `/api` on purpose, because the engine carries no UI session. It is guarded by the loopback peer check and the local token `mc_local_<64 hex>` in `<dataDir>/mittr-shim-token` (mode 0600).
- Provider lock:
  - Switch OFF (default): `experimental.policies: [{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'mittr',effect:'allow'}]`, and the picker shows only `mittr`.
  - Switch ON (R37/R40): no policies, and the picker shows every provider.
  - The switch is persisted as `settings.mittr.showOtherProviders` (boolean, default `false`).
- Quota refusal sent to the engine:
  - HTTP 402, header `x-should-retry: false`.
  - Body `{error:{type:'insufficient_quota',code:'llm_quota_exhausted',message:'Weekly model quota used up',kind,resets_at}}`.
  - The engine skips the retry when `x-should-retry` is `false`, and classifies `insufficient_quota` as a quota error (read from the 2.0.22 binary; proven in Task 2).
- The engine sends `x-opencode-session-id: <session id>` on every provider request. Answered-by records are keyed by it, with `x-session-id` as the fallback.
- Test accounts (inventory): A, B, Q on the dev platform. The tester needs a real Microsoft sign-in, and only Task 15 and Task 29 have a marked interactive step for it.
- Drop nothing (decision 4). Send no data to a third party by default (R30/R39).
- R37/R40, R38 and R39 bind. Q3 (multi-Plane on prod) and Q6 (`.openchamber/`) stay open and do not block this phase.

## Review Focus

1. **A sign-in callback that should not be honoured.** Cases: a callback with no sign-in pending, a replayed code, a callback for the other flavor's scheme, or an unrelated deep link (pairing `connect`) caught by the new registry.
   - Task 6 `callback with no pending transaction is refused and nothing is exchanged`, `a second callback for a spent transaction is refused`, `callback on the wrong scheme is refused`.
   - Task 4 `an unregistered host falls through to upstream dispatch` and `connect links are never offered to registered handlers`.
2. **Rotated refresh tokens under concurrency.** Two requests near expiry must not both refresh, because the second would present a dead token and sign the person out. A 401 for an inactive account must not sign out the active one.
   - Task 6 `concurrent ensureFreshSession calls share one refresh request`.
   - Task 16 `a refused refresh of an inactive account leaves the active account signed in`.
3. **A quota refusal that makes the engine spin.** Covers the pre-stream 429, the mid-stream SSE frame, and the flat `QuotaExhaustedFilter` body.
   - Task 22 `pre-stream 429 becomes 402 with x-should-retry false`, `mid-stream quota frame is rewritten and the stream ends`, `flat filter body is recognised`.
   - Task 29 counts exactly one platform call per refused turn.
4. **Two engines at startup.** This happens when the catalog sync or the account env asks for a restart while the first start is still spawning.
   - Task 5 `a restart requested during the first start leaves exactly one live process`.
   - Task 29 runs it five times with `pgrep`.
5. **A catalog that is empty, withdrawn, offline or corrupt.** The picker must still show the last list. A default model must never point at a withdrawn agent. A default on another provider is never changed.
   - Task 11 `offline start applies the cached catalog`, `corrupt cache is ignored with one warning`, `empty models remove the provider's models but keep the cache shape`.
   - Task 12 `withdrawn default moves to the next agent`, `default on another provider is untouched`.

---

### Task 1: Raise the upstream-touch cap to 40 with a reviewed hook list

**Files:**
- Create: `brand/upstream-hooks.json`
- Modify: `scripts/mittr/check-upstream-touch.mjs`
- Test: `scripts/mittr/check-upstream-touch.test.mjs`

**Interfaces:**
- Produces:
  - `UPSTREAM_TOUCH_CAP = 40`.
  - `brand/upstream-hooks.json`: `{ "<upstream path>": { "hook": "<name>", "why": "<one sentence>" } }`, one entry per counted file, `bun.lock` included.
  - `checkUpstreamTouch({ cwd, write, cap, acknowledged, hooks })` adds `unlisted: string[]` (counted files with no entry) and `stale: string[]` (entries for files no longer touched). `ok` also requires both to be empty.
  - The report prints `upstream files touched: N of 40`, then each file with its `hook` and `why`.

- [ ] **Step 1:** Write the failing tests in `check-upstream-touch.test.mjs` (fixture repo helpers already there):
  - `the cap is 40`: `assert.equal(UPSTREAM_TOUCH_CAP, 40)`.
  - `a counted file missing from the hook list fails`: fixture touches `packages/web/b.js` with `hooks = {}`. Expect `result.unlisted` to deep-equal `['packages/web/b.js']` and `result.ok === false`.
  - `a listed file no longer touched is reported stale`: `hooks = { 'packages/web/gone.js': { hook: 'x', why: 'y' } }`. Expect `result.stale` to deep-equal `['packages/web/gone.js']` and `result.ok === false`.
  - `the report names each file's hook and reason`: the output contains `packages/web/b.js — hook(a): let a be configured`.
- [ ] **Step 2:** `node --test scripts/mittr/check-upstream-touch.test.mjs`. Expected: 4 new failures, the rest pass.
- [ ] **Step 3:** Implement:
  - Read `brand/upstream-hooks.json` (default `hooks` param) and add the two lists.
  - Seed the file with today's 20 counted files. Take each `hook` from the subject of the commit that touched the file and each `why` from its body's first sentence.
  - Keep `ACKNOWLEDGED_COMMITS`.
- [ ] **Step 4:** Run the test, then `node scripts/mittr/check-upstream-touch.mjs --no-write`. Expected: PASS, `20 of 40`, no unlisted, no stale.
- [ ] **Step 5:** Commit `feat(mittr): upstream touch cap 40 with a reviewed reason per file`.

Upstream files added: 0. Running total: 20.

### Task 2: Prove what OpenCode 2.0.22 does with our provider, policy, plugin and refusal (spike)

**Files:**
- Create:
  - `scripts/mittr/probe-engine-v2.mjs` (with `scripts/mittr/probe-engine-v2.test.mjs` for its pure helpers);
  - `docs/plans/2026-10-17-phase-2-engine-proof.md`.

The binary was read, not run. Before anything is built on them, these facts need a live engine: the hook names, the retry classifier, the session headers, and the `experimental.policies` shape (the engine's own translation of `enabled_providers` is `[deny *, allow <id>]`).

**Interfaces:**
- Produces the CLI `node scripts/mittr/probe-engine-v2.mjs --json <out>`. It:
  - creates a temp HOME;
  - starts a stub OpenAI-compatible server on `127.0.0.1:<random>` that records each request's headers and body and answers per scenario;
  - writes a temp managed config: provider `stub` (`package:'aisdk:@ai-sdk/openai-compatible'`, `settings:{baseURL:'http://127.0.0.1:<port>/v1'}`, one model `m1`), plus a second provider `other`;
  - starts `packages/electron/resources/opencode-cli/opencode serve` with all four `XDG_*` and `OPENCODE_CONFIG` inside the temp HOME, a random port and password;
  - drives sessions through `@opencode/client`;
  - deletes the temp HOME on exit.
- Pure helpers, tested: `policiesFor({ showOtherProviders: boolean, providerId: string }) -> Array<{action,resource,effect}>`, and `quotaRefusal({ kind, resetsAt }) -> { status: 402, headers: { 'x-should-retry': 'false' }, body }`. Tasks 13 and 22 import these two from `packages/mittr-server/src/mittr/` and move them there.

- [ ] **Step 1:** Write the failing helper tests:
  - `policiesFor locks to one provider`:
    - `policiesFor({showOtherProviders:false, providerId:'mittr'})` deep-equals `[{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'mittr',effect:'allow'}]`;
    - `policiesFor({showOtherProviders:true, providerId:'mittr'})` deep-equals `[]`.
  - `quotaRefusal carries the no-retry header`: status `402`, `headers['x-should-retry'] === 'false'`, `body.error.code === 'llm_quota_exhausted'`, `body.error.type === 'insufficient_quota'`, `body.error.resets_at === '2026-10-19T17:00:00.000Z'` for `resetsAt '2026-10-20T00:00:00+07:00'`.
- [ ] **Step 2:** `node --test scripts/mittr/probe-engine-v2.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the helpers and the probe with six scenarios. For each, record the observation and PASS or FAIL in the JSON:
  - **P1 headers:** one prompt. The stub saw `x-opencode-session-id` equal to the session id, and `x-session-id`.
  - **P2 refusal:**
    - The stub answers `quotaRefusal(...)` to the first call.
    - Expect exactly 1 stub request within 20 s.
    - The session status returns to `idle` within 2 s of the refusal, with no `retry` status seen.
    - The assistant message `error.status === 402` and `error.response.body` contains `llm_quota_exhausted`.
  - **P3 identity:**
    - Add a directory plugin built from Task 14's `identityPluginSource()`; until Task 14 exists, the probe carries an inline copy of the same source.
    - The plugin registers `ctx.session.hook('context'|'generate'|'compaction', …)`.
    - The stub's received system message contains `You are MittrCraft`, and contains neither `You are opencode` nor `You are OpenCode`.
  - **P4 policy:**
    - Run with `experimental.policies = policiesFor({showOtherProviders:false, providerId:'stub'})`.
    - A prompt forced to `other/m1` is refused (no request reaches `other`'s stub), and `stub/m1` answers.
    - Repeat with `[]`: both answer.
  - **P5 hot reload:**
    - Rewrite the managed file adding model `m2` to `stub`. Within 10 s `GET /api/model` lists `stub/m2`, with no restart.
    - Then rewrite the policies to `[]` and expect P4's `other` prompt to answer within 10 s.
  - **P6 credential:**
    - `POST /api/integration/stub/connect/key {key:'k-123'}`. The next stub request has `authorization: Bearer k-123`.
    - Restart the engine on the same XDG: still sent.
- [ ] **Step 4:** Run `node scripts/mittr/probe-engine-v2.mjs --json $TMPDIR/probe.json`. Record the results in the proof note. **Stop conditions, binding on later tasks:**
  - P1 fails: Task 23 keys answered-by on whichever header the stub saw, and the note records it.
  - P2 fails (more than one request): add `ctx.session.hook('retry', e => { if (String(e.error?.response?.body ?? '').includes('llm_quota_exhausted')) e.decision = { retry: false } }, { providerID: 'mittr' })` to the identity plugin and re-run P2. If it still retries, **stop and report**: a refused turn would burn calls.
  - P3 fails (the hook is not offered to external plugins, or `system` cannot be rewritten): Task 14 switches to its named fallback, the shim rewriting the first system message. The note flags this to the owner.
  - P4 fails: **stop and report**. Anti-goal: data reaching a non-Mittr provider.
  - P5 fails for providers or policies: Tasks 10 and 13 call `context.opencode.refresh(reason)` after each managed-config write. The note records the restart cost.
  - P6 fails: Task 10 uses `settings.apiKey: '{env:MITTRCRAFT_SHIM_TOKEN}'`, with the token added through `engineEnv()`. The note records why the credential API was not used.
- [ ] **Step 5:** Commit `docs(mittr): record how OpenCode 2.0.22 treats our provider, policy, plugin and refusal`, with the script.

Upstream files added: 0. Running total: 20.

### Task 3: Widen the server-plugin context and let plugins contribute managed engine config

**Files:**
- Modify:
  - `packages/web/server/lib/server-plugins.js` (hook file);
  - `packages/web/server/index.js` (call site at ~2468, `createManagedConfigRuntime` at ~1877);
  - `packages/web/server/lib/opencode/managed-config-file.js` (**new upstream file, +1**).
- Test:
  - `packages/web/server/lib/server-plugins.test.js`;
  - `packages/web/server/lib/opencode/managed-config-file.test.js`;
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- Produces the context passed to each plugin's default export:
  ```
  {
    app, dataDir, logger,
    settings: { read(): Promise<object>, persist(changes: object): Promise<void> },        // readSettingsFromDiskMigrated, persistSettings
    events: { broadcast(type: string, payload: object): void,                              // broadcastGlobalUiEvent
              subscribe(listener: (event) => void): () => void },                          // globalMessageStreamHub.subscribeEvent
    opencode: { url(path?: string): string, authHeaders(): Record<string,string>,          // buildOpenCodeUrl, getOpenCodeAuthHeaders
                restart(reason: string): Promise<void>,                                    // restartOpenCode
                refresh(reason: string): Promise<void>,                                    // refreshOpenCodeAfterConfigChange
                waitReady(): Promise<void>, defaultDirectory(): string | null },
    managedConfig: { refresh(): Promise<{ updated: boolean, reason?: string }> },          // managedConfigRuntime.refreshManagedConfigFile
    host: object | null,                                                                   // options.pluginHost from the desktop shell, else null
    requestScope(req): 'local' | 'tunnel' | 'unknown-public',                             // tunnelAuthController.classifyRequestScope
    onShutdown(fn: () => Promise<void> | void): void,
  }
  ```
- Plugin setup may return `{ engineEnv?, managedConfig?, dispose? }`:
  - `managedConfig(): object | Promise<object>` is an engine config fragment.
  - `loadServerPlugins` returns `{ engineEnv(), managedConfig(), dispose() }`.
  - `managedConfig()` merges fragments in order: objects deep-merged, later wins on scalars; `plugins` and `experimental.policies` arrays concatenated in order.
- `createManagedConfigRuntime({ …, contributeConfig = async () => ({}) })`:
  - `writeConfigFile` writes `{ ...contributed, plugins: [...DISABLED_BUILTIN_PLUGINS, ...upstreamDirs, ...(contributed.plugins ?? [])] }`.
  - When the user owns `OPENCODE_CONFIG`, contributions are skipped and logged once with `managed config contributions skipped: OPENCODE_CONFIG is set`.
- `index.js` passes `contributeConfig: () => (serverPlugins ? serverPlugins.managedConfig() : {})` and calls `serverPlugins.dispose()` from graceful shutdown.

- [ ] **Step 1:** Write the failing tests:
  - `server-plugins.test.js`:
    - `managedConfig merges fragments in order`: plugin 1 returns `{providers:{a:{name:'A'}},plugins:['/p1'],experimental:{policies:[{action:'provider.use',resource:'*',effect:'deny'}]}}` and plugin 2 returns `{providers:{a:{models:{m:{}}}},plugins:['/p2'],experimental:{policies:[{action:'provider.use',resource:'a',effect:'allow'}]}}`. The result deep-equals `{providers:{a:{name:'A',models:{m:{}}}},plugins:['/p1','/p2'],experimental:{policies:[deny *, allow a]}}`.
    - `dispose runs every plugin's dispose in reverse order`: the call order is `['p2','p1']`.
    - `context is handed through unchanged`: the plugin receives `context.opencode.url` as a function.
  - `managed-config-file.test.js`:
    - `contributions are written beside upstream plugins`: with `contributeConfig` returning `{providers:{x:{name:'X'}},plugins:['/mine']}`, the file JSON deep-equals `{providers:{x:{name:'X'}},plugins:['-opencode.browser', <agent-tool dir>, '/mine']}`.
    - `no contributor writes the upstream file byte-identically`.
    - `contributions are skipped when OPENCODE_CONFIG is set`.
  - Contract:
    - Update the `server-plugins-env` regex to the new context literal.
    - Add item `managed-config-contributions` (files `managed-config-file.js`, `index.js`), whose check asserts `contributeConfig` is passed at `createManagedConfigRuntime(`.
- [ ] **Step 2:** `bun run --cwd packages/web test -- server/lib/server-plugins.test.js server/lib/opencode/managed-config-file.test.js` and `bun run --cwd packages/mittr-server test`. Expected: the new cases FAIL.
- [ ] **Step 3:** Implement. Leave the `serverPlugins` getter lazy, because the managed runtime is created before plugins load. `onShutdown` handlers run inside `gracefulShutdown` before the engine stops.
- [ ] **Step 4:** Re-run both. Expected: PASS. Run `bun run type-check` and `node scripts/mittr/check-upstream-touch.mjs --no-write`. Expected: 21 of 40, with `managed-config-file.js` listed in `brand/upstream-hooks.json` with its hook and reason.
- [ ] **Step 5:** Commit as two commits:
  - `hook(server-plugins): hand plugins the server's settings, events, engine and shutdown, and take their engine config`
  - `hook(managed-config): write contributed engine config beside the managed plugins`

  Each body says why: a downstream build adds providers and policies without editing upstream's writer.

Upstream files added: 1. Running total: 21.

### Task 4: Electron host services — secret store and deep-link handler registry

**Files:**
- Create (generic hook files): `packages/electron/secret-store.mjs`, `packages/electron/deep-link-registry.mjs`, with `secret-store.test.mjs` and `deep-link-registry.test.mjs`.
- Modify:
  - `packages/electron/main.mjs`: the registry near `pendingDeepLinks` (~1729); the one call site at the top of `dispatchDeepLink` (~1972); `pluginHost` in the `startWebUiServer` options (~1365).
  - `packages/web/server/index.js`: `options.pluginHost` becomes `context.host`.
- Test: the two new test files, contract items.

**Interfaces:**
- `createSafeStorageSecretStore({ safeStorage }) -> { encrypt(text: string): Buffer, decrypt(data: Buffer | Uint8Array): string } | null`. Returns null when `safeStorage` is missing or `isEncryptionAvailable()` is false.
- `createDeepLinkRegistry() -> { register({ host: string, handle(link: {type,value,raw}) => Promise<{ emit?: string } | void> }): () => void, dispatch(link): Promise<boolean> }`:
  - `dispatch` returns `false` when no handler owns `link.type`.
  - The hosts `connect`, `focus`, `session` and `host` cannot be registered (throws `deep-link host "<host>" belongs to the app`).
  - It lives in `packages/electron/deep-link-registry.mjs`, a generic hook file.
- `main.mjs`:
  - `dispatchDeepLink` first awaits `registry.dispatch(link)`. On `true` it returns. When the handler returned `{emit}`, it calls `emitToAllWindows(emit, {})` and focuses the main window.
  - `pluginHost = { secretStore: createSafeStorageSecretStore({ safeStorage }), deepLinks: { register } }`.

- [ ] **Step 1:** Write the failing tests:
  - `secret store round-trips through safeStorage`: with fake `safeStorage` `{isEncryptionAvailable:()=>true, encryptString:s=>Buffer.from('E'+s), decryptString:b=>b.toString().slice(1)}`, `decrypt(encrypt('tok'))==='tok'`.
  - `no encryption means no store`: `isEncryptionAvailable:()=>false` gives `null`.
  - `a registered host handles its link and asks for an event`: register `auth`; `dispatch({type:'auth',value:'callback',raw:'mittrcraft-dev://auth/callback?code=c'})` resolves `true` and the handler saw `raw`.
  - `an unregistered host falls through to upstream dispatch`: `dispatch({type:'other'})` resolves `false`.
  - `connect links are never offered to registered handlers`: `register({host:'connect'})` throws.
  - `unregister removes the handler`.
- [ ] **Step 2:** `bun run --cwd packages/electron test`. Expected: new tests FAIL.
- [ ] **Step 3:** Implement. Pass `pluginHost` only after `app.whenReady()`, which already holds at `spawnLocalServer`. Add contract items:
  - `deep-link-registry-call-site`: asserts `registry.dispatch(` is the first statement of `dispatchDeepLink`;
  - `plugin-host-option`: asserts `pluginHost` is in the `startWebUiServer` call and is read in `index.js`.
  - Run `node --check` on both new `.mjs` files (R7).
- [ ] **Step 4:** Run the electron tests, `bun run --cwd packages/web test -- server/lib/server-plugins.test.js` and the mittr-server tests. Expected: PASS.
- [ ] **Step 5:** Commit `hook(electron-host): a secret store and a deep-link handler registry for in-process server plugins`. The body says why: a plugin needs keychain-backed secrets and its own deep-link hosts without editing the app's dispatcher.

Upstream files added: 0 (two hook files; `main.mjs` and `index.js` were already touched). Running total: 21.

### Task 5: The engine starts once

**Files:**
- Modify: `packages/web/server/lib/opencode/lifecycle.js` (already touched).
- Test: `packages/web/server/lib/opencode/lifecycle.test.js`.

**Interfaces:**
- Produces, inside `createOpenCodeLifecycleRuntime`:
  - `runEngineLaunchExclusive(task: () => Promise<T>) -> Promise<T>`, a promise queue where a rejected task does not block the next one;
  - `restartOpenCode` runs its body through it;
  - `bootstrapOpenCodeAtStartup` wraps `state.openCodeProcess = await startOpenCode()` in it.

  This ports `origin/fix/engine-single-instance` `5c4be9880` onto 2.1.1's lifecycle. The race is still there in 2.1.1: the first start takes no lock (`lifecycle.js:1190`, `startup-pipeline-runtime.js:143`).

- [ ] **Step 1:** Write the failing tests with the existing fake spawner pattern in `lifecycle.test.js`:
  - `a restart requested during the first start leaves exactly one live process`:
    - The fake `createManagedOpenCodeServerProcess` resolves readiness after 200 ms.
    - Call `bootstrapOpenCodeAtStartup()`, then `restartOpenCode('catalog')` after 10 ms, and await both.
    - Assert spawned `2`, closed `1`, live `1`, and `state.openCodeProcess` is the live one.
  - `a failed first start does not block a later restart`: the first spawn rejects; `restartOpenCode` still spawns, and live is `1`.
- [ ] **Step 2:** `bun run --cwd packages/web test -- server/lib/opencode/lifecycle.test.js`. Expected: the first case FAILS with live `2`.
- [ ] **Step 3:** Implement exactly the queue above. Leave `currentRestartPromise` semantics unchanged for callers.
- [ ] **Step 4:** Re-run. Expected: PASS, and the other lifecycle tests unchanged.
- [ ] **Step 5:** Commit `hook(lifecycle): start and restart the engine one at a time`. The body says why: a restart during the first start spawned a second, orphaned engine.

Upstream files added: 0. Running total: 21.

### Task 6: Mittr sign-in on the server — broker, accounts store, transaction, session, refresh

**Files:**
- Create in `packages/mittr-server/src/mittr/`, each with a `*.test.js`:
  - `broker.js`, `secret-store.js`, `account-store.js`, `sign-in.js`, `session.js`, `auth-routes.js`;
  - `index.js`: `setupMittr(context)`, wiring of later tasks.
- Modify:
  - `packages/mittr-server/src/plugin.js`: call `setupMittr`;
  - `brand/product.dev.json` and `brand/product.prod.json`: broker keys;
  - `packages/electron/product.mjs` (hook file): an `envDefaults` key.
- Test: `packages/electron/product.test.mjs`.

**Interfaces:**
- `product.mjs`:
  - `envDefaults: Record<string,string>`, default `{}`.
  - `applyProductEnv` sets an `envDefaults` key only when it is unset or blank, then applies `env` with override, as today.
  - Dev product: `envDefaults.MITTRCRAFT_BROKER_URL = "https://api-dev.mittr.asia"`.
  - Prod product: `env.MITTRCRAFT_BROKER_URL = "https://api.mittr.asia"` and `env.MITTRCRAFT_BROKER_FIXED = "1"`.
  - Contract key list gains `envDefaults`.
- `resolveBroker(env) -> { baseUrl: string, upstreamV1: string, fixed: boolean }`:
  - `baseUrl` is `env.MITTRCRAFT_BROKER_URL` or `https://api.mittr.asia`. It must be https unless loopback, and must be an origin only.
  - `upstreamV1` is `env.MITTRCRAFT_UPSTREAM_URL` only when `fixed` is false, else `${baseUrl}/v1`.
- `plaintextSecretStore(logger) -> { encrypt, decrypt }`: warns once with `[mittr] no keychain: Mittr tokens are stored unencrypted`.
- `createAccountStore({ dataDir, encrypt, decrypt, fs? }) -> { read(), write(session, { activate = true }), clear(), activate(userId), signOut(userId), list(), activeHome() }`:
  - A port of 1.22 `account-store.js`, with the same files: `mittr-accounts/index.json`, `<sha256(userId) hex[0..16]>.session` (encrypted, mode 0600), and legacy `mittr-session` migration.
  - `index.json` format equals what phase-1 `activeAccountHome` reads.
- `createTransaction({ randomBytes, now }) -> { verifier, challenge, createdAt }`.
- `verifyCallback(tx, url, { now, scheme }) -> { code }`. Errors are the 1.22 messages: `No sign-in is in progress`, `Sign-in callback is not a valid URL`, `Sign-in callback did not arrive on the auth deep link`, `Sign-in transaction expired`, `Sign-in callback carried no code`.
- `parseSession(payload) -> { accessToken, refreshToken, expiresAt, subject: { userId, displayName } }`.
- `registerMittrAuthRoutes(app, { broker, store, scheme, fetchImpl, now, onSignIn, onAccountChange }) -> { ensureFreshSession(): Promise<Session|null>, completeSignIn(url: string): Promise<Status> }`. Routes use their own `express.json({limit:'8kb'})`:
  - `POST /api/mittr/auth/start` → `{authorizeUrl}`;
  - `POST /api/mittr/auth/callback {url}`;
  - `GET /api/mittr/auth/status` → `{signedIn:true,userId,displayName}` or `{signedIn:false}`;
  - `DELETE /api/mittr/auth/session`;
  - `GET /api/mittr/auth/accounts`;
  - `POST /api/mittr/auth/accounts/activate {userId}`.
- `setupMittr(context)`:
  - picks the secret store: `context.host?.secretStore`, else plaintext;
  - `scheme = process.env.MITTRCRAFT_DEEP_LINK_SCHEME` (set from the product: Dev `mittrcraft-dev`, prod `mittrcraft`);
  - `context.host?.deepLinks.register({ host:'auth', handle: async (link) => { await completeSignIn(link.raw); return { emit: 'mittrcraft:signed-in' } } })`;
  - returns `{ engineEnv, managedConfig, dispose }` for `plugin.js` to merge.

- [ ] **Step 1:** Write the failing tests (fake `fetchImpl` and a fixed `now`):
  - `envDefaults fill only unset keys`: with env `{MITTRCRAFT_BROKER_URL:'http://127.0.0.1:3000'}` and `envDefaults {MITTRCRAFT_BROKER_URL:'https://api-dev.mittr.asia'}`, the value stays `http://127.0.0.1:3000`. With an empty env it becomes `https://api-dev.mittr.asia`.
  - `prod broker ignores a launch override`: applying `brand/product.prod.json` to env `{MITTRCRAFT_BROKER_URL:'https://example.invalid'}` gives `https://api.mittr.asia`, and `resolveBroker` gives `fixed:true` and ignores `MITTRCRAFT_UPSTREAM_URL:'https://x.invalid'`.
  - `start returns the platform authorize URL`: `authorizeUrl` starts with `https://api-dev.mittr.asia/auth/desktop/start?code_challenge=` and contains `redirect_uri=mittrcraft-dev%3A%2F%2Fauth%2Fcallback`.
  - `callback exchanges once and stores the session`: the exchange body deep-equals `{code:'c1',code_verifier:<verifier>,redirect_uri:'mittrcraft-dev://auth/callback'}`. Status is `{signedIn:true,userId:'u-a',displayName:'A'}`.
  - `callback with no pending transaction is refused and nothing is exchanged`: 400, 0 fetch calls.
  - `a second callback for a spent transaction is refused`.
  - `callback on the wrong scheme is refused`: `mittrcraft://auth/callback?code=c` on Dev gives 400 `Sign-in callback did not arrive on the auth deep link`.
  - `expired transaction is refused`: `now` + 600_001 ms.
  - `ensureFreshSession refreshes inside the 60 s margin and keeps rotated tokens`: `expiresAt = now+59_000` → one POST `{refresh_token:'r1'}`, and the stored refresh token becomes `r2`.
  - `concurrent ensureFreshSession calls share one refresh request`: `Promise.all` of 3 gives 1 fetch.
  - `a refused refresh signs the account out`: 401 → `null` and the status is signed out. A 502 keeps the session.
  - `tokens are never written in plain text when a store is given`: the `.session` bytes do not contain `r1`.
  - `deep-link auth handler completes sign-in and asks for the signed-in event`: the handler result deep-equals `{emit:'mittrcraft:signed-in'}`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test` and `bun run --cwd packages/electron test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Port the 1.22 bodies (`origin/develop:packages/web/server/lib/mittr/{auth-routes,sign-in-transaction,session,account-store}.js`) unchanged apart from module wiring. Add `MITTRCRAFT_DEEP_LINK_SCHEME` to each product `env` (`mittrcraft-dev` / `mittrcraft`).
- [ ] **Step 4:** Re-run both suites. Expected: PASS.
- [ ] **Step 5:** Commit as two commits:
  - `hook(product): product env defaults that a launch may override`
  - `feat(mittr-server): Mittr sign-in, token refresh and the account store`

Upstream files added: 0. Running total: 21.

### Task 7: UI root wrapper and named slots

**Files:**
- Modify: `packages/ui/src/lib/product-plugins.ts` (hook file), `packages/ui/src/main.tsx` and `packages/ui/src/apps/renderElectronMiniChatApp.tsx` (both already touched).
- Test: `packages/ui/src/lib/product-plugins.test.ts`.

**Interfaces:**
- `ProductUiPlugin` gains:
  - `rootWrapper?: React.ComponentType<{ children: React.ReactNode; surface: 'main' | 'mini-chat' }>`;
  - `slots?: Partial<Record<ProductSlotName, React.ComponentType<any>>>`;
  - `modelPicker?: { useDecorations(open: boolean): ModelPickerDecorations }`;
  - `messageError?: (error: { type: string; message: string; status?: number; responseBody?: string }) => string | null`.
- `type ProductSlotName = 'sidebar-footer' | 'about-dialog' | 'about-settings' | 'providers-page' | 'session-auth-methods' | 'assistant-message-footer'`.
- `type ModelPickerDecorations = { isProviderShown(providerId: string): boolean; entryStatus(entry: { providerID: string; modelID: string; name: string }): ModelEntryStatus | null }`.
- `type ModelEntryStatus = { pill: string; title?: string; tone: 'neutral' | 'near'; blocked: boolean }`.
- `ProductRoot({ surface, children })` nests every plugin's `rootWrapper` in registration order. With none it renders `children`.
- `ProductSlot({ name, ...props })` renders every plugin's component for `name`, in order. With none it renders nothing.
- `useProductModelPicker(open)` returns the merged decorations: shown if every plugin shows; the first non-null status. With none it returns pass-through.
- `translateProductMessageError(error) -> string | null`: the first non-null.
- `main.tsx` and the Mini Chat entry wrap `<App/>` / `<ElectronMiniChatApp/>` in `<ProductRoot surface="main|mini-chat">`, inside `SessionAuthGate`.

- [ ] **Step 1:** Write the failing tests (`react-dom/server` `renderToStaticMarkup`):
  - `no plugin leaves the tree unchanged`: `<ProductRoot surface="main"><b>x</b></ProductRoot>` renders `<b>x</b>`.
  - `wrappers nest in registration order`: plugins `p1` (`<i data-p1>`) then `p2` (`<u data-p2>`) render `<i data-p1=""><u data-p2=""><b>x</b></u></i>`.
  - `a slot renders every plugin's component with its props`: `ProductSlot name="sidebar-footer" label="q"` renders `q` twice for two plugins.
  - `an empty slot renders nothing`.
  - `model picker decorations default to pass-through`: `isProviderShown('openai') === true` and `entryStatus(...) === null`.
  - `message error translation takes the first answer`.
- [ ] **Step 2:** `bun test packages/ui/src/lib/product-plugins.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the contract item `ui-root-wrapper`, which asserts `<ProductRoot surface="main">` in `main.tsx` and `surface="mini-chat"` in the Mini Chat entry.
- [ ] **Step 4:** `bun run --cwd packages/ui test`, `bun run type-check`, `bun run lint`. Expected: PASS, with the baseline unchanged.
- [ ] **Step 5:** Commit `hook(ui-plugins): a root wrapper and named slots for product UI plugins`.

Upstream files added: 0. Running total: 21.

### Task 8: Sign-in gate in the UI (main window and Mini Chat)

**Files:**
- Create in `packages/mittr-ui/src/sign-in/`:
  - `MittrSignInGate.tsx`, `signInGateState.ts`, `AuditNotice.tsx`;
  - tests `signInGateState.test.ts` and `MittrSignInGate.test.tsx`.
- Modify: `packages/mittr-ui/src/product-ui-plugin.tsx`, `packages/mittr-ui/src/strings/en.ts`.

**Interfaces:**
- Consumes `rootWrapper`, and `/api/mittr/auth/{status,start}`.
- Produces:
  - `type GateState = 'checking' | 'signed-out' | 'signed-in'`;
  - `parseSignInStatus(payload) -> { signedIn: boolean; userId?: string; displayName?: string }`;
  - `gateStateFromStatus(status | null) -> GateState`;
  - `parseAuthorizeUrl(payload) -> string | null` (http/https only);
  - constants `SIGN_IN_STATUS_ENDPOINT = '/api/mittr/auth/status'`, `SIGN_IN_START_ENDPOINT = '/api/mittr/auth/start'`, `SIGN_IN_COMPLETED_EVENT = 'mittrcraft:signed-in'`.
- The gate refreshes on mount, on window `focus`, and on `window.__OPENCHAMBER_DESKTOP__?.listen(SIGN_IN_COMPLETED_EVENT)`.
- Strings (English, under keys `mittr.signIn.{checking,title,description,action,error}` and `mittr.audit.notice`) are registered as a mittr-ui dictionary. Other locales fall back to English (C-02).

- [ ] **Step 1:** Write the failing tests:
  - `status parsing defaults to signed out`: `parseSignInStatus({})` deep-equals `{signedIn:false}`.
  - `authorize URL must be http(s)`: `parseAuthorizeUrl({authorizeUrl:'javascript:alert(1)'}) === null`.
  - `gate shows the sign-in screen when signed out`: with fake fetch `{signedIn:false}`, the markup contains the `mittr.signIn.action` text and the audit notice, and not the child.
  - `gate shows the app when signed in`: with fake fetch `{signedIn:true,userId:'u'}`, the child renders.
  - `the desktop signed-in event re-checks status`: the fake listen callback fires, and fetch is called twice.
- [ ] **Step 2:** `bun test packages/mittr-ui/src/sign-in`. Expected: FAIL.
- [ ] **Step 3:** Implement with upstream UI primitives (`Button`, theme tokens, per `theme-system`). Port the 1.22 copy and layout from `origin/develop:packages/ui/src/components/mittr/*`.
- [ ] **Step 4:** Run `bun run --cwd packages/mittr-ui test`, `type-check` and `lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-ui): sign in with Mittr before the app opens`.

Upstream files added: 0. Running total: 21.

### Task 9: Loopback shim — the engine's OpenAI-compatible endpoint

**Files:**
- Create in `packages/mittr-server/src/mittr/`: `local-token.js`, `loopback-guard.js`, `shim-routes.js`, `response-markup.js`, each with tests.
- Modify: `packages/mittr-server/src/mittr/index.js`.

**Interfaces:**
- `ensureLocalToken({ tokenPath }) -> string`: accepts `/^mc_local_[0-9a-f]{64}$/`, otherwise writes a new one with mode 0600.
- `isLoopbackPeer(remoteAddress) -> boolean`: true for `127.0.0.1`, `::1` and `::ffff:127.0.0.1`.
- `registerMittrShim(app, { upstreamV1, localToken, ensureFreshSession, onAnswer?, onRefusal?, fetchImpl }) -> void`, with routes under `/mittr-shim/v1`:
  - `POST /chat/completions` streams without buffering. Headers: `cache-control: no-cache, no-transform`, `x-accel-buffering: no`, upstream content-type.
  - `GET /models` returns `{object:'list',data:[{id,object:'model'}]}` from the catalog cache.
  - Every route answers 403 for a non-loopback peer and 401 for a wrong bearer. With no session it answers 401 `{error:'Not signed in to Mittr. Sign in to continue.'}`.
  - A network failure gives 502 `{error:'Cannot reach Mittr'}`.
- `onAnswer` and `onRefusal` are hooks for Tasks 22–24. Defaults are no-ops.
- `describeMarkup` and `createStreamMarkupWatcher` are a 1.22 port. They log and never edit.

- [ ] **Step 1:** Write the failing tests (an in-process express app and a fake upstream):
  - `forwards with the account token and streams chunks as they arrive`: upstream gets `authorization: Bearer at-1`; the client receives chunk 1 before upstream sends chunk 2 (timed with a 100 ms gap).
  - `refuses a non-loopback peer`: `remoteAddress '10.0.0.5'` gives 403.
  - `refuses a wrong local token`: 401.
  - `not signed in`: 401 with the exact message.
  - `upstream unreachable`: 502 `Cannot reach Mittr`.
  - `models lists the cached aliases`: cache `[{alias:'gpt-a',label:'A'}]` gives `data[0].id === 'gpt-a'`.
  - `lost tool calls are logged once`: content `<tool_call>{}` with no `tool_calls` gives one `console.error` containing `tool-calls-lost`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement. The routes sit outside `/api` (no UI auth; the engine has no session), so they are guarded only by the peer check and the token. The body comes from upstream's non-`/api` JSON parser (50mb). Add the contract item `non-api-json-body`, which asserts `core-routes.js` still parses JSON for non-`/api` paths.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): a loopback endpoint that hands the engine's requests to Mittr`.

Upstream files added: 0. Running total: 21.

### Task 10: Mittr as an engine provider — managed config and credential

**Files:**
- Create in `packages/mittr-server/src/mittr/`: `provider-config.js`, `engine-credential.js`, `policies.js` (moved from Task 2's helpers), each with tests.
- Modify: `packages/mittr-server/src/mittr/index.js`.

**Interfaces:**
- `mittrProviderFragment({ shimBaseUrl, models: Array<{alias,label}> }) -> { providers: { mittr: { name:'Mittr', package:'aisdk:@ai-sdk/openai-compatible', settings:{ baseURL: shimBaseUrl }, models: Record<alias, { modelID: alias, name: label || alias, capabilities: { tools: true } }> } } }`.
  - With `models` empty it returns `{}`, so no provider appears.
- `ensureMittrCredential({ opencode, key, fetchImpl }) -> Promise<'stored' | 'present'>`:
  - It does `POST <opencode.url('/api/integration/mittr/connect/key')>` with `{key}` and `opencode.authHeaders()`.
  - It is idempotent per engine start (`present` when the last stored key for this engine port equals `key`).
  - It runs after `opencode.waitReady()` on every engine start and after the first provider write.
  - The fallback, if Task 2 P6 failed, is `settings.apiKey:'{env:MITTRCRAFT_SHIM_TOKEN}'` plus `engineEnv().MITTRCRAFT_SHIM_TOKEN`.
- `setupMittr` returns `managedConfig: () => merge(mittrProviderFragment(...), policiesFragment(...), identityFragment(...))`. Tasks 13 and 14 add the last two. After a change it calls `context.managedConfig.refresh()`, and `context.opencode.refresh('mittr provider')` only if Task 2 P5 failed.

- [ ] **Step 1:** Write the failing tests:
  - `provider fragment for two agents`: `mittrProviderFragment({shimBaseUrl:'http://127.0.0.1:57133/mittr-shim/v1', models:[{alias:'a1',label:'Writer'},{alias:'a2',label:''}]})` deep-equals the shape above, with `models.a2.name === 'a2'`.
  - `no agents means no provider`: `{}`.
  - `credential is stored once per engine start`: two calls send 1 POST with body `{key:'mc_local_<64 hex>'}` and return `'stored'` then `'present'`. A new engine port gives a POST again.
  - `credential failure is reported, not thrown, and retried on next ready`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the contract item `engine-integration-connect-key`, which pins the client route `/api/integration/{id}/connect/key` in `node_modules/@opencode/client` (the path string in the generated client chunk).
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): Mittr models as an engine provider through the managed config`.

Upstream files added: 0. Running total: 21.

### Task 11: Catalog sync, cache and triggers

**Files:**
- Create in `packages/mittr-server/src/mittr/`: `catalog.js`, `catalog-cache.js`, `catalog-routes.js`, each with tests.
- Modify: `packages/mittr-server/src/mittr/index.js`.

**Interfaces:**
- `parseCatalog(payload)`: the 1.22 port. It requires `bundleVersion` to be an integer. `models`, `mcp`, `skills` and `knowledge` become `{configured, items}`. Model items need a non-empty `alias`.
- `catalogCachePath(dataDir, home: string|null) -> string`: `mittr-catalog.json` for `null`, `mittr-accounts/<home>.catalog.json` otherwise.
- `createCatalogCache({ filePath, logger }) -> { read(): Catalog|null, write(catalog) }`. A corrupt file reads as `null` and warns once.
- `registerMittrCatalogRoutes(app, { broker, ensureFreshSession, cache, onModels }) -> { sync(): Promise<{status, body}> }`:
  - `GET /api/mittr/catalog` → `{providerId:'mittr', bundleVersion, models, mcp, skills}`.
  - `POST /api/mittr/catalog/sync`.
- Triggers in `setupMittr`, phase 2's share of P3-09:
  - plugin setup applies the cache (`onModels(cache.read()?.models?.items ?? [])`), then starts a sync without awaiting it;
  - a completed sign-in syncs;
  - an account switch applies that account's cache, then syncs.
- `onModels(items)` updates the provider fragment and refreshes the managed config. Phase 3 adds skills and MCP to the same sync.

- [ ] **Step 1:** Write the failing tests:
  - `sync fetches the catalog with the account token and writes the cache`: `GET https://api-dev.mittr.asia/desktop/catalog` with `authorization: Bearer at-1`; the cache holds `bundleVersion 7`, and `onModels` receives 2 items.
  - `offline start applies the cached catalog`: a fetch that rejects still calls `onModels` with the cached 2 items before the sync fails, and the sync answers 502 `Cannot reach Mittr`.
  - `corrupt cache is ignored with one warning`.
  - `empty models remove the provider's models but keep the cache shape`: `models: []` gives `onModels([])` and the cache `models.configured === true`.
  - `refused catalog keeps the last list`: a 403 `desktop_entitlement_required` gives no `onModels` call and the status 403.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement (1.22 bodies from `origin/develop:packages/web/server/lib/mittr/catalog*.js`).
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): follow the Mittr catalog and remember the last list`.

Upstream files added: 0. Running total: 21.

### Task 12: A fresh install starts on the first Mittr agent

**Files:**
- Create: `packages/mittr-server/src/mittr/default-model.js` and its test.
- Modify: `packages/mittr-server/src/mittr/index.js`, plus contract items.

**Interfaces:**
- `syncDefaultModel({ readConfigFile, writeConfig, configPath, providerId: 'mittr', modelIds: string[] }) -> boolean`.
  - Rule, ported from 1.22 `syncProviderDefaultModel`:
    - Empty `modelIds` with a current `model` starting `mittr/`: delete `model`.
    - No `model`, or a `mittr/` model not in the list: set `mittr/<modelIds[0]>`.
    - Any other provider's default: unchanged.
  - It writes the **user** config `<OPENCODE_CONFIG_DIR>/opencode.json`, not the managed file, so a person's later pick is never overridden by a higher config layer.
- It uses upstream `readConfigFile(filePath)`, `writeConfig(config, filePath)` and `CONFIG_FILE` from `packages/web/server/lib/opencode/shared.js` (imported from `@openchamber/web/server/lib/opencode/shared.js`). These are pinned by the new contract item `opencode-user-config-io`.

- [ ] **Step 1:** Write the failing tests (fake read/write):
  - `empty config adopts the first agent`: `{}` with `['a1','a2']` writes `{model:'mittr/a1'}` and returns `true`.
  - `withdrawn default moves to the next agent`: `{model:'mittr/a1'}` with `['a2']` writes `mittr/a2`.
  - `default on another provider is untouched`: `{model:'openai/gpt-x'}` returns `false` with no write.
  - `no agents clears only a Mittr default`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement and call it from `onModels`.
- [ ] **Step 4:** Run the tests plus the contract tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): start new sessions on the first Mittr agent`.

Upstream files added: 0. Running total: 21.

### Task 13: Only Mittr models, with the opt-in switch for others (R37/R40)

**Files:**
- Modify:
  - `packages/ui/src/components/chat/ModelControls.tsx` (**new upstream file, +1**): call `useProductModelPicker(open)` once and pass `isModelAllowed` to `<ModelPickerList>` (2619–2686);
  - `packages/ui/src/components/sections/providers/ProvidersPage.tsx` (**new upstream file, +1**): `<ProductSlot name="providers-page" />` above `ProviderGrid` (~911);
  - `packages/mittr-server/src/mittr/policies.js` and `index.js`.
- Create:
  - `packages/mittr-server/src/mittr/provider-lock-routes.js`;
  - `packages/mittr-ui/src/providers/OtherProvidersSwitch.tsx`;
  - `packages/mittr-ui/src/providers/useMittrPickerFilter.ts`.
- Test: the three new files' tests, plus `packages/ui/src/components/chat/ModelControls.product.test.tsx`.

**Interfaces:**
- `policiesFragment({ showOtherProviders }) -> { experimental: { policies: Policy[] } } | {}`, using `policiesFor(...)` from Task 2.
- Routes:
  - `GET /api/mittr/provider-lock` → `{showOtherProviders:boolean}`, read from `settings.mittr.showOtherProviders`, default `false`.
  - `PUT /api/mittr/provider-lock {showOtherProviders}`: own `express.json({limit:'1kb'})`; persists through `context.settings.persist({mittr:{...current, showOtherProviders}})`, rewrites the managed config, and broadcasts `mittr.provider-lock.changed`.
- The mittr-ui plugin's `modelPicker.useDecorations(open)` returns `isProviderShown: id => showOtherProviders || id === 'mittr'`.
- `OtherProvidersSwitch` renders in the `providers-page` slot. It is a labelled switch, "Show models from other providers", with a one-line note that this lets prompts go to those providers.

- [ ] **Step 1:** Write the failing tests:
  - `lock on writes deny-all then allow mittr`: `policiesFragment({showOtherProviders:false})` deep-equals `{experimental:{policies:[{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'mittr',effect:'allow'}]}}`.
  - `switch on lifts the engine lock`: `policiesFragment({showOtherProviders:true})` deep-equals `{}`.
  - `PUT persists under settings.mittr and refreshes the managed config`: the persist call receives `{mittr:{showOtherProviders:true}}`, and `managedConfig.refresh` is called once.
  - `ModelControls.product.test.tsx`: `picker hides other providers when a plugin says so`. With a registered plugin whose `isProviderShown` is `id === 'mittr'`, providers `mittr` and `openai` render only Mittr rows. With no plugin, both render.
- [ ] **Step 2:** Run the mittr-server, mittr-ui and `bun test packages/ui/src/components/chat/ModelControls.product.test.tsx` tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Contract items:
  - `model-controls-product-picker`: one `useProductModelPicker(` call in `ModelControls.tsx`;
  - `providers-page-slot`;
  - `policy-schema`: asserts `@opencode/schema/dist/config/experimental.js` still has `policies` and `config/policy.js` still has the `provider.use` literal.
- [ ] **Step 4:** Run all suites, `type-check`, `lint` and the touch check. Expected: PASS, 23 of 40.
- [ ] **Step 5:** Commit as three commits:
  - `hook(model-controls): let a product plugin narrow and mark picker entries`
  - `hook(providers-page): a slot above the provider grid`
  - `feat(mittr): only Mittr models unless the person opts in to others`

Upstream files added: 2. Running total: 23.

### Task 14: The model says it is MittrCraft

**Files:**
- Create:
  - `packages/mittr-opencode/package.json` (`@mittrcraft/opencode`, private, type module, `test: node --test "src/**/*.test.js"`);
  - `packages/mittr-opencode/src/identity-plugin.js` and its test;
  - `packages/mittr-server/src/mittr/identity.js` and its test.
- Modify: `packages/mittr-server/src/mittr/index.js`. `bun.lock` changes because a workspace package is added; it is already counted (R15).

**Interfaces:**
- `IDENTITY_PLUGIN_ID = 'mittrcraft.identity'`.
- `identityPluginSource({ productName: 'MittrCraft' }) -> string` is an ESM module, `export default { id, setup: async (ctx) => { … } }`. It registers the same handler on `ctx.session.hook('context')`, `'generate'` and `'compaction'`. The handler:
  - rewrites in `o.system[0].text`: `You are opencode, an interactive CLI tool` → `You are MittrCraft, an interactive tool`, and `You are OpenCode, a coding agent` → `You are MittrCraft, a coding agent`;
  - pushes one part with `You are MittrCraft. When asked who you are or which product this is, answer MittrCraft. Never call yourself OpenCode or OpenChamber.`;
  - leaves paths like `.opencode/` untouched.
  - If Task 2 P2 needed it, it also registers the `retry` hook scoped to `mittr`.
- `materializeIdentityPlugin({ dataDir }) -> Promise<string>` writes `<dataDir>/engine-plugins/mittrcraft-identity/{package.json,index.js}` (mode 0600; `package.json` `exports: {'.':'./index.js'}`) and returns that directory.
  - `identityFragment(dir) -> { plugins: [dir] }`.
  - The engine cannot read inside `app.asar`, so the source is written to the data dir, as upstream does for its agent tool.
- **Fallback, only if Task 2 P3 failed:** `rewriteSystemIdentity(body) -> body` in `shim-routes.js`, applied to `messages[0]` when `role === 'system'`, with the same two rewrites and the appended sentence. It is then flagged to the owner in the proof note.

- [ ] **Step 1:** Write the failing tests:
  - Load the generated source with `import('data:text/javascript,…')`, pass a fake `ctx` that records hooks, and run the handler on `o = {system:[{text:'You are opencode, an interactive CLI tool that helps… Use .opencode/agents.'}]}`. Expect:
    - hooks registered `['context','generate','compaction']`;
    - `o.system[0].text` starts with `You are MittrCraft, an interactive tool`;
    - `.opencode/agents` is still present;
    - `o.system.length === 2`, and the second part's text contains `answer MittrCraft`.
  - `materializeIdentityPlugin writes a loadable directory plugin`: `package.json` exports `./index.js`, and both files have mode `0o600`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-opencode test` and `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `packages/mittr-opencode` to the root test gate (`scripts/mittr/test-baseline.mjs` stage list) and to `knip.json` beside the other `packages/mittr-*` entries (already-touched file). Re-run Task 2's P3 with the real source.
- [ ] **Step 4:** Run the tests and the probe's P3. Expected: PASS.
- [ ] **Step 5:** Commit as two commits:
  - `hook(knip): include the engine plugin package` (the `knip.json` line only; body: dead-code analysis must see the new workspace package);
  - `feat(mittr-opencode): the engine introduces itself as MittrCraft`.

Upstream files added: 0. Running total: 23.

### Task 15: Gate — the Dev build signs in to the DEV platform and answers a chat

**Files:**
- Create: `docs/plans/2026-10-17-phase-2-midgate.md`

Isolation rules, all binding:
- Fresh temp HOME and userData, as in Global Constraints. The app binary is launched directly with `env HOME=<t> OPENCHAMBER_DESKTOP_USER_DATA_DIR=<t>/userData`. Record the PID, and quit with `kill -TERM <pid>`.
- Before and after, record `stat` listings of every real dir named in Global Constraints. `diff` must be empty.
- Confirm the installed `/Applications/MittrCraft.app` (prod 1.22) and any installed Dev 1.x were not signalled or opened. Record their PIDs and uptime before and after.
- The callback is never delivered by LaunchServices. It is handed to the test instance as a second-instance launch of the **same binary with the same env**, which exercises the real `second-instance` → `dispatchDeepLink` → registry path:
  ```
  env HOME=<t> OPENCHAMBER_DESKTOP_USER_DATA_DIR=<t>/userData ".../MittrCraft Dev.app/Contents/MacOS/MittrCraft Dev" "mittrcraft-dev://auth/callback?code=<code>"
  ```

- [ ] **Step 1:** Run `node scripts/mittr/build-desktop.mjs --flavor dev`. Expected: exit 0, and the leak scan is clean.
- [ ] **Step 2:** Headless before sign-in. Launch, wait for `http://127.0.0.1:57133/health`, then check:
  - `GET /api/mittr/auth/status` is `{"signedIn":false}`;
  - `<t>/.config/mittrcraft-dev/opencode.managed.json` has no `providers.mittr`;
  - a screenshot of the test window (`screencapture -l <id>`, window id filtered by PID) shows the sign-in screen;
  - Mini Chat, opened from the tray, shows the same screen.
- [ ] **Step 3 — INTERACTIVE SIGN-IN (controller in the in-app browser, or the owner):**
  - `curl -s -X POST :57133/api/mittr/auth/start` gives the `authorizeUrl`. Open it in a browser, and sign in as Account A with Microsoft.
  - The platform redirects to `mittrcraft-dev://auth/callback?code=…`. **Do not click "Open".** Read the URL from the prompt text, or from DevTools → Network (preserve log) → the `auth/desktop/callback` response `Location` header.
  - Hand it to the test instance with the second-instance command above.
  - Record the time. The code is valid for 10 minutes.
- [ ] **Step 4:** Headless after sign-in. Check, recording each with PASS/FAIL:
  - within 5 s of the hand-off, `status` reports A's user id and the window shows the app (screenshot);
  - `opencode.managed.json` has `providers.mittr` with A's aliases, the two lock policies, and the identity plugin directory;
  - the model picker (screenshot of the open picker) lists only A's Mittr agents;
  - create a session and prompt "say hi" through `@opencode/client` against the app's proxy: an answer streams in;
  - prompt "who are you?" twice, on two agents: both name MittrCraft and neither names OpenCode or OpenChamber;
  - `grep -a refresh_token <t>/.config/mittrcraft-dev/mittr-accounts/*.session` finds nothing;
  - quit and relaunch: no sign-in screen.
- [ ] **Step 5:** `pgrep -P <app pid> -f opencode` lists exactly one engine 30 s after each of three relaunches.
- [ ] **Step 6:** Write the note: build, isolation evidence, each check. Commit `docs(mittr): phase 2 mid gate — Dev signs in to the dev platform and answers`. **If any check fails, stop and report before Task 16.**

Upstream files added: 0. Running total: 23.

### Task 16: Several accounts and switching (server)

**Files:**
- Create: `packages/mittr-server/src/mittr/accounts-switch.js` and its test.
- Modify: `packages/mittr-server/src/mittr/{index.js,auth-routes.js}`, `packages/mittr-server/src/plugin.js`.

**Interfaces:**
- `createAccountSwitcher({ store, catalog, opencode, applyCache, logger }) -> { switchTo(userId): Promise<Status>, afterSignIn(previousUserId, nextUserId): Promise<void> }`. A switch:
  - activates the account;
  - applies that account's cached catalog;
  - calls `opencode.refresh('mittr account switched')` when `store.activeHome()` changed (the engine env is re-read from `activeAccountHome` on that restart);
  - then re-runs `ensureMittrCredential` after `waitReady`;
  - then starts a sync without awaiting it.
- Per-account migration is lazy: the first switch to a 1.22 account home starts the engine on that home, and OpenCode 2 migrates it there. The V1 top-up already follows `engineEnv` (phase 1).
- "Add account" is `POST /api/mittr/auth/start`, while signed in; the callback for a new user activates it.

- [ ] **Step 1:** Write the failing tests:
  - `adding B keeps A signed in and activates B`: `list()` has `[A,B]`, active is `B`, and `B.home` is `sha256('u-b').slice(0,16)`.
  - `switching restarts the engine once on the other home`: `refresh` is called once with `'mittr account switched'`, and after it the engine env `XDG_DATA_HOME` ends `accounts/<B home>` (`engineEnv` read after `switchTo`).
  - `switching back to the first account uses the shared home`: `XDG_DATA_HOME` is the base without `accounts/`.
  - `a refused refresh of an inactive account leaves the active account signed in`: A is active, B's refresh gets 401, and A is still active and signed in.
  - `last active account survives a restart`: a new store over the same dir has active `B`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `ensureFreshSession` only ever refreshes the active account. A background refresh of another account is never started.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): several Mittr accounts, each with its own history`.

Upstream files added: 0. Running total: 23.

### Task 17: Account menu and sign-out in the UI

**Files:**
- Modify:
  - `packages/ui/src/components/session/sidebar/shell/SidebarFooter.tsx` (**new upstream file, +1**): `<ProductSlot name="sidebar-footer" />` before the update button;
  - `packages/ui/src/components/ui/AboutDialog.tsx` (**new upstream file, +1**): `<ProductSlot name="about-dialog" />` under the version block;
  - `packages/ui/src/components/sections/openchamber/AboutSettings.tsx` (already touched): `<ProductSlot name="about-settings" />` after the update-controls row (~560).
- Create in `packages/mittr-ui/src/accounts/`: `MittrAccountMenu.tsx`, `accountsApi.ts`, `SignOutButton.tsx` and tests; strings `mittr.accounts.*`.

**Interfaces:**
- `accountsApi.ts`:
  - `fetchAccounts(): Promise<Array<{userId, displayName, active}>>`;
  - `activateAccount(userId): Promise<void>` (throws `HTTP <status>`);
  - `signOutActive(): Promise<{signedIn:boolean,userId?:string}>`;
  - `startAddAccount(): Promise<boolean>`.
- `MittrAccountMenu`:
  - a footer button with the active account's initials;
  - a menu listing the accounts, with a check on the active one, "Add account" and "Sign out";
  - switching reloads the window after the server answers.
- `SignOutButton` is used in both About slots. After sign-out it reloads; the gate then shows when no account remains.

- [ ] **Step 1:** Write the failing tests:
  - `menu lists A and B with B active`.
  - `sign out of the last account returns to the gate`: the fake `DELETE` answers `{signedIn:false}`, and `onSignedOut` is called with `false`.
  - In upstream test files next to each hook: `SidebarFooter renders the product slot`, `AboutDialog renders the product slot` (a registered plugin's text appears; with none, the markup equals the pre-hook snapshot).
- [ ] **Step 2:** Run `bun test` on the four files. Expected: FAIL.
- [ ] **Step 3:** Implement. Contract items:
  - `sidebar-footer-slot`, `about-dialog-slot`, `about-settings-slot`: one `ProductSlot` call each;
  - `sidebar-footer-visible-on-desktop`: the footer still renders when `showRuntimeButtons` is true.
- [ ] **Step 4:** Run all UI suites, `type-check`, `lint` and the touch check. Expected: PASS, 25 of 40.
- [ ] **Step 5:** Commit as three commits:
  - `hook(sidebar-footer): a product slot in the sidebar footer`
  - `hook(about): product slots in the About dialog and the About page`
  - `feat(mittr-ui): account menu, add account, switch and sign out`

Upstream files added: 2. Running total: 25.

### Task 18: Mittr quota on the server — service and quota provider registration

**Files:**
- Modify: `packages/web/server/lib/quota/providers/index.js` (**new upstream file, +1**): export `registerQuotaProvider(entry)`.
- Create in `packages/mittr-server/src/mittr/`: `quota-service.js`, `quota-provider.js`, `quota-routes.js`, `exhausted.js` and tests.
- Test: `packages/web/server/lib/quota/providers/register.test.js`.

**Interfaces:**
- Upstream `registerQuotaProvider({ providerId, providerName, isConfigured(auth): boolean, fetchQuota(): Promise<Result> }) -> () => void`:
  - adds the entry to the registry that `listConfiguredQuotaProviders` and `fetchQuotaForProvider` read;
  - throws on a duplicate id;
  - the returned function removes it.
- `createMittrQuotaService({ broker, ensureFreshSession, fetchImpl }) -> { readMine(): Promise<QuotaMe> }`:
  - `GET <broker>/api/quota/me`, with a 10 s timeout;
  - errors carry `reasonCode` and `statusCode`: `not_signed_in` 401, `not_available` 404, `upstream_failed` 502, `unreachable` 502, `upstream_timeout` 504, `not_configured` 503;
  - validation as in 1.22 `service.js`.
- Route `GET /api/mittr/quota/me` returns the service result or `{error:'Could not read this week’s quota', reasonCode}`.
- `mittrQuotaProvider({ service, isSignedIn }) -> entry` with `providerId:'mittr'`, `providerName:'Mittr'`. `fetchQuota()` maps `QuotaMe` to upstream's result through `buildResult` and `toUsageWindow` (`packages/web/server/lib/quota/utils/formatters.js`):
  - `usage.windows.weekly`: overall share, `resetAt` = `resetsAt` ms;
  - `usage.models[<line label>].windows.weekly`: `usedPercent = used/limit*100`, `valueLabel = '<left> of <limit> left'` (stt in minutes, as `formatQuotaAmount` did).
- `exhausted.js`: `readQuotaExhausted(textOrObj) -> {kind, resetsAt} | null` (flat and nested shapes), `toEngineRefusal(quota)` (= Task 2 `quotaRefusal`), `createQuotaStreamRewriter()`. These are 1.22 ports, used by Task 22.

- [ ] **Step 1:** Write the failing tests:
  - `register.test.js`:
    - `a registered provider is listed and fetched`: register `{providerId:'x',…,isConfigured:()=>true,fetchQuota:async()=>({providerId:'x',ok:true})}`. `listConfiguredQuotaProviders()` includes `'x'`, and `fetchQuotaForProvider('x')` resolves `ok:true`.
    - `duplicate id throws`.
    - `unregister removes it`.
  - mittr-server:
    - `quota me maps a 401 to not_signed_in`.
    - `the provider shows remaining per agent with the reset time`: a line `{label:'Writer',used:30,limit:50,kind:'chat'}` gives `usage.models.Writer.windows.weekly.remainingPercent === 40` and `valueLabel === '20 of 50 left'`, and `resetAt === Date.parse('2026-10-20T00:00:00+07:00')`.
    - `not configured when signed out`.
- [ ] **Step 2:** Run the web vitest file and the mittr-server tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The plugin registers in setup and unregisters in `dispose`. Contract item `quota-provider-registry`: `registerQuotaProvider` is exported, and `formatters.js` still exports `buildResult` and `toUsageWindow`.
- [ ] **Step 4:** Re-run, then run the touch check. Expected: PASS, 26 of 40.
- [ ] **Step 5:** Commit as two commits:
  - `hook(quota-server): register quota providers at run time`
  - `feat(mittr-server): this week's Mittr quota as a usage provider`

Upstream files added: 1. Running total: 26.

### Task 19: Settings → Usage opens on Mittr

**Files:**
- Modify: `packages/ui/src/lib/quota/providers/index.ts` (**new upstream file, +1**): `registerQuotaProvider(meta, { first? })`.
- Create: `packages/mittr-ui/src/quota/registerMittrUsage.ts` and its test.
- Test: `packages/ui/src/lib/quota/providers/register.test.ts`.

**Interfaces:**
- `registerQuotaProvider(meta: { id: string; name: string }, options?: { first?: boolean }) -> void`:
  - inserts into `QUOTA_PROVIDERS`, at index 0 when `first`;
  - is idempotent by id;
  - the closed `QuotaProviderId` union is widened only inside this module, with one commented cast.
- mittr-ui, at import:
  - `registerQuotaProvider({ id: 'mittr', name: 'Mittr' }, { first: true })`;
  - once signed in, calls `useQuotaStore.getState().setSelectedProvider('mittr')` when `selectedProviderId` is `null` (UsagePage only picks when null);
  - when signed out, `mittr` reports `configured:false` and upstream hides its card.
- Search: the usage page keywords already include `quota`. mittr-ui overlays the English description key the search item uses for the usage page (found in `packages/ui/src/lib/settings/search.ts`), adding the word "weekly" so the search for "weekly" also lands there.

- [ ] **Step 1:** Write the failing tests:
  - `first registration goes to the front`: `QUOTA_PROVIDERS[0].id === 'mittr'`, and length grows by 1.
  - `registering twice is a no-op`.
  - mittr-ui:
    - `Mittr becomes the selected usage provider when none is chosen`: the store's `selectedProviderId === 'mittr'`.
    - `a chosen provider is kept`: preset `'codex'` stays.
    - `settings search finds usage for quota and weekly`: the search function from `search.ts` returns an item with `page === 'usage'` for both queries.
- [ ] **Step 2:** `bun test` on both files. Expected: FAIL.
- [ ] **Step 3:** Implement. Contract item `quota-ui-registry`.
- [ ] **Step 4:** Run the UI suites, `type-check`, `lint` and the touch check. Expected: PASS, 27 of 40.
- [ ] **Step 5:** Commit as two commits:
  - `hook(quota-ui): register usage providers at run time`
  - `feat(mittr-ui): Settings → Usage opens on this week's Mittr quota`

Upstream files added: 1. Running total: 27.

### Task 20: Quota marks in the model picker

**Files:**
- Modify:
  - `packages/ui/src/components/model-picker/ModelPickerList.tsx` (**new upstream file, +1**): a prop `isEntryBlocked?(entry): boolean`. A blocked row renders `aria-disabled`, and click, Enter and Space on it do nothing (`renderRow` ~895–912, `handleKeyDown` ~819–824).
  - `packages/ui/src/components/chat/ModelControls.tsx` (already touched in Task 13): pass `isEntryBlocked` and `renderRowEnd` from the same `useProductModelPicker(open)` result.
- Create: `packages/mittr-ui/src/quota/{quotaMeStore.ts,agentStatus.ts,AgentStatusPill.tsx}` and tests.

**Interfaces:**
- `agentEntryStatus(status: AgentStatus | undefined, agentName: string, t, locale) -> ModelEntryStatus | null` (1.22 `mittrAgentEntryStatus`):
  - `out` → `{blocked:true,tone:'neutral',pill:t('quota.agent.out'),title:t('quota.agent.outLabel',{agent,when})}`;
  - `substitute` → `{blocked:false,tone:'neutral',pill:t('quota.agent.backup'),title}`;
  - `near` → `{blocked:false,tone:'near',pill:t('quota.agent.left',{n})}`;
  - `ok` → `null`.
- `useQuotaMe(open)` fetches `/api/mittr/quota/me` when the picker opens, fresh for 30 s (`QUOTA_ME_FRESH_MS = 30_000`).
- `modelPicker.useDecorations` adds `entryStatus` for `providerID === 'mittr'` entries, keyed by `modelID`.

- [ ] **Step 1:** Write the failing tests:
  - Upstream `ModelPickerList.blocked.test.tsx`:
    - `a blocked entry cannot be chosen by click or Enter`: `onSelect` is not called, and the row has `aria-disabled="true"`.
    - `without isEntryBlocked nothing changes`.
  - mittr-ui:
    - `out agent is blocked with its reset time`: the title contains `20 Oct` for `resetsAt '2026-10-20T00:00:00+07:00'` in `en-GB`.
    - `near agent shows what is left`: pill `12% left`.
    - `ok agent has no mark`.
- [ ] **Step 2:** `bun test` on the files. Expected: FAIL.
- [ ] **Step 3:** Implement. Contract item `model-picker-blocked-entry`.
- [ ] **Step 4:** Run the UI suites, `type-check`, `lint` and the touch check. Expected: PASS, 28 of 40.
- [ ] **Step 5:** Commit as two commits:
  - `hook(model-picker): entries a product plugin marks as unavailable cannot be picked`
  - `feat(mittr-ui): this week's quota beside each Mittr agent in the picker`

Upstream files added: 1. Running total: 28.

### Task 21: Used-up quota shown in chat, with Try again

**Files:**
- Modify: `packages/ui/src/components/chat/ChatMessage.tsx` (**new upstream file, +1**). Two generic touches in one hook commit:
  - in the `assistantError` memo (560–596), `translateProductMessageError(error)` is consulted first;
  - `<ProductSlot name="assistant-message-footer" message={message} isLatestTurn={turnGroupingContext?.isLatestTurn === true} />` after `<MessageBody>`.
- Create in `packages/mittr-ui/src/quota/`: `quotaError.ts`, `QuotaRetryButton.tsx`, `resend.ts` and tests; strings `quota.exhausted.*`.

**Interfaces:**
- `quotaExhaustedFromError({ type, message, status, responseBody }) -> { kind, resetsAt } | null`. It reads `responseBody` first, then `message`, accepting both shapes (1.22 `exhausted.ts`).
- mittr-ui `messageError(error)` returns `t('quota.exhausted.chat', { when })` for a quota refusal, else `null`.
- `QuotaRetryButton` renders in `assistant-message-footer` only when the message is an assistant message, has a quota error, and `isLatestTurn`.
- `resendAfterQuota(assistant, { readTurn, send }) -> Promise<boolean>`:
  - rebuilds the parent user turn: non-synthetic text, files, synthetic texts, agent mention, `providerID`, `modelID`, variant;
  - sends through `opencodeClient.sendMessage`;
  - is guarded against a double click by `useQuotaRetryPending`.

- [ ] **Step 1:** Write the failing tests:
  - `quota refusal reads as used up with the reset time`: error `{type:'APIError',message:'x',status:402,responseBody:'{"error":{"code":"llm_quota_exhausted","resets_at":"2026-10-19T17:00:00Z"}}'}` gives text containing `20 Oct`.
  - `other errors keep upstream's text`: `null`.
  - `Try again shows only on the latest refused turn`: `isLatestTurn:false` renders nothing.
  - `Try again resends the same text and attachments`: `send` receives `text:'draw a cat'` and `files[0].url === 'data:image/png;base64,AAA'`.
  - `a double click sends once`.
  - Upstream `ChatMessage.product.test.tsx`:
    - `a product error translation replaces the error text`;
    - `the footer slot receives the message and isLatestTurn`.
- [ ] **Step 2:** `bun test` on the files. Expected: FAIL.
- [ ] **Step 3:** Implement. Contract item `chat-message-product-hooks`: both calls are present once.
- [ ] **Step 4:** Run the UI suites, `type-check`, `lint` and the touch check. Expected: PASS, 29 of 40.
- [ ] **Step 5:** Commit as two commits:
  - `hook(chat-message): product error text and an assistant footer slot`
  - `feat(mittr-ui): a used-up weekly quota says when it resets, with Try again`

Upstream files added: 1. Running total: 29.

### Task 22: A quota refusal is not retried

**Files:**
- Modify: `packages/mittr-server/src/mittr/shim-routes.js` and its test.

**Interfaces:**
- Non-stream, or a non-ok upstream: `readQuotaExhausted(text)` matches, so the shim answers `toEngineRefusal(quota)` with status 402 and header `x-should-retry: false`, and calls `onRefusal({kind:'quota', quota})`.
- Stream: each chunk passes through `createQuotaStreamRewriter().push`. A frame with `llm_quota_exhausted` becomes `data: {"error":{"type":"insufficient_quota","code":"llm_quota_exhausted","message":…}}`, and the stream ends after `data: [DONE]`.
- Every non-quota error response from upstream is forwarded with its status and body. 429 rate limits keep the engine's normal retry.

- [ ] **Step 1:** Write the failing tests:
  - `pre-stream 429 becomes 402 with x-should-retry false`: upstream 429 with body `{"error":{"type":"insufficient_quota","code":"llm_quota_exhausted","resets_at":"2026-10-20T00:00:00+07:00"}}` gives status `402`, header `x-should-retry: false`, `body.error.resets_at === '2026-10-19T17:00:00Z'`, and exactly 1 upstream call.
  - `flat filter body is recognised`: `{code:'llm_quota_exhausted',kind:'chat',resetsAt:'…'}` gives 402.
  - `mid-stream quota frame is rewritten and the stream ends`.
  - `a plain rate limit is passed through`: 429 `rate_limit_exceeded` gives 429 and no `x-should-retry` header.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS. Re-run Task 2 P2 against the shim with a fake platform. Expected: 1 request, idle within 2 s.
- [ ] **Step 5:** Commit `feat(mittr-server): a used-up quota ends the turn instead of being retried`.

Upstream files added: 0. Running total: 29.

### Task 23: "Answered by a backup model" note

**Files:**
- Create:
  - `packages/mittr-server/src/mittr/answered-by.js`;
  - `packages/mittr-ui/src/quota/{answeredBy.ts,AnsweredByNotice.tsx}`;
  - tests for each.
- Modify: `shim-routes.js` (an `onAnswer` wiring), `index.js`.

**Interfaces:**
- `sessionIdOf(headers) -> string | null` reads `x-opencode-session-id`, then `x-session-id`.
- `readAnsweredBy(textOrObj) -> { requestedLabel, answeredLabel, reason } | null` (`reason` in `quota|failed|silent`).
- `createAnsweredByWatcher(cb)` and `createAnsweredByLog({ perSession: 10, sessions: 100 }) -> { record(sessionId, answer), list(sessionId) }`.
- Route `GET /api/mittr/answered-by?sessionId=` → `{now, answers:[{at, model, reason, requestedLabel, answeredLabel}]}`. A missing id gives 400 `{error:'sessionId is required', reasonCode:'invalid_request'}`.
- `AnsweredByNotice` renders in `assistant-message-footer` for `providerID === 'mittr'` completed messages, matched by `modelID` and by time between the message's `created` and `completed` (1.22 `answeredByFor`). It is a muted line naming the backup and why.

- [ ] **Step 1:** Write the failing tests:
  - `the engine's session header keys the record`: a request with header `x-opencode-session-id: ses_1` and a first chunk with `answered_by:{substituted:true,requestedLabel:'Writer',answeredLabel:'Backup',reason:'quota'}` gives `list('ses_1')[0].answeredLabel === 'Backup'`.
  - `no substitution, no record`.
  - `the notice names the backup and the reason`.
  - `other providers get no notice`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr): name the backup agent when Mittr answered with one`.

Upstream files added: 0. Running total: 29.

### Task 24: Model refusal and broken tool-call diagnostics

**Files:**
- Create: `packages/mittr-server/src/mittr/model-refusal.js` and its test.
- Modify: `shim-routes.js`, and `packages/mittr-ui/src/quota/quotaError.ts` (`messageError`).

**Interfaces:**
- `describeModelRefusal(body) -> { reason: 'entitlement' | 'stale-catalog' | 'unknown', canResync: boolean }`.
  - It reads `body.error.code`, then `body.error.message`, then `body.error` as a string.
  - **Fixed against the platform's nested body.** 1.22 read `String(body.error)` and always got `unknown`.
  - `desktop_entitlement_required` → entitlement. Its wire form is `{error:{message:'desktop_entitlement_required',code:'forbidden'}}`, so it is matched on the message.
  - `agent_not_granted` → stale-catalog.
- On a 403 from upstream, the shim forwards status and body unchanged and logs `[mittr] model refused: <reason>`. For `stale-catalog` it starts one catalog sync, at most once per 60 s.
- mittr-ui `messageError` maps a 403 with those codes:
  - entitlement → `mittr.model.refused.entitlement`: "Your organisation has not given you MittrCraft access. Ask an admin.";
  - stale-catalog → `mittr.model.refused.staleCatalog`: "This agent is no longer available to you. The model list has been refreshed; pick another."

- [ ] **Step 1:** Write the failing tests:
  - `entitlement refusal is recognised from the platform's wire body`: `{error:{message:'desktop_entitlement_required',type:'invalid_request_error',code:'forbidden'}}` gives `entitlement`.
  - `withdrawn agent asks for a re-sync`: `{error:{code:'agent_not_granted',message:'agent_not_granted'}}` gives `stale-catalog` with `canResync:true`.
  - `stale catalog triggers one sync per minute`: two refusals 10 s apart give 1 sync.
  - `the chat says an admin is needed`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr): say whether a refused model needs an admin or a refresh`.

Upstream files added: 0. Running total: 29.

### Task 25: AD and Entra sign-in for hosted web — server

**Files:**
- Modify: `packages/web/server/lib/ui-auth/ui-auth.js` (**new upstream file, +1**).
- Create in `packages/mittr-server/src/ui-auth/`: `ad-auth.js`, `entra-auth.js`, `routes.js`, each with tests.
- Modify:
  - `packages/mittr-server/package.json`: `ldapjs` `^3.0.7`, **only with the owner's word**, so Step 0 comes first;
  - `packages/mittr-server/src/plugin.js`.
- Test: `packages/web/server/lib/ui-auth/ui-auth.providers.test.js`.

**Interfaces:**
- Upstream hook, in `ui-auth.js` (module level): `registerUiAuthProvider({ id: string }) -> { issueSession(req, res, { trustDevice?: boolean, claims?: object }): Promise<void>, readClaims(req): Promise<object | null>, clearSession(req, res): void, unregister(): void }`.
  - While at least one provider is registered, a controller created **without** a password still requires a session cookie in `requireAuth`. It issues and verifies it with the same JWT secret and TTLs as the password branch (12 h; trusted device 7 days).
  - `handleSessionStatus` adds `providers: string[]`.
  - Password login stays refused with `UI password not configured`.
  - With no provider registered, behaviour is byte-for-byte upstream.
- mittr-server, when configured from env (names unchanged from 1.22):
  - `createAdAuth(env)` (LDAP: `MITTR_AD_ENABLED=true`, `MITTR_AD_URL`, `MITTR_AD_BIND_DN`, `MITTR_AD_BIND_PASSWORD`, `MITTR_AD_SEARCH_BASE`);
  - `createEntraAuth(env)` (`MITTR_AD_CLIENT_ID`, `MITTR_AD_CLIENT_SECRET`, `MITTR_AD_TENANT_ID`, `MITTR_AD_REDIRECT_URI`; with only some of the four set it fails closed and the server refuses to start unauthenticated).
- Routes, outside `/api`, each refusing tunnel or unknown-public scope through `context.requestScope(req)` with 403:
  - `GET /auth/ad/status`, `GET /auth/ad/login`, `GET /auth/ad/callback`;
  - `POST /auth/ad/session` (LDAP);
  - `GET /auth/ad/profile`;
  - `DELETE /auth/session` (clears only this browser's cookie).

  Bodies and errors are 1.22's (`origin/develop:packages/web/server/lib/ui-auth/{ad-auth,entra-auth}.js` and `core-routes.js` ~736–787).

- [ ] **Step 0 (owner decision):** `ldapjs` is a new dependency. Ask the controller for the owner's word.
  - If refused, the LDAP half stops. Entra (with `jose`, already present) is built, and the gate records LDAP as not built.
  - Install with bun into `packages/mittr-server` only, then `bun install` (one lockfile).
- [ ] **Step 1:** Write the failing tests:
  - Upstream:
    - `no provider keeps upstream behaviour`: without a password, `requireAuth` calls `next`.
    - `a registered provider makes the session required`: 401 `{error:'UI authentication required',locked:true}` for `/api/x`.
    - `issueSession then requireAuth passes`.
    - `status lists providers`.
  - mittr-server:
    - `partial Entra config fails closed`: three of four vars give `enabled:false`, with `configurationError` starting `Missing`.
    - `Entra login redirects to Microsoft with PKCE and state`: Location host `login.microsoftonline.com`, `code_challenge_method=S256`, cookie `oc_ad_transaction` path `/auth/ad/callback`.
    - `callback with a mismatched state is refused`: 400.
    - `LDAP wrong password is refused`: 401, using a fake ldap client.
    - `tunnel scope is refused`: 403 on every `/auth/ad/*`.
    - `sign-out clears only this browser`: the `Set-Cookie` has `Max-Age=0`.
- [ ] **Step 2:** Run the web vitest file and the mittr-server tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Contract item `ui-auth-provider-registry`.
- [ ] **Step 4:** Re-run, then run the touch check. Expected: PASS, 30 of 40.
- [ ] **Step 5:** Commit as two commits:
  - `hook(ui-auth): sign-in providers registered at run time can open and check a UI session`
  - `feat(mittr-server): company directory and Microsoft sign-in for hosted web`

Upstream files added: 1. Running total: 30.

### Task 26: AD and Entra sign-in for hosted web — UI

**Files:**
- Modify: `packages/ui/src/components/auth/SessionAuthGate.tsx` (**new upstream file, +1**): `<ProductSlot name="session-auth-methods" isTunnelLocked={isTunnelLocked} />` just after `</form>` (~998).
- Create in `packages/mittr-ui/src/ui-auth/`: `AdSignIn.tsx`, `SidebarProfile.tsx`, `adStatus.ts` and tests.

**Interfaces:**
- `fetchAdStatus() -> { enabled: boolean; mode?: 'ldap' | 'entra'; passwordEnabled?: boolean; tunnelLocked?: boolean }`, from `GET /auth/ad/status`.
- `AdSignIn` renders nothing on the desktop runtime, when `isTunnelLocked`, or when `enabled` is false. Otherwise:
  - `entra` shows the "Sign in with Microsoft" button, which goes to `/auth/ad/login?returnTo=<current path>`;
  - `ldap` shows a username and password form posting `/auth/ad/session`.
- `SidebarProfile` sits in the `sidebar-footer` slot. On hosted web with an AD session it shows name, title and department from `/auth/ad/profile`, and "Sign out" (`DELETE /auth/session`, then reload). On desktop it renders nothing; the Mittr account menu is there instead.

- [ ] **Step 1:** Write the failing tests:
  - `Microsoft button on hosted web with Entra`.
  - `nothing on desktop`: with `window.__OPENCHAMBER_DESKTOP__` defined, the markup is empty.
  - `nothing when tunnel-locked`.
  - `LDAP form posts username and password`: the fetch body deep-equals `{username:'u',password:'p',trustDevice:false}`.
  - Upstream `SessionAuthGate.product.test.tsx`: `the auth-methods slot receives isTunnelLocked`.
- [ ] **Step 2:** `bun test` on the files. Expected: FAIL.
- [ ] **Step 3:** Implement. Contract item `session-auth-methods-slot`.
- [ ] **Step 4:** Run the UI suites, `type-check`, `lint` and the touch check. Expected: PASS, 31 of 40.
- [ ] **Step 5:** Commit as two commits:
  - `hook(session-auth-gate): a slot for extra sign-in methods`
  - `feat(mittr-ui): company sign-in buttons and profile for hosted web`

Upstream files added: 1. Running total: 31.

### Task 27: Audit routes

**Files:**
- Create in `packages/mittr-server/src/mittr/`: `audit-routes.js`, `audit-record.js`, `audit-serializer.js`, `repository-identity.js`, each with tests.

**Interfaces:**
- Ported as they are (decision 4), with no new callers:
  - `POST /api/mittr/audit/prompt {sessionId,text}` (256kb);
  - `POST /api/mittr/audit/tool {sessionId,name}`;
  - `POST /api/mittr/audit/turn {sessionId,tokens}`;
  - `POST /api/mittr/audit/finish {sessionId,directory,model,outcome}` (8kb).

  Each answers 204 and parses its own JSON.
- `finish` sends `POST <broker>/desktop/audit` with the account token, and a failure only warns.
- Limits:
  - 200 open records;
  - per record: 100 actions, 200 prompts, 4000 characters per prompt.
- `AUDIT_FIELDS = ['startedAt','endedAt','repository','model','turns','tokens','actions','prompts','outcome']`.
- The repository comes from `git remote get-url origin` through upstream's git service. Its symbol is pinned in contract item `git-remote-url`.

- [ ] **Step 1:** Write the failing tests:
  - `a full record reaches the platform with only the audit fields`: the POST body keys equal `AUDIT_FIELDS`, `repository === 'techflowasia/mittr-craft'` for origin `git@github.com:techflowasia/mittr-craft.git`, and `actions` deep-equals `[{tool:'bash',count:2}]`.
  - `prompts are cut at 4000 characters`.
  - `the 201st open record drops the oldest`.
  - `signed out sends nothing and still answers 204`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement (1.22 bodies).
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): keep the audit routes`.

Upstream files added: 0. Running total: 31.

### Task 28: Hosted web is not indexed (pin upstream's own)

Upstream 2.1.1 already sends `X-Robots-Tag: noindex, nofollow` on every response and serves `robots.txt` with `Disallow: /` (`packages/web/server/index.js` ~2100–2116), before CORS and auth. No code is ported. The contract makes sure it stays.

**Files:**
- Modify: `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- Contract item `noindex`:
  - `files: ['packages/web/server/index.js']`;
  - `why: 'hosted MittrCraft stays out of search engines through upstream's own header and robots.txt'`.

- [ ] **Step 1:** Write the failing check `noindex`. It starts the real server in-process on a random port with a temp data dir (as the existing `server-plugins-env` check does). It asserts `GET /` has header `x-robots-tag: noindex, nofollow`, and `GET /robots.txt` body `=== 'User-agent: *\nDisallow: /\n'`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL (`noindex` has no item, so the item/check drift test fails).
- [ ] **Step 3:** Add the item.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `test(mittr-server): pin upstream's noindex header and robots.txt`.

Upstream files added: 0. Running total: 31.

### Task 29: Phase 2 gate — every P2 check on an isolated Dev build against the dev platform

**Files:**
- Create: `docs/plans/2026-10-17-phase-2-gate.md`.

Isolation is as in Task 15, for every launch: a fresh temp HOME per scenario, the direct binary, kill by PID, before/after `stat` of the real dirs, and the installed apps untouched. Hosted-web runs use the packaged server headless, as in the phase-1 gate's prod-layout run, with `OPENCHAMBER_SERVER_PLUGINS` pointing at the packed plugin and the `MITTR_AD_*` env set. A 1.22 two-account Dev data copy is made read-only from the real dir with `cp -Rp` after confirming it is idle (`lsof +D` empty), as in phase 1.

- [ ] **Step 1:** Build: `node scripts/mittr/build-desktop.mjs --flavor dev` (exit 0, leak scan clean), and `node scripts/mittr/check-upstream-touch.mjs --no-write` (≤ 40, expected 31, nothing unlisted). Run `bun run type-check`, `bun run lint`, `node scripts/mittr/test-baseline.mjs` and every `packages/mittr-*` suite: no failure outside `brand/test-baseline.json`.
- [ ] **Step 2 — INTERACTIVE BLOCK (one sitting; controller in the in-app browser, or the owner). Everything else in this task is headless.** Each sign-in is Task 15 Step 3: `authorizeUrl` from the API, Microsoft sign-in, the callback URL handed over by a second-instance launch, never "Open". Do these in order and record the clock time of each:
  1. Sign in as **A** on fresh HOME `h1`.
  2. On `h1`, add account **B**.
  3. Sign in as **Q** on fresh HOME `h2`.
  4. On the dev platform admin, as the owner's admin session:
     - withdraw one agent from A, and record which;
     - set Q's weekly quota so one agent is near and one is used up;
     - make one of A's agents unavailable so the platform substitutes;
     - remove desktop entitlement from a fourth dev user **E**, and sign E in on fresh HOME `h3`.
  5. For hosted web with Entra: sign in once with Microsoft in the browser against the headless server's `MITTR_AD_REDIRECT_URI` (needs a test App Registration from the owner; if none, record "not run, no App Registration").
- [ ] **Step 3:** Run the headless checks, one row per acceptance check in inventory §2, each recorded with the command, the observed value, and PASS or FAIL:
  - **P2-01** (h1):
    - gate screen before sign-in on the main window and Mini Chat (screenshots);
    - leaves the gate ≤ 5 s after the hand-off;
    - `/api/mittr/auth/status` userId equals A;
    - relaunch without the gate.
  - **C-04:**
    - a `mittrcraft-dev://connect?v=2&p=…` link from the app's own pairing route still reaches the pairing dialog (screenshot), proving the registry did not take it;
    - an unknown host logs `unknown deep-link action`.
  - **P2-02:**
    - `grep -a` finds no token text in `mittr-accounts/*.session`;
    - at ≥ 61 min after A's sign-in (access token 3600 s), a chat answers with no gate, and the platform log or shim log shows one refresh.
  - **P2-03** (h1):
    - session "A-1" made as A;
    - after adding B: the account list has A and B, B active, no "A-1" in `GET /api/session`, and the picker (`/api/model`) shows B's agents;
    - make "B-1", switch to A: "A-1" is back and "B-1" is gone;
    - relaunch: the active account is unchanged;
    - with the copied 1.22 two-account Dev data on fresh HOME `h4`: after the first switch, the second account's old session count equals the before-count from `prove-session-carryover.mjs` on that account home.
  - **P2-04:**
    - with A and B, A active: About → Sign out (UI click, screenshot) → reload on B;
    - account menu → Sign out → gate;
    - `GET /api/mittr/auth/accounts` gives `{"accounts":[]}`.
  - **P2-05:**
    - "say hi" streams an answer;
    - `strings` on the Dev `app.asar` `product.json` shows `api-dev.mittr.asia` in `envDefaults`;
    - `MITTRCRAFT_BROKER_URL=http://127.0.0.1:<stub port>` at launch moves requests to the stub (R41 Dev override);
    - a unit run of the prod product proves `https://example.invalid` is ignored. The prod build's real launch stays in phase 5 (R31).
  - **P2-06:**
    - the picker lists A's agents;
    - after step 2.4's withdrawal and `POST /api/mittr/catalog/sync`, the agent is gone from `/api/model` within 10 s with no engine restart (engine PID unchanged; or the restart Task 2 P5 recorded);
    - offline relaunch (no network: `MITTRCRAFT_BROKER_URL=http://127.0.0.1:9` for the run) still lists the cached agents.
  - **P2-07:**
    - fresh HOME, first sign-in: `opencode.json` `model` equals `mittr/<first alias>`, and a message answers;
    - after the withdrawal it equals the next alias.
  - **P2-08 / P2-16:**
    - switch OFF: add an `openai` key in Settings → Providers; the picker still lists only `mittr/*`; a session forced with `--model openai/gpt-4o-mini` through `node packages/web/bin/cli.js session create --port 57133` is refused by the engine and no request leaves for that provider (engine log);
    - switch ON (Settings → Providers): the picker shows `openai`, `opencode.managed.json` has no `experimental.policies`, and the forced session is accepted by the engine;
    - switch OFF again: refused again.
  - **P2-09** (Q on h2):
    - the used-up agent shows a pill and cannot be picked by click or Enter (UI walk with keyboard, screenshot);
    - its tooltip names the reset time;
    - the near agent shows its remainder.
  - **P2-10** (A):
    - Settings → Usage opens with Mittr selected first, listing agents with remaining amounts and the reset date;
    - settings search "quota" and "weekly" both jump there.
  - **P2-11** (Q):
    - send until refused: the message shows the reset time and one Try again; earlier refused turns have no button;
    - with an image attached and refused, raise Q's quota (part of the interactive block if it is not already done), press Try again: the new turn carries the image and is answered.
  - **P2-12** (Q):
    - shim request log on: one refused request gives exactly one platform call;
    - session status idle within 2 s, and no `retry` status in `/api/event` for that turn.
  - **P2-13** (A): the substituted answer carries the muted line naming the backup agent.
  - **P2-14:**
    - E's chat shows the "ask an admin" text;
    - A on the withdrawn agent (picked before the sync) shows the "refreshed; pick another" text, and one catalog sync follows.
  - **P2-15:**
    - three fresh sessions across two agents, "who are you?" and "what product am I using?";
    - all six answers name MittrCraft, and none names OpenCode or OpenChamber.
  - **P2-17:**
    - only if `ldapjs` was approved and a test LDAP is reachable: headless server with `MITTR_AD_*` set; the gate shows the AD form, a valid user gets in and sees name, title and department in the footer, and a wrong password gets 401;
    - through a tunnel-scope request (`Host` set to the tunnel host the server classifies as tunnel) `/auth/ad/session` gets 403;
    - otherwise record "not run" with the reason.
  - **P2-18:**
    - with four Entra vars: button shown, sign-in returns to the app, sidebar sign-out returns to the login;
    - with three vars the server refuses to start unauthenticated (exit code and log line);
    - on the desktop Dev app the button is absent (screenshot).
  - **P2-19:** `curl -X POST :57133/api/mittr/audit/{prompt,tool,turn,finish}` with 1.22-shaped bodies as A gives 204 each, and the record appears in the dev platform's `GET /desktop/audit` (admin session from the interactive block).
  - **P2-20:**
    - `curl -sI :57133/` shows `X-Robots-Tag: noindex, nofollow`;
    - `curl :57133/robots.txt` shows `Disallow: /`.
  - **P2-21:** fresh HOME, sign in, quit, relaunch with network on; 30 s later `pgrep -P <app pid> -f opencode` lists exactly one engine. Repeat 5 times.
- [ ] **Step 4:** Isolation evidence:
  - real dirs `diff` empty;
  - no `.config/openchamber`, `.local/share/opencode`, `.config/opencode` or `Library/Application Support/OpenChamber` in any temp HOME;
  - the installed apps' PIDs and uptime unchanged.
- [ ] **Step 5:** Write the gate note:
  - verdict table by group (sign-in, accounts, models, lock, quota, identity, hosted web, audit, engine);
  - every row with evidence;
  - findings numbered for follow-up;
  - the upstream touch count, with each new file's hook and reason.
- [ ] **Step 6:** Commit `docs(mittr): phase 2 gate on the Dev build against the dev platform`. Report to the controller with the dmg path. **Do not push.**

Upstream files added: 0. Running total: 31.

---

## Coverage and budget

| Inventory item | Task(s) |
|---|---|
| P2-01 sign-in gate + deep-link registry | 4, 6, 7, 8, 15, 29 |
| P2-02 token storage and refresh | 4, 6, 29 |
| P2-03 several accounts, per-account engine home | 16, 17, 29 |
| P2-04 sign out | 6, 17, 29 |
| P2-05 loopback shim, `providers.mittr`, credential | 2, 9, 10, 29 |
| P2-06 catalog sync | 11, 29 |
| P2-07 first Mittr agent | 12, 29 |
| P2-08 picker filter + R37/R40 switch | 13, 29 |
| P2-09 picker quota marks | 20, 29 |
| P2-10 Settings → Usage | 18, 19, 29 |
| P2-11 used-up notice + Try again | 21, 29 |
| P2-12 no retry on a quota refusal | 2, 22, 29 |
| P2-13 answered by a backup | 23, 29 |
| P2-14 refusal diagnostics | 24, 29 |
| P2-15 identity | 2, 14, 15, 29 |
| P2-16 Mittr-only lock | 2, 13, 29 |
| P2-17 AD (LDAP) hosted web | 25, 26, 29 |
| P2-18 Entra hosted web | 25, 26, 29 |
| P2-19 audit routes | 27, 29 |
| P2-20 noindex | 28, 29 |
| P2-21 engine starts once | 5, 15, 29 |
| C-04, C-05, C-13, C-16, C-17 | 4, 8, 3, 21–23, 12 |

New upstream files counted this phase: 11. They are:

| File | Task |
|---|---|
| `managed-config-file.js` | 3 |
| `ModelControls.tsx` | 13 |
| `ProvidersPage.tsx` | 13 |
| `SidebarFooter.tsx` | 17 |
| `AboutDialog.tsx` | 17 |
| `quota/providers/index.js` (server) | 18 |
| `lib/quota/providers/index.ts` (UI) | 19 |
| `ModelPickerList.tsx` | 20 |
| `ChatMessage.tsx` | 21 |
| `ui-auth.js` | 25 |
| `SessionAuthGate.tsx` | 26 |

Projected total after phase 2: **31 of 40**. New generic hook files (not counted) are `packages/electron/secret-store.mjs` and `packages/electron/deep-link-registry.mjs`. Phases 3–5 name about 8 more (auto-accept, ComposerFooter, ChatInput, MainLayout, useUIStore, ContextSidebarTab or a status-section extension, VoiceSettings, ComposerDictation), which projects about 39 of 40.
