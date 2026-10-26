# Upstream Rebase — Phase 3: My Work, Jira/Plane, Catalog Skills and MCP — Implementation Plan

> **For the executor:** implement task by task, with a review after each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A MittrCraft Dev build on upstream 2.1.1 that shows My work (Jira and several Plane workspaces) with Go work, lets a person set up Jira and Plane in Settings → Integrations, and installs the organisation's catalog skills and MCP connectors for the signed-in account only. It also clears the phase 2 carries that phase 3 touches.

**Architecture:**
- **Server.** Everything Mittr lives in `packages/mittr-server`, behind the phase 2 plugin context:
  - work and integrations proxy routes use the active account's session and store nothing about Jira or Plane on this machine;
  - catalog skills are written into the engine's config folder, reconciled for the active account before each engine start;
  - catalog MCP connectors go into the managed engine config fragment, which is already rebuilt per account. This holds unless the Task 6 spike sends them to the engine's user config instead.
- **UI.** `packages/mittr-ui` renders:
  - My work, opened from the existing `sidebar-footer` slot;
  - Go work, through upstream's own session-create and send path;
  - the Work tracking form, through one new generic `integrations-page` slot.
- **Not an SDK extension (designer's call, an owner decision).** Spec §5.4 put My work in a built-in SDK extension. 2.1.1's extension frame cannot reach the loopback server. Its only network path is `request` to an https `apiOrigin`, and the host attaches a credential from upstream's guest auth store, which is plain JSON in the data dir. So an extension would either:
  - put the Mittr access token in that store, readable by the engine's shell tool (this undoes R55's "the engine never holds the Mittr token");
  - or need a host-token hook in `guests/host-session.js` and the SDK manifest schema, which is +2 counted files.

  Go work needs the in-app session-create and send path, which is available directly to a UI plugin. `packages/mittr-extensions` is therefore not created.

**Tech Stack:**
- Bun workspaces: installed bun 1.3.14 (R3). Node ≥ 22 via `nvm use` (R4).
- Electron 43 and electron-builder 26; React/Vite UI.
- Tests:
  - `bun:test` through `scripts/run-isolated-tests.mjs` for the UI;
  - vitest for upstream web server hook tests;
  - `node:test` for `packages/mittr-*` server code.
- OpenCode 2.0.22 (bundled CLI, `@opencode/client` 2.0.22).
- Mittr platform routes:
  - `GET /desktop/work`;
  - `GET/PUT /api/integrations`;
  - `POST /api/integrations/{jira,plane}/test`;
  - `GET /desktop/catalog`.

**Spec:** `docs/specs/2026-10-16-upstream-rebase-design.md` and `docs/plans/2026-10-17-feature-inventory.md` §3 (P3-01 to P3-09), §7, §9 and §10. House style and carried rulings: `docs/plans/2026-10-17-upstream-rebase-phase-2.md` and `docs/plans/2026-10-17-phase-2-gate.md`.

## Global Constraints

**Where the work happens**
- Branch `rebase/upstream-2.1.1` in `~/Documents/mittr-craft/.worktrees/rebase-2x`, starting at `b75ce3bb0`. Upstream base `e302062e3` (`brand/UPSTREAM`).
- Never touch the main checkout, other worktrees, `develop`, `main` or any remote. **No push.** Owner item I3 (hosted trust boundary) and I5 (live two-account walk and packed `serve` re-check) stay open from phase 2 and are not part of this phase.
- Run every node or bun command after `source ~/.nvm/nvm.sh && nvm use` in the worktree (R4). Use the installed bun 1.3.14 and install no other (R3). If `bun install` rewrites the `bun.lock` format, stop and report.

**Code and copy**
- Write no new code comments or docstrings. Code, tests, fixtures, docs and commit messages are in English.
- The one Thai text is the Go work first message. It is chat content the person sends, copied verbatim from 1.22 (Task 14).
- User-facing strings:
  - Mittr-only UI strings live in `packages/mittr-ui/src/strings/mittr.en.ts`, read through `mittrT(key, vars)` / `useMittrT()`. They answer English in every locale (C-02).
  - `strings/en.ts` holds only overrides of upstream keys.
  - Upstream locale files are never edited.
  - Upstream `t()` is never called with a Mittr key.
- Everything visible must work (owner rule, 15 Oct). No button, field, number or promise may appear unless the backend in use supports it. A control the connected platform cannot honour is hidden, not disabled with a promise.
- Files we own: `packages/mittr-*/**`, `brand/**`, `scripts/mittr/**`, `patches/**`, `docs/**`. Everything else is upstream.

**Commits**
- Commits use only the existing style:
  - `feat(mittr-server|mittr-ui|mittr): …` and `fix(…): …` for our files;
  - `hook(<name>): …` with a one-paragraph why for any upstream file;
  - `docs(…): …` for notes.
- The working-notes folder that holds the phase's ledger, reports and gate evidence is git-ignored and is never named in tracked files. The gate note says only that the evidence is kept outside the repository.

**Upstream touch**
- The cap is 40 (R35/R36). It is **33 counted today**.
- This phase adds **1** counted file: `IntegrationsPage.tsx` (Task 16). Every other wiring lands in files already counted (`server/index.js`) or in generic hook files that are not counted (`server-plugins.js`, `product-plugins.ts`).
- Each hook is generic: it names no Mittr concept, keeps upstream behaviour when unused, and has one call site.
- Run `node scripts/mittr/check-upstream-touch.mjs --no-write` after any hook. It must report `34 of 40` at the end, with nothing unlisted and nothing stale.
- Every task that adds a hook has the step "append `{hook, why}` to `brand/upstream-hooks.json` for every upstream file this hook touches" (R48).
- Every new upstream module or symbol mittr-server or mittr-ui relies on gets an entry in `packages/mittr-server/src/upstream-contract.js` and its check in `upstream-contract.test.js`, in the task that starts relying on it.

**Dependencies and imports**
- mittr-server imports nothing from `@openchamber/web`. Upstream services reach it through the plugin context, and `express` is `context.express`.
- Add no dependencies.

**Tests**
- UI behaviour is tested as a pure controller plus static markup (`renderToStaticMarkup`), or with upstream's hand-rolled hook harness. There is no DOM library (R11).
- Every test, runner and probe runs under a temp `HOME` and temp `XDG_*`.
  - The isolated baseline is `node scripts/mittr/test-baseline.mjs`. Its guard refuses the real HOME (R102/R103).
  - Add no failure outside `brand/test-baseline.json`.
  - Never run the engine binary without temp `XDG_*` and `HOME`.

**Secrets**
- Jira and Plane credentials belong to the person's Mittr account, as in 1.22. The platform stores them per platform user.
  - MittrCraft sends them through to the platform under the active account's session.
  - It never writes them to disk, never caches them, and never returns them: the platform answers only `hasToken` / `hasApiKey`.
  - It never puts them in any process environment, and never logs a request body.
  - If a later change ever needs a local copy, it goes through the same sealed account secret store as the Mittr tokens (R57).
- `SERVER_ONLY_SECRETS` (R107/R108) gains the platform's own credential names, `JIRA_TOKEN` and `PLANE_API_KEY`, so a server whose shell holds them never hands them to the engine (Task 15).
- Catalog MCP configs may carry connector keys, as in 1.22. They are written only into engine config and never logged; a log line names the connector, never its config.

**Safety, every runtime check**
- Never open, signal, drive or replace the owner's running `/Applications/MittrCraft.app`, nor the installed MittrCraft Dev 1.x.
- Never write to:
  - `~/.config/mittrcraft*`;
  - `~/.local/{share,state}/mittrcraft`;
  - `~/.cache/mittrcraft`;
  - `~/.config/openchamber`;
  - `~/.local/share/opencode`;
  - `~/.config/opencode`;
  - `~/Library/Application Support/{MittrCraft,MittrCraft Dev,OpenChamber}`.
- Launches are isolated:
  - a fresh `mktemp -d "$TMPDIR/p3.XXXX"` HOME;
  - `OPENCHAMBER_DESKTOP_USER_DATA_DIR=<temp>/userData`;
  - the Dev binary launched directly;
  - quit with `kill -TERM <recorded pid>`;
  - the R66 keychain symlinks only where a real keychain is needed.
- Port guard (R46, tightened 19 Oct):
  - before each launch, record the holder of 57133;
  - **before every single HTTP call**, check that the listener on the target port is the test PID or one of its children, and skip the call otherwise;
  - talk only to `$PORT`, the port the test PID bound;
  - never drive the owner's apps.
- Any `node packages/web/bin/cli.js …` or `mittrcraft` run uses `HOME=<temp> OPENCHAMBER_DATA_DIR=<temp>/.config/mittrcraft-dev` (R7).
- Never click "Open MittrCraft Dev" on a browser prompt.
- Record the `mittrcraft-dev` LaunchServices handler and the "MittrCraft Dev Safe Storage" item's presence (exit status only) before and after (R9).
- The owner types every Microsoft, Jira and Plane credential. The controller never types or reads one (R10).

**Third-party egress (R30/R39/R69)**
- Nothing goes to a third party unless the owner allowed it. The allowed destinations are:
  - the Mittr platform: dev `https://api-dev.mittr.asia` (Dev), prod `https://api.mittr.asia`;
  - loopback stubs;
  - in the gate only, with the owner's yes for that run: a catalog connector's own host when the gate runs one of its tools (Task 17).
- MittrCraft never calls Jira or Plane itself; the platform does.
- Opening upstream pages that the gate visits (Settings → Skills, MCP, Integrations) is watched for outbound connections, and any non-loopback connection is a finding.

**Platform (no platform change ships in this phase)**
- Dev product → `https://api-dev.mittr.asia`, overridable by `MITTRCRAFT_BROKER_URL` in Dev. Prod is fixed to `https://api.mittr.asia` (R41).
- Platform `develop` (dev) has multi-workspace Plane (`3da0045f7`): `workspaceSlugs` on `/api/integrations`, per-workspace Plane test results, and `workspace` on `/desktop/work` rows.
- Platform `main` (prod) does not. A PUT there keeps only `workspaceSlug`, its zod schema strips `workspaceSlugs`, and its GET has no `workspaceSlugs`.
- The read-after-save fix (`8d1a35118`) is only on a local platform branch. On dev, a saved connection reaches My work on the mirrors' next read, up to 10 minutes later. The owner said not to ship platform changes now.
- The desktop works with what `develop` has and degrades on `main`. Every platform dependency is a gate NOT RUN row or a platform follow-up.

**Decisions that bind**
- R37/R40, R41, R46, R52, R55, R57, R60, R61, R65–R67, R75/R76, R78 and R104–R109 bind.
- Q6 (`.openchamber/`) is accepted. Q3: platform multi-workspace is not shipped to prod now.
- Owner, 21 Oct: the VS Code extension and the mobile build are out until the owner asks. No task here touches `packages/vscode` or `packages/mobile`.

## Review Focus

1. **An account switch while My work or Work tracking is open, or a request is in flight.** A person must never see one account's work, or save their Jira or Plane token into another account.
   - Task 11 `the reply names the account it was read for`.
   - Task 13 `a reply for another account is dropped and the list reloads`.
   - Task 15 `a save for an account that is no longer active is refused and nothing is sent`.
   - Task 16 `an account change reloads the form and drops what was typed`.
2. **The previous account's skills or connectors after a switch, a sign-out or the first start.** Account B's engine must never start with A's org skills or MCP connectors, even when B's catalog has not arrived yet.
   - Task 8 `a switch reconciles the new account's skills before the engine restarts` and `switching to another account replaces the set even when its catalog has no skills key`.
   - Task 8 `no account removes every org skill`.
   - Task 9 `the managed config holds only the active account's connectors`.
3. **A catalog that omits, empties or corrupts skills or connectors, next to the developer's own.**
   - A missing collection for the same account keeps what is installed (1.22 rule).
   - A skill file path that leaves its folder is refused.
   - The developer's own skills and MCP entries are never touched.
   - Task 7 `an unconfigured collection keeps the last configured one for that account`.
   - Task 8 `a file path that leaves the skill is refused and nothing of that skill is written` and `a developer's own skills beside the org folder are never touched`.
   - Task 9 `two names that clash keep the first and warn once without the config` (and, on the fallback, `a developer's own MCP entries are never touched`).
4. **Jira or Plane tokens leaking.** A token typed into the form must appear in no log line, no file under the data dir or engine folders, no route reply and no engine environment.
   - Task 15 `the token never reaches the log, the disk or the reply`.
   - Task 15 `JIRA_TOKEN and PLANE_API_KEY never reach the engine env`.
   - Task 17 greps the temp HOME and `ps eww` for the typed value and names.
5. **A platform that cannot do what the form or list suggests:**
   - prod has no multi-workspace;
   - dev reads a new connection up to 10 minutes later;
   - an older platform sends no `key` or `workspace`.

   The UI must not offer more than the platform does.
   - Task 16 `a platform without workspaceSlugs shows one workspace and no Add` and `the saved note says new items can take up to 10 minutes`.
   - Task 12 `an item without key shows the Jira browse key or nothing` and `a single Plane workspace shows one Plane chip`.

---

### Task 1: One copy of each shared server and UI helper (phase 2 M1)

**Files:**
- Create in `packages/mittr-server/src/mittr/`, each with a `*.test.js`:
  - `private-file.js`;
  - `values.js`;
  - `json-body.js`;
  - `platform.js`.
- Create `packages/mittr-ui/src/mittrProvider.ts`.
- Modify:
  - **atomic private writes:** `account-store.js`, `local-token.js`, `catalog-cache.js`, `mittr-settings.js`, `identity.js`;
  - **plain-object checks:** `account-store.js`, `default-model.js`, `../settings.js`, `../git-identities.js`;
  - **JSON error wrapper:** `auth-routes.js`, `audit-routes.js`, `provider-lock-routes.js`;
  - **platform constants:** `quota-service.js`, `quota-provider.js`, `quota-routes.js`, `engine-credential.js`, `catalog-routes.js`, `auth-routes.js`, `audit-routes.js`;
  - **mittr-ui provider id:** `providers/useMittrPickerFilter.ts`, `quota/answeredBy.ts`, `quota/quotaError.ts`, `quota/agentStatus.ts`, `quota/AnsweredByNotice.tsx`, `quota/registerMittrUsage.ts`.

**Interfaces:**
- Produces:
  - `writePrivateAtomic(filePath: string, data: string | Buffer, { fs = nodeFs, mode = 0o600 } = {}): void`:
    - writes `${filePath}.${process.pid}.${randomUUID()}.tmp` with `mode`, then renames it onto `filePath`;
    - on any failure it removes the temp file and rethrows.
  - `isRecord(value): value is Record<string, unknown>`: non-null, non-array object.
  - `isPlainObject(value): boolean`: prototype `Object.prototype` or `null`. Each caller keeps the meaning it has today.
  - `jsonBody(express, { limit: string }) -> RequestHandler`: `express.json({ limit })` plus the 400 answer the three route files give today, unchanged.
  - `PLATFORM_TIMEOUT_MS = 15_000`, `CANNOT_REACH_MITTR = 'Cannot reach Mittr'`, `READ_FAILED`: one definition each, used by every platform call. The quota and credential calls move from 10 s to 15 s.
  - `MITTR_PROVIDER_ID = 'mittr'` exported from `packages/mittr-ui/src/mittrProvider.ts`.
- Tasks 7, 8, 11 and 15 use these; none defines its own copy.

- [ ] **Step 1:** Write the failing tests:
  - `private-file.test.js`:
    - `the file is written with mode 600`;
    - `a failed rename leaves no temp file and the old content`: a fake `fs.renameSync` throws, the target still holds the previous text, and no `*.tmp` sibling remains;
    - `two writes in one millisecond use different temp names`.
  - `values.test.js`: `isRecord([])` is false, `isPlainObject(Object.create(null))` is true, and `isPlainObject(new Date())` is false.
  - `json-body.test.js`: `a malformed body answers what the routes answer today`. The expected status and body are taken from today's `auth-routes.test.js` case for a malformed body.
  - `platform.test.js`: `every platform call uses the one timeout`. It scans the listed modules' source for `AbortSignal.timeout(` and expects each argument to be `PLATFORM_TIMEOUT_MS`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: the new tests FAIL (modules missing).
- [ ] **Step 3:** Implement the four modules and move every listed caller onto them. Behaviour stays the same apart from the timeout. In mittr-ui, import `MITTR_PROVIDER_ID` from `mittrProvider.ts` in the six files.
- [ ] **Step 4:** Run `bun run --cwd packages/mittr-server test`, `bun run --cwd packages/mittr-ui test`, `bun run type-check` and `bun run lint`. Expected: all PASS, and `git grep -n "const MITTR_PROVIDER_ID" packages/mittr-ui/src` shows one line.
- [ ] **Step 5:** Commit as two commits: `fix(mittr-server): one atomic private write, one JSON body parser and one platform timeout` and `fix(mittr-ui): one Mittr provider id`.

Upstream files added: 0. Running total: 33.

### Task 2: Upstream-side hook tests use neutral fixtures (phase 2 M4)

**Files:**
- Modify:
  - `packages/ui/src/components/chat/ModelControls.product.test.tsx`;
  - `packages/electron/product.test.mjs`;
  - `packages/electron/deep-link-registry.test.mjs`.
- Create:
  - `packages/mittr-server/src/product-files.test.js`, which takes over the assertions that read `brand/product.*.json`;
  - `scripts/mittr/neutral-hook-tests.mjs` with `scripts/mittr/neutral-hook-tests.test.mjs`.

**Interfaces:**
- Produces `findProductWordsInHookTests({ cwd, base = 'e302062e3' }) -> Array<{ file: string, line: number, text: string }>`. It looks at:
  - every test file outside our owned dirs that differs from `base`;
  - every line matching `/mittr|mittrcraft|api-dev\.mittr|api\.mittr/i`.

- [ ] **Step 1:** Write the failing tests:
  - `a hook test that names the product is reported`: a fixture repo whose `packages/web/x.test.js` contains `'mittr'` gives one finding with its line.
  - `our own packages are not scanned`: `packages/mittr-ui/a.test.ts` is ignored.
  - In `product-files.test.js`, `the prod product fixes the Mittr broker and ignores a launch override` and `the Dev product defaults to the dev platform`. These are the two assertions moved out of `product.test.mjs`, unchanged.
- [ ] **Step 2:** Run `node --test scripts/mittr/neutral-hook-tests.test.mjs` and `node scripts/mittr/neutral-hook-tests.mjs`. Expected: the tests FAIL (module missing).
- [ ] **Step 3:** Implement the scan. In the three upstream-side test files:
  - rename `mittr` to `acme`, "Mittr Writer" to "Acme Writer", `mittrcraft-dev://` to `acme-dev://`, and `api-dev.mittr.asia` to `api.example.test`;
  - `product.test.mjs` uses an inline product fixture, never `brand/`.
- [ ] **Step 4:** Run the scan CLI (expected: `0 findings`), `bun test packages/ui/src/components/chat/ModelControls.product.test.tsx`, `bun run --cwd packages/electron test` and `bun run --cwd packages/mittr-server test`. Expected: PASS. Touch check: 33 of 40, nothing unlisted, nothing stale.
- [ ] **Step 5:** Commit `fix(mittr): upstream-side hook tests use neutral fixtures`. The hook test files are listed, not counted (R25), so no `hook(...)` subject is needed for test-only edits.

Upstream files added: 0. Running total: 33.

### Task 3: The shim's own failures read as plain product text (phase 2 M2)

**Files:**
- Modify `packages/mittr-server/src/mittr/shim-routes.js`, `packages/mittr-ui/src/quota/quotaError.ts` and `packages/mittr-ui/src/strings/mittr.en.ts`.
- Test `shim-routes.test.js` and `quotaError.test.ts`.

**Interfaces:**
- Every failure the shim itself answers keeps its status and headers (including `x-should-retry: false` where it has it today). Its body becomes `{ error: { type: 'mittr_unavailable', code, message } }`, where `message` is today's text unchanged and `code` is one of:
  - `not_signed_in` (401);
  - `switching_account` (503, R76);
  - `platform_unreachable` (502);
  - `platform_timeout` (504);
  - `model_list_unavailable` (503).
- `mittrMessageError` maps each code to `mittr.shim.<code>` in `mittr.en.ts`, with this English text:
  - `not_signed_in`: "Sign in to Mittr to continue.";
  - `switching_account`: "MittrCraft is switching accounts. Send your message again in a moment.";
  - `platform_unreachable`: "MittrCraft cannot reach Mittr right now. Check your connection and send your message again.";
  - `platform_timeout`: "Mittr took too long to answer. Send your message again.";
  - `model_list_unavailable`: "Your Mittr model list is not ready yet. Send your message again in a moment.".
- Refusal bodies (quota, model refusal, `stream_cut_off`) are unchanged.

- [ ] **Step 1:** Write the failing tests:
  - `shim own failures use the error envelope`: for each of the five cases, the body's `error.code` equals the code above, `error.message` equals today's text, and the status and `x-should-retry` header are as today.
  - `each shim failure code reads as product text`: `mittrMessageError({ type:'provider.auth', status:401, providerID:'mittr', responseBody: <envelope with not_signed_in>, message: '' })` returns the `mittr.shim.not_signed_in` text. The same holds for the other four, and never for upstream's "Opencode failed to send message" prefix.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test` and `bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Re-run `node scripts/mittr/probe-engine-v2.mjs --only shim --json $TMPDIR/p3-shim.json` with a stub that answers 401 through the shim. Expected: the engine's stored message equals the envelope's `message`, and the stub sees exactly 1 request.
- [ ] **Step 4:** Re-run both suites. Expected: PASS.
- [ ] **Step 5:** Commit `fix(mittr-server): the shim's own failures carry a code the chat turns into plain text`.

Upstream files added: 0. Running total: 33.

### Task 4: A hosted server never downloads ripgrep from a third party (phase 2 M8)

**Files:**
- Modify `packages/mittr-server/src/cli-env.js`, `packages/mittr-server/bin/mittrcraft.mjs` and `packages/mittr-server/src/ui-auth/README.md`.
- Test `packages/mittr-server/src/mittrcraft-bin.test.js` and `cli-env.test.js`.

**Interfaces:**
- `findRipgrep(pathValue: string, { fs }) -> string | null`: the first executable `rg` on `PATH`.
- `prepareCliEnvironment(...)` gains a result field `ripgrep: { found: string | null, downloadAllowed: boolean }`. `downloadAllowed` is `env.MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD === '1'`.
- When `rg` is missing and the download is not allowed, the bin exits 1 before starting the server, with exactly:
  `ripgrep (rg) is not installed on this server. Install it, or set MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD=1 to let the engine download it from github.com.`
- With the opt-in, it starts and logs once: `[mittr] rg is missing; the engine will download it from github.com on first use`.
- The desktop is unchanged: it packs `rg` (R74).

- [ ] **Step 1:** Write the failing tests:
  - `a hosted start without rg refuses before listening`: with `PATH` set to an empty temp dir, the bin exits 1 with the exact message, and nothing listens on the chosen port.
  - `rg on PATH starts normally`: a temp dir holding an executable stub `rg` gives `ripgrep.found` equal to it.
  - `the opt-in allows the download with one log line`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add one README line under hosted web: "Install ripgrep on the server; MittrCraft does not let the engine fetch it from github.com unless you opt in."
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `fix(mittr-server): a hosted server needs ripgrep installed instead of fetching it from github.com`.

Upstream files added: 0. Running total: 33.

### Task 5: Hosted web branding is generated, not hand-kept (phase 2 M9)

**Files:**
- Create `scripts/mittr/generate-web-brand.mjs` with `scripts/mittr/generate-web-brand.test.mjs`.
- Modify `packages/mittr-server/src/web-brand.json` (regenerated) and `packages/mittr-server/src/web-brand.test.js`.

**Interfaces:**
- `generateWebBrand({ brandDir = 'brand' }) -> object`: derives the web replacements from `brand/visible-strings.json` and `brand/visible-strings.prod.json` by the rule `web-brand.js` reads today.
- The CLI `node scripts/mittr/generate-web-brand.mjs` writes `packages/mittr-server/src/web-brand.json` with a trailing newline and 2-space indent.

- [ ] **Step 1:** Write the failing tests:
  - `the committed web-brand.json equals the generated one`: `generateWebBrand()` deep-equals the parsed committed file.
  - `a new visible string reaches the web brand`: a fixture `brandDir` with one extra entry gives one extra replacement.
- [ ] **Step 2:** `node --test scripts/mittr/generate-web-brand.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Regenerate the file. If the regenerated file differs from today's, the diff is the drift M9 warned about: list it in the commit body.
- [ ] **Step 4:** Re-run that test and `bun run --cwd packages/mittr-server test`. Expected: PASS. In `web-brand.test.js`, replace the "regenerate" hint with the command.
- [ ] **Step 5:** Commit `fix(mittr): hosted web branding is generated from the visible-strings list`.

Upstream files added: 0. Running total: 33.

### Task 6: Prove what OpenCode 2.0.22 does with our skills and MCP connectors (spike)

**Files:**
- Modify `scripts/mittr/probe-engine-v2.mjs` and `scripts/mittr/probe-engine-v2.test.mjs`.
- Create:
  - `scripts/mittr/stub-mcp-server.mjs`: a stdio MCP server with one tool, `lookup`, that answers `{ content: [{ type: 'text', text: 'stub-law-41' }] }` and appends each call to a file named by `--log`;
  - `docs/plans/2026-10-21-phase-3-engine-proof.md`.

**Interfaces:**
- `node scripts/mittr/probe-engine-v2.mjs --only skills-mcp --json <out>` runs the scenarios below on the bundled engine. It uses the phase 2 probe's temp HOME, `XDG_*`, `OPENCODE_CONFIG_DIR` inside it, a loopback stub provider whose model calls the requested tool, and the outbound recorder.
- Pure helper, tested: `mcpEntityFromCatalog(raw) -> object | null`. It calls upstream's `toMcpEntity` from `packages/web/server/lib/opencode/config-v2.js`. The probe is a script, so the import is allowed here. It records which 1.x shapes it accepts.

- [ ] **Step 1:** Write the failing helper tests:
  - `a local 1.x connector becomes a v2 entry`: `{ type:'local', command:['node','x.mjs'], enabled:true }` gives an object with `type:'local'` and the same command.
  - `a remote connector keeps its url and headers`.
  - `an entry without a type is refused`: the result is `null`.
- [ ] **Step 2:** `node --test scripts/mittr/probe-engine-v2.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement six scenarios. Record each with PASS or FAIL in the JSON:
  - **P8 skill discovery:**
    - write `<OPENCODE_CONFIG_DIR>/skills/mittr/probe-skill/SKILL.md` (frontmatter `name: probe-skill`, `description: Probe skill`);
    - the engine's skill list (the client's skill listing, or the skill tool's description in the stub's received request) names it;
    - record the id form (`mittr/probe-skill` or `probe-skill`);
    - repeat with a flat `<OPENCODE_CONFIG_DIR>/skills/mittr-probe-skill/SKILL.md`.
  - **P9 skill hot pickup:** add a second skill while the engine runs. It is listed within 10 s with the engine PID unchanged.
  - **P10 managed connector:**
    - put `mcp.servers['mittr-probe'] = mcpEntityFromCatalog({ type:'local', command:['node', <stub path>, '--log', <log>] })` in the managed config file;
    - within 10 s the engine's MCP status lists `mittr-probe` as connected;
    - a prompt makes the stub model call the tool, and the stub log records one call.
  - **P10b listed in Settings → MCP:**
    - call upstream's MCP list the way `/api/config/mcp` builds it (`readConfigLayers` plus the engine status the route merges), with `OPENCODE_CONFIG` set to the managed file as the engine child gets it;
    - record whether `mittr-probe` is listed, and whether the page would treat it as editable.
  - **P11 fan-out:** create sessions in three temp project dirs and run the tool once in each. Count live stub processes carrying the probe marker (`pgrep -f stub-mcp-server.*<marker>`). Record N; PASS when N ≤ 3.
  - **P12 hot removal:** remove the entry. Within 10 s the stub process exits and the tool is no longer offered.
- [ ] **Step 4:** Run the probe and write the proof note: results, the id form, the process count and every outbound connection seen. **Stop conditions, binding on later tasks:**
  - P8 fails in both layouts: **stop and report**. Catalog skills cannot reach the engine.
  - P8 passes only flat: Task 8 writes `<skills>/mittr-<name>/` with the `.mittr-version` marker as the ownership mark, and drops the `mittr/` folder.
  - P9 fails: after a change, Task 8 calls `context.opencode.refresh('mittr catalog skills changed')`, as 1.22 did, and the note records the restart cost.
  - P10 or P10b fails: Task 9 takes its named fallback. User-scope entries are written through `context.opencode.userConfig` and reconciled per account before each restart.
  - P11 gives more than one process per project: record it as an owner note. It is not a stop.
  - Any non-loopback connection: record the host for the owner.
- [ ] **Step 5:** Commit `docs(mittr): record how OpenCode 2.0.22 finds catalog skills and runs catalog connectors`, with the script, the stub MCP server and the proof note.

Upstream files added: 0. Running total: 33.

### Task 7: Catalog enablement and kept collections (phase 2 carry)

**Files:**
- Create `packages/mittr-server/src/mittr/enablement.js` with `enablement.test.js`.
- Modify `catalog-routes.js` (with `catalog-routes.test.js`), `catalog-cache.js` and `index.js`.
- Test `packages/mittr-server/src/upstream-contract.test.js` (no new upstream symbol; listed for completeness).

**Interfaces:**
- `createEnablementStore({ filePath, fs? }) -> { isEnabled(kind: 'mcp' | 'skills', name: string): boolean, setEnabled(kind, name, enabled: boolean): void, all(): object }`:
  - a port of 1.22 `local-enablement.js`, with the same file `<dataDir>/mittr-enablement.json` and format `{ [kind]: { [name]: { disabled: true, at: <ISO> } } }`, so a 1.22 install keeps its disables;
  - only disables are stored, so an absent entry means enabled;
  - an unreadable file reads as `{}`, as in 1.22;
  - writes use `writePrivateAtomic`.
- `GET /api/mittr/catalog`: each item in `models`, `mcp` and `skills` gains `enabled: boolean`, as in 1.22. Models are always `true`.
- `PUT /api/mittr/catalog/enablement`:
  - body `{ kind, name, enabled }` through `jsonBody(express, { limit: '8kb' })`;
  - `kind` outside `mcp` / `skills`, or an empty `name`, gives 400 `{ error: 'kind must be mcp or skills, and name is required' }`;
  - otherwise `setEnabled(kind, name, enabled !== false)`, then `await onEnablementChange(kind)`, and answers `{ ok: true }`.
- `registerMittrCatalogRoutes(app, { …, enablement, onEnablementChange = async () => {} })`.
- `keepConfigured(previous: Catalog | null, next: Catalog) -> Catalog`: for `mcp` and `skills`, a `next` collection with `configured: false` takes `previous`'s when that one is configured. `catalog-routes.js` writes `keepConfigured(target.read(), catalog)`. Because caches are per account, the rule never carries one account's collection to another.

- [ ] **Step 1:** Write the failing tests:
  - `a disable survives the next sync and an enable removes the entry`: after `setEnabled('skills','card-analysis',false)` the file holds `skills['card-analysis'].disabled === true`; after `setEnabled(..., true)` the key is gone.
  - `a 1.22 enablement file is read as it is`: a fixture written in the 1.22 format disables its entries.
  - `the catalog lists enabled per item`: `GET` with one disabled skill shows `enabled:false` on it and `enabled:true` on the rest, and every model is `enabled:true`.
  - `enablement accepts only mcp and skills`: `{kind:'models',name:'x'}` gives 400 with the exact message.
  - `a change is announced for its kind`: `onEnablementChange` is called once with `'skills'`.
  - `an unconfigured collection keeps the last configured one for that account`: account A's cache has `skills.configured:true` with one item; a sync answering without `skills` leaves that item in A's cache.
  - `a configured empty collection replaces it`: an answer with `skills: []` leaves A's cache configured and empty.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire them in `index.js`. Tasks 8 and 9 fill `onEnablementChange`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): catalog enablement and kept collections, as in 1.22`.

Upstream files added: 0. Running total: 33.

### Task 8: Catalog skills, for the active account only (P3-07)

**Files:**
- Create `packages/mittr-server/src/mittr/skill-reconciler.js` with `skill-reconciler.test.js`.
- Modify `packages/mittr-server/src/mittr/index.js` and `accounts-switch.js`, with `index.test.js` and `accounts-switch.test.js`.

**Interfaces:**
- `parseCatalogSkill(item) -> { name, version, files: Array<{ path, content }> } | null`: a 1.22 port. A `name` matches `/^[a-z0-9]+(-[a-z0-9]+)*$/`, a version is required, and `SKILL.md` must be present. Each path is a normalized relative text file (`.md|.txt|.json|.ya?ml`) with no `..`, no leading `/` and no dot segment.
- `reconcileSkills({ catalog, enablement, skillsRoot, accountHome }) -> { installed: string[], updated: string[], removed: string[], failed: Array<{ name, error }> }`:
  - **org folder:** `path.join(skillsRoot, 'mittr')`, or the flat layout if Task 6 P8 says so;
  - **account marker:** a `.mittr-account` file in the org folder holds the `accountHome` the set was installed for;
  - **no account** (`accountHome` null or `'_none'`): removes every org skill;
  - **another account** (the marker differs): removes every org skill first, then installs that account's set;
  - **same account:** an unconfigured collection keeps what is installed (1.22 rule);
  - **writes:** each skill is staged as a folder and then renamed, as 1.22 did. A `.mittr-version` file means "already installed"; the same version is not rewritten;
  - nothing outside the org folder is read or written.
- `skillsRoot = path.join(engineConfigDir, 'skills')`, with `engineConfigDir` from phase 2's `setupMittr` options.
- `setupMittr` runs `reconcileSkills` at these points:
  - during setup, from the active account's cache, reading the account index only (`store.list({ carryLegacy: false })`, R67), before the engine's first start;
  - inside the switcher's `applyCache`, before `restartOntoTarget`;
  - after each stored sync for the same account;
  - in `onEnablementChange('skills')`.
- After a run that installed, updated or removed anything, it calls `context.opencode.refresh('mittr catalog skills changed')` only if Task 6 P9 failed. A failure is logged with the skill name and never fails the caller.

- [ ] **Step 1:** Write the failing tests (temp dirs only):
  - `installs a catalog skill with its version marker`: `mittr/card-analysis/SKILL.md` and `.mittr-version` exist with the catalog content and version.
  - `the same version is not rewritten`: the second run reports no install or update, and the file's mtime is unchanged.
  - `a withdrawn skill is removed`.
  - `a disabled skill is removed and stays removed across syncs`.
  - `an unconfigured collection keeps the account's installed skills`.
  - `switching to another account replaces the set even when its catalog has no skills key`: the marker is A, the reconcile runs for B with `skills.configured:false`, and A's skills are gone.
  - `no account removes every org skill`.
  - `a file path that leaves the skill is refused and nothing of that skill is written`. It is run for each of `../x.md`, `/etc/x.md`, `.hidden/x.md` and `x.sh`, and the other skills still install.
  - `a developer's own skills beside the org folder are never touched`: `skills/mine/SKILL.md` is byte-identical after every case above.
  - `a failed write leaves the previous version in place`: a staging write that throws keeps the old folder and reports `failed`.
  - `a switch reconciles the new account's skills before the engine restarts`: in `accounts-switch.test.js`, the recorded call order is `reconcile(B)` then `opencode.refresh`.
  - `setup reconciles without opening the keychain`: a store whose `decrypt` throws is never asked to decrypt during setup.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement, porting 1.22 `skill-reconciler.js` (`origin/develop:packages/web/server/lib/mittr/skill-reconciler.js`) with the marker and account rules above.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): catalog skills installed for the signed-in account only`.

Upstream files added: 0. Running total: 33.

### Task 9: Catalog MCP connectors, for the active account only (P3-08)

**Files:**
- Create `packages/mittr-server/src/mittr/mcp-fragment.js` with `mcp-fragment.test.js`.
- Modify:
  - `packages/mittr-server/src/mittr/index.js`;
  - `packages/web/server/lib/server-plugins.js` (generic hook file): the context entry;
  - `packages/web/server/index.js` (already counted): hands upstream's `toMcpEntity`;
  - `brand/upstream-hooks.json`;
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`.
- Test `packages/web/server/lib/server-plugins.test.js`.

**Interfaces:**
- Context: `context.opencode.mcpEntity(raw: object): object | null` is upstream's `toMcpEntity` from `lib/opencode/config-v2.js`, unchanged. With no plugin loaded nothing calls it.
- `mcpServerName(name: string) -> string | null`:
  - `'mittr-' + name.toLowerCase()`, with every character outside `[a-z0-9_-]` turned into `-` and leading or trailing `-` trimmed;
  - `null` when nothing is left;
  - the result always matches upstream's `validateMcpName` rule `^[a-z0-9][a-z0-9_-]*[a-z0-9]$`.
- `mcpFragment({ collection, enablement, toEntity, logger }) -> { mcp?: { servers: Record<string, object> } }`:
  - enabled items only;
  - `item.config` goes through `toEntity`, and an item it rejects is left out;
  - for names that clash, the first wins and the rest are left out;
  - each left-out item logs one line naming the item, never its config;
  - an unconfigured or empty collection gives `{}`.
- `setupMittr`'s `managedConfig()` merges `mcpFragment` over the active account's cached `mcp`. With no account it adds nothing.
  - The written fingerprint (`pendingRendered` / `writtenModels`) covers models and connectors, so a catalog whose only change is a connector rewrites the managed file.
  - `onEnablementChange('mcp')` runs the same `rewriteProviderLock` queue.
- **Fallback (only if Task 6 P10 or P10b failed):** `reconcileUserMcp({ collection, enablement, userConfig, toEntity, accountHome }) -> { created, updated, removed }`:
  - writes `mcp.servers['mittr-…']` entries in the engine's own user config through `context.opencode.userConfig`, only when `ownsEngineUserConfig` holds (phase 2 Task 12 rule);
  - removes `mittr-` entries the active account does not want, and every one when no account is active;
  - never touches other entries;
  - runs at the same four points as Task 8.

- [ ] **Step 1:** Write the failing tests:
  - `renders enabled connectors under mittr- names`: items `iApp Thai Legal` and `docs` give `servers` keys `mittr-iapp-thai-legal` and `mittr-docs`.
  - `a disabled connector is left out`.
  - `two names that clash keep the first and warn once without the config`: `A b` and `a-b` keep the first. The single log line contains `a-b` and no value from either config.
  - `an entry the engine shape rejects is dropped with a warning that quotes no config`.
  - `no account renders no connector`.
  - `the managed config holds only the active account's connectors`: with A's cache holding `x` and B's holding `y`, after a switch to B the rendered managed config has `mittr-y` and not `mittr-x`.
  - `a catalog whose only change is a connector rewrites the managed config`: `context.managedConfig.refresh` is called once.
  - `server-plugins.test.js`: `context hands the engine's MCP entry normaliser`, i.e. `context.opencode.mcpEntity` is a function.
  - Contract item `plugin-context-mcp-entity`: `index.js` passes `toMcpEntity` into the plugin context, and `config-v2.js` still exports it.
  - Fallback only: `a developer's own MCP entries are never touched` and `signing out removes every mittr- entry`, against a temp user config file.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test` and `bun run --cwd packages/web test -- server/lib/server-plugins.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. Append `{ hook: 'server-plugins', why }` to the `packages/web/server/index.js` and `packages/web/server/lib/server-plugins.js` entries in `brand/upstream-hooks.json`. The why: a downstream build turns catalog connector configs into the engine's own entry shape without copying upstream's normaliser.
- [ ] **Step 4:** Re-run both. Expected: PASS. Touch check: 33 of 40, nothing unlisted, nothing stale.
- [ ] **Step 5:** Commit as two commits:
  - `hook(server-plugins): hand plugins the engine's MCP entry normaliser`;
  - `feat(mittr-server): catalog MCP connectors for the signed-in account only`.

Upstream files added: 0 (`index.js` already counted; `server-plugins.js` is a generic hook file). Running total: 33.

### Task 10: The catalog syncs once per trigger (P3-09)

**Files:**
- Modify `packages/mittr-server/src/mittr/catalog-routes.js`, `accounts-switch.js` and `index.js`, with their tests.

**Interfaces:**
- The triggers are:
  - the first engine ready (phase 2 startup sync);
  - a completed sign-in;
  - an account switch;
  - `POST /api/mittr/catalog/sync`.

  Each gives exactly one `GET /desktop/catalog` for that account.
- `sync()` coalesces: a call made while another sync is queued and not yet started joins the queued one and gets its result. A call made while a sync is running queues at most one more.
- A sign-in reaches the switcher as `onAccountChange(new)` and also calls `afterSignIn()`. Together they start one sync.

- [ ] **Step 1:** Write the failing tests (fake fetch counting `/desktop/catalog` requests):
  - `startup gives one catalog request`.
  - `a sign-in gives one catalog request`.
  - `a switch gives one catalog request`.
  - `each sync route call gives one catalog request when called one after another`.
  - `syncs asked while one is running give two requests, not four`: one running and three asked give a total of 2.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL (the sign-in case gives 2 today if both paths sync).
- [ ] **Step 3:** Implement the coalescing in `sync`, and drop the duplicate sign-in sync.
- [ ] **Step 4:** Re-run. Expected: PASS, with phase 2's catalog tests unchanged.
- [ ] **Step 5:** Commit `fix(mittr-server): one catalog read per sign-in, start, switch or request`.

Upstream files added: 0. Running total: 33.

### Task 11: My work on the server (P3-01 server half)

**Files:**
- Create `packages/mittr-server/src/mittr/work-routes.js` with `work-routes.test.js`.
- Modify `packages/mittr-server/src/mittr/index.js`.

**Interfaces:**
- `registerMittrWorkRoutes(app, { broker, ensureFreshSession, fetchImpl, logger })`: a port of 1.22 `mittr-work/{routes,service}.js`, list only. Jira and Plane lookups by key are phase 4 (A-28, A-29).
- `GET /api/mittr/work` answers:
  - 200 `{ configured: true, items: WorkItem[], userId }` after a platform read. `userId` is `session.subject.userId` of the session the read used;
  - 200 `{ configured: false, items: [], userId: null }` with no broker or no signed-in account;
  - the platform's 401 or 403 as `{ error }`, with the platform's `error` text or `Not authorized to read work items`;
  - 503 `{ error: 'Mittr platform is unavailable' }` for a 5xx;
  - 504 `{ error: 'Mittr platform request timed out' }` after `PLATFORM_TIMEOUT_MS`;
  - 502 `{ error: CANNOT_REACH_MITTR }` for a network failure.
- `WorkItem` is the platform row passed through unchanged: `{ id, title, project, phase, state, priority, due, estimate, url, updatedAt, source: 'plane' | 'jira', key: string | null, workspace?: string | null }`.

- [ ] **Step 1:** Write the failing tests (fake fetch):
  - `the platform's items are passed through with the account they belong to`: the fake platform returns two items, and the reply deep-equals `{ configured:true, items:<same>, userId:'u-a' }`.
  - `the reply names the account it was read for`: with `ensureFreshSession` returning account B's session, `userId` is `'u-b'`.
  - `no account answers not configured`.
  - `a 401 passes the platform's message`, `a 5xx answers 503`, `a timeout answers 504`.
  - `the access token appears in no reply or log line`: across all cases above, the logger spy and reply bodies never contain the fake token.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement and register the route in `setupMittr`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): My work reads the signed-in person's Jira and Plane items from Mittr`.

Upstream files added: 0. Running total: 33.

### Task 12: My work list model — grouping, filters, keys, workspaces (P3-02, P3-03)

**Files:**
- Create in `packages/mittr-ui/src/work/`:
  - `workItems.ts` with `workItems.test.ts`;
  - `workPrefs.ts` with `workPrefs.test.ts`.

**Interfaces:**
- `type WorkItem` as in Task 11.
- From 1.22 `myWorkGrouping.ts`, unchanged in behaviour: `sourceOf`, `laneOf`, `lanesOf`, `stateRank`, `stateRankColor`, `groupStartsOpen`, `groupItems`, `countByLane`, `scopeByLane`.
- `displayLanes(items) -> Lane[]`: Plane lanes collapse into one `plane` lane when the items carry at most one distinct workspace, so one workspace looks as before.
- `cardKeyOf(item) -> string | null`: `item.key`, else the Jira browse-URL key (`/\/browse\/([A-Z][A-Z0-9]*-\d+)/`), else `null`.
- `createWorkPrefs(storage: Pick<Storage, 'getItem' | 'setItem'> | null) -> { sourceFilter(): string, setSourceFilter(v: string): void, groupOpen(key: string, rank: number): boolean, setGroupOpen(key: string, open: boolean): void }`:
  - keys `mittrcraft.myWork.source` and `mittrcraft.myWork.groupOpen.<key>`, as in 1.22;
  - every read and write in try/catch;
  - with no stored value, `groupOpen` falls back to `groupStartsOpen(rank)`.

- [ ] **Step 1:** Write the failing tests:
  - Port every case of 1.22 `myWorkGrouping.test.ts` (`origin/develop:packages/ui/src/components/session/myWorkGrouping.test.ts`) unchanged.
  - `two Plane workspaces give two lanes`: items in `techflow` and `mittr` give lanes `plane:mittr` and `plane:techflow` after `jira`.
  - `a single Plane workspace shows one Plane chip`: `displayLanes` gives one lane with key `plane`.
  - `a saved plane filter still means every workspace`: `scopeByLane(items,'plane')` keeps items from both workspaces.
  - `an item without key shows the Jira browse key or nothing`: `cardKeyOf({source:'jira',key:null,url:'https://x.atlassian.net/browse/MRKB-2122'}) === 'MRKB-2122'`, and a Plane item without key gives `null`.
  - `a folded group stays folded`: `setGroupOpen('jira:Done', false)` then `groupOpen('jira:Done', 0) === false`.
  - `storage that throws falls back to defaults`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, then `bun run type-check` and `bun run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-ui): My work grouping, filters, card keys and Plane workspaces`.

Upstream files added: 0. Running total: 33.

### Task 13: My work panel in the sidebar (P3-01)

**Files:**
- Create in `packages/mittr-ui/src/work/`, with tests:
  - `workApi.ts`;
  - `myWorkController.ts`;
  - `MyWorkDialog.tsx` (view);
  - `MyWorkButton.tsx`.
- Modify `packages/mittr-ui/src/product-ui-plugin.tsx` and `packages/mittr-ui/src/strings/mittr.en.ts`.
- Test `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- `fetchMyWork(fetchImpl = runtimeFetch) -> Promise<{ configured: boolean, items: WorkItem[], userId: string | null }>`.
- `type MyWorkState = { status: 'loading' | 'not-connected' | 'error' | 'ready', items: WorkItem[], error?: string }`.
- `createMyWorkController({ fetchWork, currentUserId: () => string | null, listenAccountChanged }) -> { state(): MyWorkState, subscribe(fn): () => void, refresh(): Promise<void>, dispose(): void }`:
  - a reply whose `userId` differs from `currentUserId()` is dropped and starts one reload;
  - an account change reloads;
  - only the latest request may set state.
- `MyWorkDialogView({ state, filter, prefs, onFilter, onRefresh, onOpenUrl, onGoWork, projects })` is markup only. Rows show:
  - the key (`cardKeyOf`), title, state chip (colour from `stateRankColor`), priority and due;
  - links open through upstream `openExternalUrl` (`packages/ui/src/lib/url.ts`).
- `MyWorkButton`:
  - an icon button with the briefcase glyph and tooltip `mittr.work.open` ("My work");
  - it sits in the `sidebar-footer` slot after `MittrAccountMenu`, wrapped in `MittrErrorBoundary` (fails open, R61);
  - it opens the dialog through upstream's `Dialog` primitive.
- Strings: every 1.22 key under `sessions.myWork.*` and `sessions.sidebar.header.actions.myWork`, plus the My work key of `plane-workspaces.i18n.ts`, moves into `mittr.en.ts` as `mittr.work.*` with the English values unchanged.
- **Entry-point choice (an owner decision, see the end).** The footer slot costs no upstream file. 1.22's place, the sidebar header, would cost one more counted file (`SidebarHeader.tsx`).
- Contract items:
  - `projects-store`: `useProjectsStore` still exposes `projects` with `id`, `path`, `label`;
  - `open-external-url`: the `openExternalUrl(url): Promise<boolean>` export.

- [ ] **Step 1:** Write the failing tests:
  - Controller:
    - `a reply for another account is dropped and the list reloads`: the first reply carries `userId:'u-a'` while the current account is `u-b`. The state never shows its items, and fetch is called twice.
    - `not configured shows the not-connected state`.
    - `an account change reloads`.
    - `a slow first reply never overwrites a newer one`.
  - View (`renderToStaticMarkup`):
    - `rows show the key, title and state`: a Jira item shows `MRKB-2122`;
    - `two Plane workspaces show two chips named after them` (`mittr.work.source.planeWorkspace`);
    - `the not-connected state shows its text and no list`;
    - `Mittr strings are English in Japanese` (C-02).
  - Plugin: `the footer slot holds the account menu, then My work`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-ui test` and `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement with upstream primitives (`Dialog`, `Button`, theme tokens, per `theme-system`). Port the layout from 1.22 `MyWorkDialog.tsx`; Go work wiring comes in Task 14.
- [ ] **Step 4:** Re-run both, then `bun run type-check` and `bun run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-ui): My work opens from the sidebar`.

Upstream files added: 0. Running total: 33.

### Task 14: Go work from a card (P3-04)

**Files:**
- Create `packages/mittr-ui/src/work/goWork.ts` with `goWork.test.ts`.
- Modify `MyWorkDialog.tsx`, `MyWorkButton.tsx` and `mittr.en.ts`.
- Test `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- `captureSendSelection() -> { providerID, modelID, agentName?, variant? } | null`: the same resolution upstream's private `captureGuestSendSelection` makes (`packages/ui/src/lib/guests/start-session.ts:181`), built from the same exported resolvers, in the same order. A contract item `guest-send-selection` pins that upstream's function still reads those resolvers.
- `mittrAvailable(selection, catalogAliases: string[], agentStatus: ReadonlyMap<string, AgentStatus> | null) -> boolean | null`:
  - `false` only when the selection's provider is `mittr` and every catalog alias has `state === 'out'`;
  - `null` when the status is unknown, in which case Go work proceeds and the server's 402 explains;
  - `true` otherwise.
- `planGoWork({ item, project, selection, available }) -> { ok: true, title, prompt, directory, selection } | { ok: false, reason: 'no-project' | 'no-model' | 'no-mittr-model' }`.
- `prompt` is exactly 1.22's text (chat content, kept verbatim):
  - with a key: `อ่าน Jira issue {key} ({title}) ที่ {url} แล้วบอกว่าต้องทำอะไร`;
  - without one: `อ่านงาน "{title}" ที่ {url} แล้วบอกว่าต้องทำอะไร`.

  As in 1.22, a Plane item takes the second form.
- `runGoWork(plan, deps) -> Promise<'started' | 'failed'>`, where `deps` is `{ createSession(title, directory, selection), initialize(sessionId), sendMessage(prompt, selection, sessionId, directory), closeDialog(), toast }`:
  - `createSession` is upstream `sessionActions.createSession(title, directory, undefined, undefined, { model: { providerID, id: modelID, variant }, agent }, 'open')`;
  - `initialize` is `useSessionUIStore.getState().initializeNewOpenChamberSession(id, agents)`;
  - `sendMessage` is the store `sendMessage` already pinned by contract C9.
- No session is created when the plan is not ok. The texts are:
  - `no-model`: `mittr.work.error.noModelSelected`;
  - `no-mittr-model`: `mittr.work.error.noMittrModel`, "No Mittr model is available to you this week.";
  - `no-project`: `mittr.work.projectMenu.empty`.
- Contract item `session-create-selection`: `createSession`'s six-parameter signature with `selection` and `navigation`.

- [ ] **Step 1:** Write the failing tests:
  - `a Jira card's prompt carries its key, title and link`: the exact string for `MRKB-2122`, `Fix login`, `https://x.atlassian.net/browse/MRKB-2122`.
  - `a Plane card's prompt carries its title and link`.
  - `no model selected creates no session`: `createSession` is never called, and the no-model text is shown.
  - `every Mittr agent used up creates no session`: aliases `a` and `b` are both `out`. The plan is `no-mittr-model` and `createSession` is never called.
  - `an unknown quota still starts the work`: `available === null` gives `ok:true`.
  - `the session is created on the selection and opened`: `createSession` gets the selection and `'open'`, then `sendMessage` gets the same `sessionId`, and the dialog closes.
  - `a failed send after creation reports start failed`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire the project menu and Go work button in the dialog. Keep 1.22's "Start in which project?" menu, listing `useProjectsStore` projects.
- [ ] **Step 4:** Re-run, then `bun run --cwd packages/mittr-server test`, `bun run type-check` and `bun run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-ui): Go work starts a session from a card in the chosen project`.

Upstream files added: 0. Running total: 33.

### Task 15: Work tracking on the server, per account, storing nothing (P3-05, P3-06 server half)

**Files:**
- Create `packages/mittr-server/src/mittr/integrations-routes.js` with `integrations-routes.test.js`.
- Modify `packages/mittr-server/src/mittr/index.js` and `packages/mittr-server/src/plugin.js` (`SERVER_ONLY_SECRETS`), with `plugin.test.js` and `upstream-contract.test.js` (the `server-only-secrets` item).

**Interfaces:**
- `registerMittrIntegrationsRoutes(app, { express, broker, ensureFreshSession, fetchImpl, logger })`, a port of 1.22 `mittr-integrations/*`. Every reply adds `userId` from the session used.
  - `GET /api/mittr/integrations` → the platform's `{ jira: { baseUrl, email, hasToken, configured }, plane: { baseUrl, workspaceSlug, workspaceSlugs?, hasApiKey, configured } }`, plus `userId`.
  - `PUT /api/mittr/integrations`:
    - body `{ expectUserId: string, jira?, plane? }` through `jsonBody(express, { limit: '16kb' })`;
    - when the fresh session's `subject.userId !== expectUserId` it answers 409 `{ error: 'The Mittr account changed. Open the settings again.' }` and sends nothing;
    - otherwise it forwards `{ jira?, plane? }` only, with `expectUserId` removed, and answers the platform's config plus `userId`.
  - `POST /api/mittr/integrations/jira/test` and `POST /api/mittr/integrations/plane/test` pass the platform's result through, including `workspaces` per slug when the platform sends it.
  - Not signed in: 401 `{ error: 'Sign in to Mittr first' }`. No broker: 503 `{ error: 'Mittr platform is not reachable from this install' }`. Platform errors pass through as 1.22 did.
  - An unexpected failure logs `[mittr] work tracking request failed: <route> <status>`, never a body.
- `SERVER_ONLY_SECRETS` gains `JIRA_TOKEN` and `PLANE_API_KEY`, the platform's own names for these credentials. The `server-only-secrets` contract item's list is updated to match.

- [ ] **Step 1:** Write the failing tests (fake fetch, temp data dir):
  - `GET answers the platform's config with the account it is for`.
  - `PUT forwards only jira and plane`: the platform body deep-equals `{ jira: { baseUrl:'https://x.atlassian.net', email:'a@x', token:'jira-secret-123' } }`.
  - `a save for an account that is no longer active is refused and nothing is sent`: `expectUserId:'u-a'` while the session is `u-b` gives 409, the exact message, and 0 platform calls.
  - `omitting the token keeps the saved one`: a body without `token` is forwarded without it.
  - `the token never reaches the log, the disk or the reply`, for `jira-secret-123` and a Plane key `plane-secret-456`:
    - the logger spy has no line containing either;
    - a recursive read of the temp data dir finds neither;
    - the reply carries `hasToken:true` and neither value.
  - `the Plane test passes per-workspace results through`.
  - `a platform without workspaceSlugs passes its single slug through unchanged`.
  - `JIRA_TOKEN and PLANE_API_KEY never reach the engine env`: in `plugin.test.js`, with both set in `env`, `engineEnv()` holds both keys as `undefined`.
- [ ] **Step 2:** `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement and register the routes in `setupMittr`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): Jira and Plane settings go to the signed-in account on Mittr and stay off this machine`.

Upstream files added: 0. Running total: 33.

### Task 16: Settings → Integrations → Work tracking (P3-05, P3-06 UI half)

**Files:**
- Modify (hook):
  - `packages/ui/src/lib/product-plugins.ts` (generic hook file): the slot name;
  - `packages/ui/src/components/sections/integrations/IntegrationsPage.tsx` (**new upstream file, +1**);
  - `brand/upstream-hooks.json`.
- Test (hook): `packages/ui/src/lib/product-plugins.test.ts` and `packages/mittr-server/src/upstream-contract.{js,test.js}`.
- Create in `packages/mittr-ui/src/work-tracking/`, each with tests:
  - `integrationsApi.ts`;
  - `workTrackingForm.ts`;
  - `workTrackingController.ts`;
  - `WorkTrackingSection.tsx`.
- Modify `packages/mittr-ui/src/product-ui-plugin.tsx` and `mittr.en.ts`.

**Interfaces:**
- **Hook.**
  - `ProductSlotProps` gains `'integrations-page': Record<never, never>`.
  - `IntegrationsPage.tsx` renders `<ProductSlot name="integrations-page" />` once, right after the built-in integrations section. This is where 1.22 put Work tracking.
  - With no plugin the page is unchanged.
  - Contract item `integrations-page-slot` asserts that line.
- **Form helpers** (`workTrackingForm.ts`), ported from 1.22:
  - `slugFromInput(value) -> string`: takes the first path segment of a pasted workspace URL;
  - `slugsOf(plane) -> string[]`;
  - `addWorkspace(list, input) -> { list } | { error: 'empty' | 'duplicate', slug? }`;
  - `jiraSaveBody(form, expectUserId)`;
  - `planeSaveBody(form, expectUserId)`: sends `workspaceSlug: slugs[0]` and `workspaceSlugs`, so both platforms keep the first;
  - `KEEP_PLACEHOLDER = '••••••••••••'`.
- `multiWorkspaceSupported(config) -> boolean` is `Array.isArray(config.plane.workspaceSlugs)`. When false (prod today):
  - the workspace list shows the one saved slug;
  - the Add control is hidden;
  - `mittr.workTracking.plane.singleWorkspace` reads "This Mittr server keeps one Plane workspace."
- `createWorkTrackingController({ api, currentUserId, listenAccountChanged })`:
  - loads the form for the current account;
  - an account change reloads and drops anything typed;
  - a 409 from save reloads and shows `mittr.workTracking.accountChanged`;
  - a token field is never pre-filled, and only `KEEP_PLACEHOLDER` shows that one is saved.
- After a successful save, `mittr.workTracking.savedNote` reads "Saved. New items can take up to 10 minutes to show in My work." This is true on dev without `8d1a35118`, and stays true with it.
- Strings: every 1.22 key under `settings.integrations.workTracking.*` and the settings keys of `plane-workspaces.i18n.ts` move to `mittr.workTracking.*`, English values unchanged, plus the three new keys above.

- [ ] **Step 1:** Write the failing tests:
  - Hook:
    - `the integrations page slot renders its components`: in `product-plugins.test.ts`, a plugin filling `integrations-page` renders through `ProductSlot`;
    - the contract item.
  - Form:
    - `a pasted workspace URL gives its slug`: `https://plane.example.com/techflow/projects` gives `techflow`;
    - `a duplicate workspace is refused`;
    - `the Plane save keeps the first slug for older platforms`.
  - Controller:
    - `an account change reloads the form and drops what was typed`;
    - `a refused save for a changed account reloads and says so`;
    - `the token field is never filled from the server`.
  - View (`renderToStaticMarkup`):
    - `a platform without workspaceSlugs shows one workspace and no Add`;
    - `the saved note says new items can take up to 10 minutes`;
    - `per-workspace test results show one row each` (`{slug,ok,count}` gives "{count} projects", and a failure gives "Cannot open: {error}");
    - `Mittr strings are English in Japanese`.
- [ ] **Step 2:** `bun test packages/ui/src/lib/product-plugins.test.ts`, `bun run --cwd packages/mittr-ui test` and `bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement the hook first, and append `{ hook: 'integrations-page', why }` to `brand/upstream-hooks.json` for `IntegrationsPage.tsx` and `product-plugins.ts`. The why: a downstream build adds its own integration settings to the page without editing the page's sections. Then build the section with upstream's `SettingsSection`, `Input`, `Button` and toasts (per `settings-ui-patterns`), porting 1.22 `WorkTrackingIntegrationsSection.tsx`. Register `'integrations-page': WorkTrackingSection` wrapped in `MittrErrorBoundary`.
- [ ] **Step 4:** Re-run all three, then `bun run type-check`, `bun run lint` and `node scripts/mittr/test-baseline.mjs`. Expected: PASS. Touch check: **34 of 40**, nothing unlisted, nothing stale.
- [ ] **Step 5:** Commit as two commits:
  - `hook(integrations-page): a slot for product integration settings on the Integrations page`;
  - `feat(mittr-ui): Jira and Plane settings with several Plane workspaces under Integrations`.

Upstream files added: 1. Running total: 34.

### Task 17: Phase 3 gate — every P3 check on an isolated Dev build

**Files:**
- Create `docs/plans/2026-10-21-phase-3-gate.md`.

**Isolation.** Every launch follows the Global Constraints:
- a fresh `p3.XXXX` temp HOME per scenario;
- the Dev binary launched directly, and killed by its PID;
- a before and after `stat` of the real dirs;
- the R46 per-call port guard;
- the LaunchServices handler and keychain item recorded (R9);
- the installed apps untouched.

The evidence (screenshots, logs, JSON, `ps` and `lsof` samples) goes to the phase's working-notes folder outside the repository. It holds no secret, and the gate note never names the folder.

The gate runs in two parts:
- **Part A** is headless. It runs against a loopback stub platform and needs no owner.
- **Part B** runs with the owner on the dev platform as account A.

- [ ] **Step 1:** Build and static checks:
  - `node scripts/mittr/build-desktop.mjs --flavor dev`: exit 0, leak scan clean;
  - `node scripts/mittr/check-upstream-touch.mjs --no-write`: **34 of 40**, nothing unlisted, nothing stale;
  - `bun run type-check`, `bun run lint`, `node scripts/mittr/test-baseline.mjs`;
  - `bun run --cwd packages/mittr-server test`, `bun run --cwd packages/mittr-ui test`, `bun run --cwd packages/mittr-opencode test`, `node scripts/mittr/neutral-hook-tests.mjs`.

  Expected: no failure outside `brand/test-baseline.json`, and 0 findings from the neutral-fixture scan.
- [ ] **Step 2 — Part A, headless.**
  - **Setup.** Extend the Part A stub broker of phase 2 with two stub accounts, SA and SB, each with its own:
    - `/desktop/catalog` (SA: skill `card-analysis` and connector `stub-law`, a local stdio `stub-mcp-server.mjs`; SB: skill `notes` and no connectors);
    - `/desktop/work` (SA: one Jira item `MRKB-1` and one Plane item in each of `techflow` and `mittr`; SB: one Plane item);
    - `/api/integrations` in two shapes: develop-shaped with `workspaceSlugs`, and main-shaped without it.
  - **Recording.** Run with `MITTRCRAFT_BROKER_URL=http://127.0.0.1:<stub>` and `MITTRCRAFT_SHIM_LOG=1`. For each check record the command, the observed value, and PASS or FAIL.
  - **P3-01 / P3-02 / P3-03** (SA):
    - the footer button opens My work, with three rows and keys shown (`MRKB-1` and the Plane keys);
    - there are three chips: Jira, `techflow` and `mittr`;
    - choosing a Plane chip shows only that workspace;
    - folding a status group survives closing and reopening;
    - a link opens through `openExternalUrl` (stubbed to record the URL; no browser);
    - screenshots in light and dark.
  - **Account switch** (Review Focus 1–2):
    - sign SA and SB in through the stub; with My work open, switch to SB: the list reloads with SB's single row, and no SA row is ever shown (record each render);
    - after the switch, before SB's first sync completes, `<engine config>/skills/mittr/` holds no `card-analysis` and the managed config has no `mittr-stub-law`;
    - after the sync, SB's `notes` skill is present;
    - sign out of both: no org skill and no `mittr-` connector remains.
  - **P3-04** (SA):
    - Go work on `MRKB-1` → choose a temp project: a new session opens in that project, titled with the card, with the first user message equal to the exact Jira prompt and a stub agent answer;
    - with every SA agent set to `out` in the stub's quota: the no-Mittr-model text shows and `GET /api/session` gains no session.
  - **P3-05 / P3-06:**
    - **develop shape:** save the Jira fields with a token value held in a shell variable; Test shows the stub's display name; reload shows the site and email with the token masked;
    - paste two workspace URLs, Save, Test: two rows with counts; remove one, Save, reopen: one row;
    - the saved note shows;
    - **main shape:** one workspace row and no Add control.
  - **Secrets** (Review Focus 4):
    - `grep -r -F` of the token value across the temp HOME finds nothing (the value is held in a shell variable and never written to the note);
    - the server and engine logs have no match;
    - `ps eww <engine pid>` shows no `JIRA_TOKEN` or `PLANE_API_KEY`, while the launching env had both set to dummy values.
  - **409 path:** a PUT carrying SA's `expectUserId` while SB is active answers 409 and the stub records no PUT.
  - **P3-07** (SA): Settings → Skills lists `card-analysis`; asking for its trigger makes the stub model receive the skill. After the stub withdraws it and `POST /api/mittr/catalog/sync`, it is gone, with the engine PID unchanged (or the one restart Task 6 P9 recorded).
  - **P3-08** (SA):
    - Settings → MCP lists `mittr-stub-law` as connected (or, on the Task 9 fallback, as a user entry);
    - a session runs `lookup`, which answers `stub-law-41`;
    - open three temp projects and run it in each: `pgrep` counts at most one stub process per project, against Task 6's figure.
  - **Enablement:** `PUT /api/mittr/catalog/enablement {kind:'skills',name:'card-analysis',enabled:false}`: the skill is removed and stays removed after the next sync; `enabled:true` brings it back.
  - **P3-09:** the stub counts `GET /desktop/catalog` for:
    - a fresh start;
    - a sign-in;
    - a switch;
    - two consecutive sync route calls.

    Expected: 1, 1, 1 and 2.
  - **M2:** with the stub broker stopped, a chat message shows "MittrCraft cannot reach Mittr right now…" and not upstream's prefix. With no account, it shows "Sign in to Mittr to continue." (the Task 9 carry from phase 2).
  - **M8:** the packed `mittrcraft serve` with an empty `PATH` dir refuses with the exact message; with a stub `rg` it starts.
  - **C-02:** with the UI in Japanese, My work, Go work and Work tracking show English Mittr strings and no raw `mittr.*` key.
  - **Egress:**
    - an `lsof` watcher every 0.3 s on the app, server and engine PIDs while each check above runs, and while Settings → Skills, MCP and Integrations are opened;
    - Expected: loopback only. Any other host is recorded as a finding with the page that caused it.
- [ ] **Step 3 — Part B, INTERACTIVE BLOCK (owner at the keyboard; one sitting).** The owner types every Microsoft, Jira and Plane credential. The controller only reads results (R10). Each platform admin change needs the owner's yes and is recorded with its before value (R8). Do in order:
  1. Sign in as A on a fresh HOME.
  2. The owner enters A's real Jira site, email and token, and Plane address, token and **two** Plane workspaces A belongs to; then Save and Test.
  3. With the owner's yes: withdraw one catalog skill from the dev catalog (or disable `card-analysis`), and record which.
  4. With the owner's yes for this run only: run one tool of a catalog connector that talks to a third party (for example iApp Thai Legal). Without a yes, record that row as NOT RUN with the reason "third-party egress not approved".
  5. After the checks below: restore every change from item 3, and record before and after.
- [ ] **Step 4 — Part B checks**, headless reads after the block:
  - **P3-01 / P3-02 / P3-03:** My work lists A's Jira issue and Plane items with titles and keys, and two Plane chips. A newly added workspace's item may take up to 10 minutes on dev, because `8d1a35118` is not there; record the wait seen.
  - **P3-04:** Go work on a real Jira card: a session in the chosen project, the exact prompt, and a Mittr agent answer.
  - **P3-05 / P3-06:**
    - Test shows A's Jira name;
    - a junk token shows the Jira error, after which the owner re-enters the real one;
    - reload masks the token;
    - two workspace rows with ok and counts; remove one, Save, reopen: one row;
    - then the owner restores the second.
  - **P3-07:** `card-analysis` from the dev catalog is listed and used. After item 3's withdrawal and a sync, it is gone.
  - **P3-08:** the dev catalog connector is listed as connected; its tool answers, or the row is NOT RUN per item 4.
  - **P3-09:** the dev platform log (or the shim log) shows one catalog read per trigger.
  - **Platform rows recorded as NOT RUN with reason:**
    - multi-workspace on prod (`3da0045f7` is not on platform `main`);
    - immediate read after save (`8d1a35118` not shipped);
    - a second real Mittr account (none; Part A's SA/SB covers the switch).
- [ ] **Step 5:** Isolation evidence:
  - the real dirs `diff` is empty;
  - no upstream default dirs in any temp HOME;
  - the installed apps' PIDs and uptime are unchanged;
  - the holder of 57133 before each launch, and every `$PORT` call guarded;
  - the R9 handler and keychain item, before and after;
  - the R8 restore table;
  - the egress table.
- [ ] **Step 6:** Write the gate note:
  - a verdict table by group: My work, Go work, work tracking, skills, MCP, sync, accounts, secrets, egress, hygiene;
  - every row with evidence, and findings numbered;
  - the upstream touch count, with the one new file's hook and reason;
  - a "needs the owner" list naming each NOT RUN row and what would unblock it;
  - platform follow-ups: ship `3da0045f7` and `8d1a35118` to prod when the owner says, plus phase 2's open ones (agentStatus keyed by alias, `agent_not_granted` for a withdrawn alias, the desktop sign-in nonce).

  Commit `docs(mittr): phase 3 gate on the Dev build`. **Do not push.**

Upstream files added: 0. Running total: 34.

---

## Coverage and budget

| Inventory item or carry | Task(s) |
|---|---|
| P3-01 My work panel | 11, 13, 17 |
| P3-02 grouping, filters, keys | 12, 13, 17 |
| P3-03 several Plane workspaces in My work | 11, 12, 13, 17 |
| P3-04 Go work | 14, 17 |
| P3-05 Work tracking: Jira | 15, 16, 17 |
| P3-06 Work tracking: Plane, several workspaces | 15, 16, 17 |
| P3-07 catalog skills | 6, 7, 8, 17 |
| P3-08 catalog MCP connectors | 6, 7, 9, 17 |
| P3-09 when the catalog syncs | 10, 17 |
| Phase 2 carry: catalog `enabled` flag and `PUT /api/mittr/catalog/enablement` | 7, 17 |
| Phase 2 final review M1 (duplicated helpers) | 1 |
| Phase 2 final review M2 (shim error shape; "not signed in" legible in chat) | 3, 17 |
| Phase 2 final review M4 (neutral hook-test fixtures) | 2 |
| Phase 2 final review M8 (hosted `rg` download) | 4, 17 |
| Phase 2 final review M9 (generated `web-brand.json`) | 5 |
| C-01 Integrations → Work tracking page | 16, 17 |
| C-02 Mittr strings in English in every locale | 13, 16, 17 |
| Per-account install of skills and MCP (Review Focus 2) | 8, 9, 17 |
| Jira/Plane secrets (Review Focus 4) | 15, 17 |

Carried, not in this phase. Each goes where its own work is:
- phase 5 polish:
  - the Usage "Could not read…" loading wording;
  - the "Other Models" heading (F11);
  - the README `BUN_BINARY` line;
  - hosted-web favicon and PWA icons and `mobile.html`;
- phase 4, with A-28/A-29: Jira and Plane lookup by key;
- the platform follow-ups listed in Task 17.

New upstream files counted this phase: 1.

| File | Task | Hook |
|---|---|---|
| `packages/ui/src/components/sections/integrations/IntegrationsPage.tsx` | 16 | `integrations-page` |

Edits to files already counted or generic (no count change):
- `packages/web/server/index.js` (Task 9);
- `packages/web/server/lib/server-plugins.js` (Task 9);
- `packages/ui/src/lib/product-plugins.ts` (Task 16).

### Budget after phase 3

| Point | Counted files | Remaining of 40 |
|---|---|---|
| After phase 2 (today) | 33 | 7 |
| **After phase 3 (this plan)** | **34** | **6** |
| Phase 4 projected (voice and tools): `permission-auto-accept/runtime.js`, `ComposerFooter.tsx`, `VoiceSettings`, `ComposerDictation` | +4 → 38 | 2 |
| Phase 5 projected (UX): `ChatInput.tsx`, `MainLayout.tsx`, `useUIStore.ts`, `ContextSidebarTab.tsx` | +4 → **42** | **−2** |
| Phase 5 with both named savings (sidebar side kept in `mittr-settings.json` instead of `useUIStore.ts`; the activity timeline as a built-in Work Status section extension instead of `ContextSidebarTab.tsx`) | +2 → **40** | 0 |

- **Freed by the owner's 21 Oct decision (VS Code and mobile out).** The phase 2 projection of about 8 files named no VS Code or mobile file, so the named projection does not move. What leaves is the unprojected risk:
  - the inventory's VS Code source ports (`packages/vscode/src/skillsCatalog.ts` and `quotaProviders.ts`, C-09, P5-10), estimated at 1–3 counted files;
  - mobile branding, which was package-time only (0 files).

  That risk no longer threatens the cap.
- **Still unprojected in phase 4:** A-13/A-18/A-26 may need `agent-tool/runtime.js` (+1) if our own tool wrapper cannot carry the image content.
- **Plainly:** phase 3 fits (34). Phases 4–5 fit the cap of 40 only if both phase 5 savings land and phase 4 needs no `agent-tool/runtime.js` hook. Otherwise the total reaches 41–43. That is an owner decision before phase 5: raise the cap, or accept a reduced variant.

## Owner decisions this plan needs

1. **Budget for phases 4–5** (table above). Approve now that phase 5 must take both savings, or decide later between raising the cap and reducing scope. Phase 3 itself stays within the cap.
2. **Deviation from spec §5.4.** My work and Work tracking live in `packages/mittr-ui` with server routes in `packages/mittr-server`, not in a built-in SDK extension (reasons under Architecture). `packages/mittr-extensions` is not created.
3. **Work tracking placement.** The default is Settings → Integrations through one slot (+1 counted file, as 1.22). The alternative is a "Connections" view inside My work (0 files), at the cost of 1.22's place in Settings.
4. **My work entry point.** The default is an icon button in the sidebar footer, beside Settings and the account menu (0 files). The alternative is 1.22's sidebar header (+1 counted file, `SidebarHeader.tsx`).
5. **Third-party egress in the gate.** Running one tool of a catalog connector that calls a third party (for example iApp) sends one query there. It needs the owner's yes for that run (Task 17 Part B item 4).
6. **Platform, no change shipped now.**
   - Dev shows a new Plane or Jira connection's items up to 10 minutes later until `8d1a35118` ships.
   - Prod keeps one Plane workspace until `3da0045f7` ships.

   The desktop handles both. Shipping them is the owner's call in the platform repo.
7. **Skill and connector enablement** ships as the 1.22 API only, with no screen (1.22 had no caller). The upstream Skills page may still let a person edit or delete an org skill, which the next version change or sync puts back, as in 1.22. Accept as 1.22, or ask for a Mittr enablement screen later (it would need a place: one more slot).
