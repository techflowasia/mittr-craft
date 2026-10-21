# Upstream Rebase — Phase 4A: Agent and Automation Tools on the 2.1.1 Base — Implementation Plan

> **For the executor:** implement task by task, with a review after each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A MittrCraft Dev build on upstream 2.1.1 whose agents can drive the person's Chrome (with per-site approval that auto-accept never answers), look at and launch desktop apps, read Jira and Plane cards by key, and see the screenshots they take, with every tool switchable in Settings. Upstream's own control, schedule and browser-panel tools are verified, not ported. Voice (4B) is out, except the action registry it will call.

**Architecture:**
- **Server.** Everything Mittr lives in `packages/mittr-server/src/mittr/tools/`, behind the phase 2 plugin context:
  - one action registry holds every Mittr action (Chrome, computer, Jira, Plane) next to upstream's control contract, and forwards upstream actions to upstream's control service through a new `context.control` handle;
  - a generated OpenCode 2 plugin (`<dataDir>/engine-plugins/mittrcraft-tools/`, listed in the managed config fragment like the identity plugin) offers `mittrcraft_chrome`, `mittrcraft_computer` and `mittrcraft_work` as direct tools, and calls back to a loopback-only route outside `/api` with a per-start token, exactly as the shim does;
  - drivers are the bundled `agent-browser` 0.38.1 and `cua-driver` 0.28.2, pinned by sha256 and copied from local caches; nothing is downloaded.
- **Engine.** Task 1 proves on the bundled OpenCode 2.0.22 how a plugin tool raises the permission prompt, carries an image the model sees, and sits beside upstream's `openchamber_*` tools. Tasks 5 and 8 take the route the spike proves.
- **UI.** `packages/mittr-ui/src/tools/` renders the Computer and Chrome switches, the Chrome profile, the visible-window switch and the allowed-sites list through the existing `integrations-page` slot (0 files). Upstream's own Tools section keeps the control, browser-panel, notify and Code Mode switches.
- **Upstream touch.** One counted file is expected: `permission-auto-accept/runtime.js` for "never auto-answer these requests" (A-30), and only if the spike chooses the engine's own prompt. A second, `agent-tool/runtime.js`, is a named fallback if our plugin cannot wrap upstream's capture result. `server/index.js` is already counted.

**Tech Stack:**
- Bun workspaces: installed bun 1.3.14 (R3). Node ≥ 22 via `nvm use` (R4).
- Electron 43 and electron-builder 26; React/Vite UI.
- Tests:
  - `node:test` for `packages/mittr-*` server code and `scripts/mittr/*`;
  - `bun:test` through `scripts/run-isolated-tests.mjs` for the UI;
  - vitest for upstream web server hook tests.
- OpenCode 2.0.22 (bundled CLI, `@opencode/client` and `@opencode/schema` 2.0.22).
- Drivers: `agent-browser` 0.38.1 (Apache-2.0), `cua-driver` 0.28.2 (MIT, shipped as `CuaDriver.app`). Google Chrome 155.0.8059.85 is installed on this Mac.
- Mittr platform routes (main and develop):
  - `POST /desktop/browser/next-step`;
  - `GET /desktop/jira/issues/:key`;
  - `GET /desktop/plane/issues?ref=`.

**Spec:** `docs/specs/2026-10-16-upstream-rebase-design.md` (§5.4, §5.6 hook 4, §6 "Agent tools", §9 gate 4) and `docs/plans/2026-10-17-feature-inventory.md` §5 (A-01 to A-33 and the shared facts), §7, §9, §10, and P4-V6 to P4-V8 for the seam. House style and carried rulings: `docs/plans/2026-10-21-upstream-rebase-phase-3.md`, `docs/plans/2026-10-21-phase-3-gate.md` and `docs/plans/2026-10-21-phase-3-engine-proof.md`.

## Global Constraints

**Where the work happens**
- Branch `rebase/upstream-2.1.1` in `~/Documents/mittr-craft/.worktrees/rebase-2x`, starting at `3206ca6ce` (phase 3 done). Upstream base `e302062e3` (`brand/UPSTREAM`).
- Never touch the main checkout, other worktrees, `develop`, `main` or any remote. **No push.** I3 and I5 stay open and are not part of this phase.
- The one exception to "never touch the main checkout" is a **read-only copy** of the two driver files already in its untracked build cache (Task 2). Nothing there is written, moved or run.
- Run every node or bun command after `source ~/.nvm/nvm.sh && nvm use` in the worktree (R4). Use the installed bun 1.3.14 and install no other (R3). If `bun install` rewrites the `bun.lock` format, stop and report.

**Code and copy**
- Write no new code comments or docstrings. Code, tests, fixtures, docs and commit messages are in English.
- The one Thai text this phase adds is the Chrome page banner, copied verbatim from 1.22 `chrome-control.js` (`MittrCraft agent กำลังควบคุมหน้าต่างนี้ · MittrCraft agent is controlling this window`). It is drawn on pages the agent drives, not in the app UI.
- Tool and action descriptions the model reads are copied from 1.22 `agent-tool/runtime.js` and `mittrcraft-control/actions.js`, with "MittrCraft Tools" and the in-app panel tool name updated to 2.1.1 (`openchamber_web` is the panel tool; its visible name is branded by the visible-strings step).
- User-facing strings:
  - Mittr-only UI strings live in `packages/mittr-ui/src/strings/mittr.en.ts`, read through `mittrT(key, vars)` / `useMittrT()`, English in every locale (C-02);
  - `strings/en.ts` holds only overrides of upstream keys; upstream locale files are never edited; upstream `t()` is never called with a Mittr key.
- Everything visible must work (owner rule, 15 Oct). A switch for a tool this install cannot run (hosted web, a driver not bundled, Chrome not installed) is hidden, with at most one plain line saying why. No disabled control with a promise.
- Files we own: `packages/mittr-*/**`, `brand/**`, `scripts/mittr/**`, `patches/**`, `docs/**`. Everything else is upstream.

**Commits**
- Only the existing style: `feat(mittr-server|mittr-ui|mittr): …`, `fix(…): …`, `hook(<name>): …` with a one-paragraph why for any upstream file, `docs(…): …` for notes.
- The working-notes folder that holds the ledger, reports and gate evidence is git-ignored and never named in tracked files.

**Upstream touch**
- The cap is 40 (R35/R36). It is **34 counted today**.
- This phase adds **0 to 2** counted files (table under "Coverage and budget"): `permission-auto-accept/runtime.js` (+1, Task 8, path E only) and `agent-tool/runtime.js` (+1, Task 5, only if Task 1 P13b fails). `packages/web/server/index.js` is already counted. `packages/web/server/lib/server-plugins.js` is a generic hook file and not counted.
- Each hook is generic: it names no Mittr concept, keeps upstream behaviour when unused, and has one call site.
- Run `node scripts/mittr/check-upstream-touch.mjs --no-write` after any hook: nothing unlisted, nothing stale, and the count each task states.
- Every task that adds a hook has the step "append `{hook, why}` to `brand/upstream-hooks.json` for every upstream file this hook touches" (R48).
- Every new upstream module, symbol, setting key, event shape or route mittr-server or mittr-ui relies on gets an entry in `packages/mittr-server/src/upstream-contract.js` and its check in `upstream-contract.test.js`, in the task that starts relying on it.
- Hook tests in upstream files use neutral fixtures (`acme`, `acme_browser`, `api.example.test`): `node scripts/mittr/neutral-hook-tests.mjs` reports 0 findings after every hook task.

**Dependencies and imports**
- mittr-server imports nothing from `@openchamber/web`. Upstream services reach it through the plugin context, and `express` is `context.express`. The probe scripts in `scripts/mittr/` may import upstream modules, as phase 3's did.
- Add no npm dependencies. The two drivers are binaries packed as resources, not dependencies.
- The generated engine plugin has no `import` statement (OpenCode loads it with a bare dynamic import from its own folder).

**Tests**
- UI behaviour is tested as a pure controller plus static markup (`renderToStaticMarkup`), or with upstream's hand-rolled hook harness. There is no DOM library (R11).
- Every test, runner and probe runs isolated (F9). Every test command below is written `iso <command>`, where `iso` is this shell function, defined once per shell:

  ```bash
  iso() {
    local t; t=$(mktemp -d "$TMPDIR/p4.XXXX")
    env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG_CONTENT -u OPENCHAMBER_DATA_DIR \
      -u MITTRCRAFT_BROKER_URL -u MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR -u MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR \
      HOME="$t" XDG_CONFIG_HOME="$t/.config" XDG_DATA_HOME="$t/.local/share" \
      XDG_STATE_HOME="$t/.local/state" XDG_CACHE_HOME="$t/.cache" "$@"
  }
  ```
- The isolated baseline is `node scripts/mittr/test-baseline.mjs`; its guard refuses the real HOME (R102/R103). Add no failure outside `brand/test-baseline.json`.
- Unit tests never start a real driver: `agent-browser`, `cua-driver`, `open` and Chrome are injected fakes. Only Task 2's probe and the gate run real binaries, under their own rules below.

**Secrets**
- No Mittr access or refresh token, shim key, Jira or Plane credential reaches the engine environment, a log line, a tool result or a file outside the sealed store (R55, R57, R107/R108).
- The tools callback token (`MITTRCRAFT_TOOLS_TOKEN`) is a per-engine-start loopback capability, like upstream's `OPENCHAMBER_AGENT_TOOL_TOKEN` and our shim key. It is in the engine env by design, is minted fresh on every engine start, is never logged, never written to disk, and never returned by a route.
- No route body, tool input or tool result is logged. A log line names the action and the outcome only.
- Page text, snapshots and screenshots go to the model as tool results and to `.openchamber/screenshots/` in the project, as in 1.22 (folder name per the owner's Q6 decision). Nothing else stores them.

**Safety, every runtime check**
- Never open, signal, drive, contact or replace the owner's running `/Applications/MittrCraft.app` or the installed MittrCraft Dev 1.x, and never contact port 57133.
- Never write to `~/.config/mittrcraft*`, `~/.local/{share,state}/mittrcraft`, `~/.cache/mittrcraft`, `~/.config/openchamber`, `~/.local/share/opencode`, `~/.config/opencode`, `~/Library/Application Support/{MittrCraft,MittrCraft Dev,OpenChamber}`.
- **The owner's Chrome and desktop are off limits outside Part B of the gate:**
  - never read, open or copy anything under the real `~/Library/Application Support/Google/Chrome`;
  - never pass the owner's Chrome profile to `agent-browser`; Task 2's probe and Part A use a throwaway profile under the temp HOME, headless, with the keychain-free flags Task 2 proves;
  - only loopback test pages; never a real site;
  - never run the real `cua-driver` beyond `--version` and `codesign` reads, and never `open -a` a real app outside Part B: Part A uses a stub driver and a stub `open` on `PATH`;
  - never show a headed Chrome window outside Part B (`chromeHeaded` stays `false`);
  - never trigger a TCC prompt (Accessibility, Screen Recording) outside Part B; granting one is the owner's act alone.
- Launches are isolated:
  - a fresh `mktemp -d "$TMPDIR/p4.XXXX"` HOME, `env -i`, every `XDG_*` and `TMPDIR` inside it;
  - `OPENCHAMBER_DESKTOP_USER_DATA_DIR=<temp>/userData`, Chromium's `--use-mock-keychain`;
  - the Dev binary launched directly, and quit with `kill -TERM <recorded pid>` after checking the binary path;
  - the R66 keychain symlinks only where a real keychain is needed (Part B).
- Port guard (R46, tightened 19 Oct): record the holder of 57133 before each launch; before every single HTTP call, check that the listener on the target port is the test PID or one of its children, and skip the call otherwise; talk only to `$PORT`.
- Any `node packages/web/bin/cli.js …` or `mittrcraft` run uses `HOME=<temp> OPENCHAMBER_DATA_DIR=<temp>/.config/mittrcraft-dev` (R7).
- Never click "Open MittrCraft Dev" on a browser prompt. Record the `mittrcraft-dev` LaunchServices handler and the "MittrCraft Dev Safe Storage" item's presence (exit status only) before and after (R9).
- The owner types every credential and answers every OS dialog. The controller never types or reads one (R10).

**Third-party egress (R30/R39/R69)**
- Allowed: the Mittr platform (dev `https://api-dev.mittr.asia` for Dev), loopback stubs and loopback test pages.
- In Part B only, with the owner's yes for that step: the sites the owner names for Chrome, and their own Jira through the platform.
- Upstream's own fetches at start (phase 3 findings 3, 20, 22) are known, owner-listed behaviour and are recorded, not fixed here.
- An `lsof` watcher covers the app, server, engine, `agent-browser` and every Chrome child. Any non-loopback peer outside the allowed list is a finding.

**Decisions that bind**
- Owner, this phase: drop nothing; VS Code and mobile are out; `.openchamber/` folders in repos are accepted, so screenshots go to `.openchamber/screenshots/`; the CLI is `mittrcraft` (phase 2); upstream's `gh` token use is left as upstream; desktop egress is an owner list item; send nothing upstream.
- R37/R40, R41, R46, R52, R55, R57, R60, R61, R65–R67, R75/R76, R78, R104–R109 and R110–R140 bind (R44: Mittr-only settings live in `mittr-settings.json`; R128/R132: org connectors stay in the managed config and off hosted web).

## Review Focus

1. **Auto-accept or safety mode answering the Chrome sign-in question (A-30).** In a session set to Auto or Safety, the "use your Chrome sign-in on <host>?" question must still wait for the person, and the client must show it.
   - Task 8 path E: `an auto session leaves the Chrome question for the person and broadcasts it`, `a safety session never asks the classifier about it`, `the reply count for an auto session is zero` and, in upstream's own test file with a neutral name, `a request the plugin marks is held in every mode`.
   - Task 8 path M: `no upstream auto-accept path ever sees the question` (the prompt is ours).
2. **A page that moves to a site the person has not allowed.** A click, a redirect or a `chrome.do` step that lands on another host must return nothing from that host.
   - Task 7 `a click that lands on another host returns nothing from it and names the host`, `chrome.open whose redirect leaves the approved host answers site_moved`.
   - Task 9 `a chrome.do step that leaves the host stops with site_moved and keeps the steps taken`.
3. **An account switch while a tool call is in flight, or a call from the previous engine.** A Jira or Plane read must never use one account's session for another's agent, and no Chrome session or site grant from account A's engine sessions may outlive the switch.
   - Task 4 `a call carrying the previous start's token is refused`.
   - Task 7 `an account switch closes every agent Chrome and forgets every session grant`.
   - Task 10 `a lookup whose session changed account during the call answers 409 and returns nothing`.
4. **Agent-supplied values used as arguments or paths.** A value that looks like a driver flag, an app name with shell characters, a screenshot label or an image path that leaves the screenshots folder must be refused, never passed on.
   - Task 7 `a value starting with - is refused for every chrome action` (including `--headed`, `--profile`, `-s`).
   - Task 6 `an app name outside the plain-name pattern is refused before open runs`.
   - Task 5 `a path outside .openchamber/screenshots is refused`, for `../x.png`, an absolute path and a symlink pointing out.
5. **A server that has no desktop, no driver or no Chrome.** Hosted web, a dev run without the drivers, or a Mac without Chrome must not offer the tool or show its switch.
   - Task 4 `a hosted runtime offers no computer or chrome tool` and `an unbundled driver offers no tool for it`.
   - Task 11 `a tool this install cannot run shows no switch`.

---

### Task 1: Prove what OpenCode 2.0.22 does with our plugin tools (spike)

**Files:**
- Modify `scripts/mittr/probe-engine-v2.mjs` and `scripts/mittr/probe-engine-v2.test.mjs`.
- Create:
  - `scripts/mittr/probe-tool-plugin.mjs`: writes the probe's plugin folder (`package.json` with `exports: { '.': './index.js' }` and an import-free `index.js`) for the variants below, under the probe's temp data dir;
  - `docs/plans/2026-10-21-phase-4a-engine-proof.md`.

**Interfaces:**
- `node scripts/mittr/probe-engine-v2.mjs --only agent-tools --json <out>` runs scenarios P13 to P18 on the bundled engine. It uses phase 3's temp HOME, `XDG_*`, `OPENCODE_CONFIG_DIR` inside it, the loopback stub provider (extended to call the tool a scenario names and to record every request body) and the outbound recorder.
- The managed config lists upstream's agent-tool plugin first (materialized with upstream's `createAgentToolRuntime` in the temp data dir, control and web on) and the probe plugin second, the order `managed-config-file.js` writes.
- Pure helpers, tested:
  - `imagePartsOf(body) -> Array<{ mime: string, bytes: number, sha256: string }>`: every image a provider request carries, from `image_url.url` data URIs and `input_image` parts, in any message role;
  - `permissionAskedOf(events) -> Array<{ id, sessionID, action, resources, save, message, metadata }>`, from `permission.asked` event payloads;
  - `directToolNames(body) -> string[]` and `codeModeCatalogHas(systemText, name) -> boolean`.
- `MARKER_PNG`: a fixed 2×2 PNG whose sha256 the stub matches.

- [ ] **Step 1:** Write the failing helper tests:
  - `an image_url data URI is found with its sha256`;
  - `a tool message with only text has no image`;
  - `a permission.asked payload gives its action and resources`;
  - `a Code Mode catalog line names the tool`.
- [ ] **Step 2:** `iso node --test scripts/mittr/probe-engine-v2.test.mjs`. Expected: FAIL (helpers missing).
- [ ] **Step 3:** Implement the scenarios. Record each with PASS or FAIL and the raw evidence in the JSON:
  - **P13 registration beside upstream's tools.** Probe tools `mittr_probe_direct` (`options.codemode: false`) and `mittr_probe_code` (`codemode: true`) are added through `ctx.tool.transform((tools) => tools.add(…))`. Record:
    - `directToolNames` of the stub's received request: PASS when it holds `mittr_probe_direct`, `openchamber` and `openchamber_web`, and `mittr_probe_code` appears only in the Code Mode catalog;
    - the tool returns `typeof process.env.MITTRCRAFT_TOOLS_URL` from an engine env variable the probe sets, proving engine env reaches the plugin;
    - the own and prototype key names of the setup `ctx`, of the transform's `tools` object, and of the execute `context`.
  - **P13b wrapping upstream's panel tool.** Inside the same transform, find `openchamber_web` through the API P13 recorded and replace its `execute` with one that awaits the original and appends a text part `probe-wrapped`. A turn calling `openchamber_web` `browser.snapshot` (no panel client, so upstream answers an error envelope) shows `probe-wrapped` in the tool result the stub receives. Record which `tools` methods did it.
  - **P14 an image the model sees.** `mittr_probe_image` returns `content: [{ type: 'text', text: '{"ok":true}' }, { type: 'file', uri: 'data:image/png;base64,<MARKER_PNG>', mime: 'image/png', name: 'probe.png' }]`. Run the matrix and record, for each cell, whether `imagePartsOf` of the next request finds the marker sha256:
    - model capabilities `{ tools: true }` (today's provider config) and `{ tools: true, input: ['text', 'image'] }`;
    - called directly (`codemode: false`) and through Code Mode `execute` (`codemode: true`).

    Also record what happens to 1.22's shape (`attachments: [{ type: 'file', mime, url, filename }]`): ignored, refused, or seen.
  - **P15 raising the permission prompt.** Host `probe.example.test`. Try, in this order, and record for each whether a `permission.asked` event appears and with which properties:
    - (a) `context.ask({ permission: 'mittrcraft_chrome', patterns: [host], always: [host], metadata: { host } })` (1.22's call);
    - (b) `context.ask({ action: 'mittrcraft_chrome', resources: [host], save: [host], message: 'Allow the agent to use your Chrome sign-in on ' + host + '?', metadata: { host } })` (the v2 request shape);
    - (c) any permission API on the setup `ctx` that P13 recorded;
    - (d) `options.permission: 'mittrcraft_chrome'` on the tool.

    For the first one that raises the event:
    - reply `POST /api/session/:id/permission/:pid/reply` with `{ decision }` = `once`, `always`, `reject` in three runs, and record what the tool's call does (resolves, with what; throws, with what message);
    - check the request is listed by `GET /api/permission/request` with `x-opencode-directory`;
    - **P15d:** after `always`, ask again for the same host in a new session: record whether a new `permission.asked` appears. If not, look for a route that lists and deletes saved permissions (record it, delete the saved rule, ask again, and record whether the event now appears);
    - **P15e:** abort the turn while the ask is pending (`POST /api/session/:id/abort`) and record what the tool sees;
    - record whether the upstream UI's permission card text would carry `message` (the event's `message` field is present).
  - **P16 auto-accept and safety on a plugin permission.** For the ask path from P15:
    - the event's `properties.id` and `properties.sessionID` are present (what upstream's `processPermission` reads);
    - the body upstream's `replyOnce` sends, `{ decision: 'once' }`, unblocks the tool (so `auto` mode would answer our prompt with no hook);
    - the request is in the pending list `reconcilePending` reads;
    - record the exact object `evaluatePermission` would be handed in `safety` mode.
  - **P17 hot toggle.** While the engine runs, rewrite the probe plugin's `index.js` without `mittr_probe_direct` and rewrite the managed file. PASS when, within 5 s, the next turn's tool list lacks it and the engine PID is unchanged.
  - **P18 abort reaches the plugin.** `mittr_probe_wait` awaits a fetch to a loopback listener that never answers. Abort the turn. Record whether `context.signal` (or whatever P13 listed) fires, and whether the listener sees the request closed.
- [ ] **Step 4:** Run the probe and write the proof note: results, the recorded API names, the permission event shape, the image matrix, timings, every outbound connection seen. **Stop conditions, binding on later tasks:**
  - **P13 fails** (no direct plugin tool beside upstream's): **stop and report**. Tasks 4–11 cannot proceed.
  - **P13b fails:** Task 5 takes the hook route (`agent-tool/runtime.js`, +1).
  - **P14 finds no image in any direct cell:** **stop the image half** of A-13/A-18/A-26 and report to the owner before Task 5. Tasks 6 and 7 then return the saved path and hint only; nothing else stops.
  - **P14 finds the image only with `input: ['text','image']`:** Task 5 adds it to every Mittr model (owner item 5).
  - **P14 loses the image through Code Mode:** owner note only; our tools follow upstream's `agentToolsCodeMode`.
  - **P15 chooses Task 8's path.** Path E (the engine's own prompt) needs all of:
    - an ask that raises `permission.asked` with the host in `resources` or `metadata`;
    - the tool learning once, always or reject;
    - P15d either shows the engine does not answer a later ask by itself, or found a route that deletes the saved rule.

    Otherwise Task 8 takes path M (MittrCraft's own prompt). Record the ruling with the evidence.
  - **P16 shows `auto` does not answer our ask:** the A-30 hook is not needed even on path E; Task 8 skips its hook and the budget stays 34.
  - **P17 fails:** Task 4 calls `context.opencode.refresh('mittr tools changed')` after a switch change, and the note records the restart cost.
  - **P18 fails:** Task 4 aborts in-flight actions from the `session.idle` `aborted: true` event only, as upstream does.
  - Any non-loopback connection: record the host for the owner.
- [ ] **Step 5:** Commit `docs(mittr): record how OpenCode 2.0.22 runs our plugin tools, their images and their permission prompt`, with the script changes, the probe plugin writer and the proof note.

Upstream files added: 0. Running total: 34.

### Task 2: Bundled drivers, pinned and packed, and a safety probe of agent-browser (A-27)

**Files:**
- Create:
  - `scripts/mittr/drivers.json`;
  - `scripts/mittr/drivers.mjs` with `scripts/mittr/drivers.test.mjs`;
  - `scripts/mittr/probe-agent-browser.mjs` with `scripts/mittr/probe-agent-browser.test.mjs`;
  - `brand/THIRD_PARTY_NOTICES.md`: the agent-browser (Apache-2.0) and cua-driver (MIT) sections of 1.22's `packages/electron/THIRD_PARTY_NOTICES.md` (read with `git -C ~/Documents/mittr-craft show origin/develop:packages/electron/THIRD_PARTY_NOTICES.md`), copied unchanged.
- Modify:
  - `scripts/mittr/build-desktop.mjs` and `build-desktop.test.mjs`: step 3 stages the drivers and the notices; step 8 verifies them;
  - `brand/electron-builder.dev.json` and `brand/electron-builder.prod.json`: `extraResources` gains `.product/agent-browser` → `agent-browser`, `.product/cua-driver` → `cua-driver`, `../../brand/THIRD_PARTY_NOTICES.md` → `THIRD_PARTY_NOTICES.md`;
  - `brand/leak-allowlist.json`, only if the scan flags driver files, with a reason per entry.
- Append a "Drivers" section to `docs/plans/2026-10-21-phase-4a-engine-proof.md`.

**Interfaces:**
- `scripts/mittr/drivers.json`, exactly (the values were read from the local copies on 21 Oct):

  ```json
  {
    "agentBrowser": {
      "version": "0.38.1",
      "asset": "agent-browser-darwin-arm64",
      "url": "https://github.com/vercel-labs/agent-browser/releases/download/v0.38.1/agent-browser-darwin-arm64",
      "sha256": "2e61287259053ea964d39e77002c6a34af0e589e55ccff25e659efae7e892e0d",
      "bytes": 15768448,
      "licence": "Apache-2.0"
    },
    "cuaDriver": {
      "version": "0.28.2",
      "asset": "cua-driver-rs-0.28.2-darwin-universal.tar.gz",
      "url": "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2/cua-driver-rs-0.28.2-darwin-universal.tar.gz",
      "archiveSha256": "e273181b26709c88b1d809474deb3c592b4efae3530b11d76318f1887fc3fbb1",
      "archiveBytes": 70078129,
      "binarySha256": "9a7731f7e961a57963f0deb132878367fdf7354e7327a4d558fe4a68e4686b81",
      "bundleIdentifier": "com.trycua.driver",
      "teamIdentifier": "YCK386LBJ7",
      "licence": "MIT"
    }
  }
  ```
- Sources, in order: env `MITTRCRAFT_AGENT_BROWSER_BINARY` / `MITTRCRAFT_CUA_DRIVER_ARCHIVE` (a file path), else the worktree's `packages/electron/.cache/agent-browser/0.38.1/<asset>` and `packages/electron/.cache/cua-driver/0.28.2/<asset>`.
  - **Before the first build:** copy the two files from `~/Documents/mittr-craft/packages/electron/.cache/` (the main checkout, read only) into the worktree's `packages/electron/.cache/` with `cp -p`, and check both sha256 values against the pin.
  - **There is no download path.** `drivers.mjs` never fetches. A missing or mismatched file fails the build with exactly: `<asset> is missing or does not match scripts/mittr/drivers.json (expected sha256 <sha>). Downloading it from <url> needs the owner's yes.`
  - The pin is arm64 only. An x64 build has no agent-browser source (owner item 6).
- `readDriverPins(file?) -> pins`.
- `stageDrivers({ pins, agentBrowserBinary, cuaArchive, outDir }) -> { agentBrowser: string, cuaDriver: string, cuaApp: string }`:
  - copies agent-browser to `<outDir>/agent-browser/agent-browser` with mode 755;
  - extracts the archive with the system `tar -xzf` into a scratch dir (the bundle has symlinks, which the ripgrep reader refuses), copies `CuaDriver.app` to `<outDir>/cua-driver/CuaDriver.app`, and links `<outDir>/cua-driver/cua-driver` → `./CuaDriver.app/Contents/MacOS/cua-driver`, as 1.22 did;
  - verifies the cua binary's sha256 and `codesign --verify --deep --strict` on the staged app.
- `verifyPackedDrivers({ appPath, pins }) -> { agentBrowserVersion, cuaDriverVersion, cuaTeamIdentifier }`: both files exist under `Contents/Resources`; `--version` of each prints the pinned version; `codesign -dv` on the packed `CuaDriver.app` reports `Identifier=com.trycua.driver` and `TeamIdentifier=YCK386LBJ7`; `THIRD_PARTY_NOTICES.md` is packed. A re-signed `CuaDriver.app` fails the build: it would lose its TCC identity.
- Probe `node scripts/mittr/probe-agent-browser.mjs --json <out>`, under `iso` and its own `env -i`, with the egress and `SecurityAgent` watchers of the Global Constraints. It runs the **staged** agent-browser with `AGENT_BROWSER_EXECUTABLE_PATH` at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, headless, on a throwaway profile seeded under the temp HOME, against a loopback test page. Verdicts:
  - **AB1 profile isolation:** `agent-browser --json profiles` lists only the seeded profile, and no path under the real `~/Library/Application Support/Google/Chrome` appears in `lsof` of agent-browser or any Chrome child, sampled every 250 ms. The real folder is never opened by the probe itself: the check is the `lsof` path filter and a before/after `stat -f %m` of the folder only.
  - **AB2 keychain:** record how agent-browser 0.38.1 passes extra Chrome arguments (`--help` output, env such as `AGENT_BROWSER_ARGS`), pass `--use-mock-keychain --password-store=basic`, and PASS when no `SecurityAgent` appears and the login keychain's item list is untouched (exit status of `security find-generic-password -s "Chrome Safe Storage"` before and after, value never read).
  - **AB3 quiet network:** with `--disable-background-networking --disable-component-update --disable-sync --no-first-run --metrics-recording-only` passed the same way, every peer is loopback.
  - **AB4 Chrome 155 driven:** `open`, `snapshot -i`, `click @eN`, `fill`, `get url`, `screenshot <file>` and `read` work on the loopback form page.
  - **AB5 clean-up:** after `close --all`, `pgrep -f agent-browser` and Chrome processes using the throwaway user-data dir find nothing.
- Pure helpers, tested: `pathsUnder(lsofText, root) -> string[]`, `peersOf(lsofText) -> string[]`.

- [ ] **Step 1:** Write the failing tests:
  - `drivers.test.mjs`:
    - `a binary whose sha256 differs from the pin is refused with the exact message`;
    - `a missing archive names the asset, the url and the owner's yes`;
    - `staging writes agent-browser with mode 755 and the cua-driver link`, with a fixture archive built in the test (a fake `CuaDriver.app` whose binary hash the fixture pin holds; `codesign` injected);
    - `a packed CuaDriver.app with another team identifier fails the check`;
    - `the module never calls fetch` (source scan for `fetch(`).
  - `probe-agent-browser.test.mjs`: `pathsUnder` keeps only lines under the root; `peersOf` drops loopback.
  - `build-desktop.test.mjs`: `the dev and prod builder files pack both drivers and the notices`.
- [ ] **Step 2:** `iso node --test scripts/mittr/drivers.test.mjs scripts/mittr/probe-agent-browser.test.mjs scripts/mittr/build-desktop.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Implement. Copy the two cache files as above. Run `node scripts/mittr/build-desktop.mjs --flavor dev` and then the probe. Write the "Drivers" section of the proof note with every AB verdict and the packed signatures. **Stop conditions, binding on later tasks and the gate:**
  - **AB1 fails:** **stop every real-Chrome check** (Task 7's live checks and the gate's Part A Chrome rows are NOT RUN) and report. The owner's profile is never risked.
  - **AB2 cannot keep Chrome off the keychain:** owner decision before any Part A Chrome row runs.
  - **AB3 sees non-loopback peers despite the flags:** record the hosts; owner decision before Part A Chrome rows.
  - **AB4 fails:** **stop Tasks 7–9** and report (agent-browser 0.38.1 does not drive Chrome 155).
  - **The packed `CuaDriver.app` is re-signed:** add `mac.signIgnore` for `cua-driver/` to both builder files, rebuild, and re-check.
- [ ] **Step 4:** Re-run the tests, `iso node --test scripts/mittr/*.test.mjs`, the build (exit 0, leak scan 0 unexplained) and `node scripts/mittr/check-upstream-touch.mjs --no-write` (34 of 40). Expected: PASS.
- [ ] **Step 5:** Commit as two commits: `feat(mittr): pack agent-browser and cua-driver from pinned local copies, with their notices` and `docs(mittr): record that agent-browser drives a throwaway headless Chrome with no keychain or network`.

Upstream files added: 0. Running total: 34.

### Task 3: One action registry beside upstream's control contract (A-31, the voice seam)

**Files:**
- Create in `packages/mittr-server/src/mittr/tools/`, each with a `*.test.js`:
  - `registry.js`;
  - `control-routes.js`.
- Modify (hook): `packages/web/server/index.js` (already counted): the plugin context gains `control`; `brand/upstream-hooks.json`.
- Modify `packages/mittr-server/src/mittr/index.js` and `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- **Context hook.** `context.control = { execute(action, input, contextDirectory, options), resolveSessionDirectory(sessionID), definitions() }`:
  - `execute` and `resolveSessionDirectory` are upstream's `openChamberControlService` functions, unchanged;
  - `definitions()` returns `{ control: OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS, web: OPENCHAMBER_WEB_ACTION_DEFINITIONS }` from `lib/openchamber-control/actions.js`;
  - with no plugin loaded nothing calls it.
- `class MittrToolError extends Error { constructor(message, statusCode = 500, extra = {}) }`: `extra` carries `code` and fields such as `host`.
- `createMittrActionRegistry({ control }) -> registry`:
  - `defineTool({ name, description, parameters }): void`;
  - `register({ action, tool, title, description, effect: 'read' | 'change', voiceOnly = false, available = () => true, execute: (input, ctx) => Promise<unknown> }): void`. A second registration of an action throws;
  - `tools() -> Array<{ name, description, parameters, definitions: Array<{ action, title, description }> }>`: only tools with at least one available, non-voice-only action;
  - `definitions({ tool, includeVoiceOnly = false } = {}) -> Array<{ action, tool, title, description, effect, voiceOnly }>`;
  - `has(action) -> boolean`;
  - `resolve(requested, toolName) -> { action } | { error }`: a bare name such as `open` resolves inside the calling tool's actions only; an unknown one answers `Unknown action "<x>" for <tool>; it has: <list>`;
  - `execute(action, input, ctx) -> Promise<unknown>`, `ctx = { directory?, sessionId?, signal?, approvalAnswered?, headed?, surface: 'agent' | 'voice' | 'http' }`:
    - a Mittr action whose `available()` is false throws `MittrToolError('<title> is not available in this install', 503)`;
    - a `voiceOnly` action from a surface other than `voice` throws 400;
    - any other action goes to `control.execute(action, input, ctx.directory, { signal: ctx.signal, contextSessionId: ctx.sessionId })`.
- `registerMittrControlRoutes(app, { express, registry })`: `POST /api/mittr/control`, body `{ action, input, contextDirectory?, contextSessionId? }` through `jsonBody(express, { limit: '1mb' })`, under the server's UI auth like upstream's control route.
  - It answers the data, or the error's status with `{ error, code?, host?, partial? … }` as upstream's route does (`asControlError` behaviour copied, not imported).
  - The request's close aborts the action.
- Contract item `plugin-context-control`: `index.js` passes `openChamberControlService.execute`, `.resolveSessionDirectory` and both definition lists; `actions.js` still exports them.

- [ ] **Step 1:** Write the failing tests:
  - `a Mittr action runs its own execute with the context`;
  - `an upstream action goes to the control service with the directory and calling session`: `session.list` reaches the fake `control.execute` with `('session.list', {}, '/p', { contextSessionId: 's1', signal })`;
  - `open from the chrome tool resolves to chrome.open and from the computer tool it lists that tool's actions`;
  - `an unavailable action answers 503 and runs nothing`;
  - `a voice-only action is refused for agents and http`;
  - `a tool with only unavailable actions is not listed`;
  - `the http route answers the error status and code`: a `MittrToolError('x', 403, { code: 'site_approval_required', host: 'a.test' })` answers 403 `{ error: 'x', code: 'site_approval_required', host: 'a.test' }`;
  - contract item `plugin-context-control`.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement the hook first. Append `{ hook: 'server-plugins', why }` to the `packages/web/server/index.js` entry. The why: a downstream build adds its own actions next to the control contract and reaches the same service the CLI and agent tool use, instead of copying it. Then the registry and route; `setupMittr` creates the registry and registers the route.
- [ ] **Step 4:** Re-run, then `iso bun run --cwd packages/web test -- server/lib/server-plugins.test.js` and `node scripts/mittr/neutral-hook-tests.mjs` (0 findings). Touch check: 34 of 40.
- [ ] **Step 5:** Commit as two commits: `hook(server-plugins): hand plugins the control service and its action definitions` and `feat(mittr-server): one action registry for Mittr actions beside the control contract`.

Upstream files added: 0 (`index.js` already counted). Running total: 34.

### Task 4: The Mittr tools plugin, its callback and the tool switches (A-01 server half)

**Files:**
- Create in `packages/mittr-server/src/mittr/tools/`, each with a `*.test.js`:
  - `plugin-source.js`;
  - `callback.js`;
  - `index.js` (`setupMittrTools`).
- Modify:
  - `packages/mittr-server/src/mittr/mittr-settings.js` and its test: the `tools` block and the carry;
  - `packages/mittr-server/src/mittr/index.js`, `packages/mittr-server/src/plugin.js` and their tests;
  - `packages/mittr-opencode/src/tools-plugin.js` (re-export, as the identity plugin does) and `packages/mittr-opencode/package.json` exports;
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- **Settings (R44).** `mittr-settings.json` gains `tools: { computer: boolean, chrome: boolean, chromeProfile: string | null, chromeHeaded: boolean, chromeApprovedHosts: string[] }`, default `{ computer: true, chrome: true, chromeProfile: null, chromeHeaded: false, chromeApprovedHosts: [] }` (1.22's defaults).
  - `read()` returns `{ showOtherProviders, tools }`; an invalid field reads as its default; hosts are lowercased, deduplicated and must match `/^[a-z0-9.-]+$/`.
  - `update({ tools: Partial<…> })` merges and returns what it stored, through `writePrivateAtomic`.
  - `carryParkedToolSettings({ dataDir })`: once, when `mittr-settings.json` has no `tools` key, reads `settings.json`'s parked `mittr.agentComputerToolEnabled`, `agentChromeToolEnabled`, `agentChromeProfile`, `agentChromeHeaded`, `agentChromeApprovedHosts` (phase 1 parked them) and writes them as `tools`. It never writes `settings.json`.
- **Plugin source.** `toolsPluginSource({ tools, codeMode, wrapCapture }) -> string`, where `tools` is `registry.tools()`:
  - `export default { id: 'mittrcraft-tools', setup: async (ctx) => { … await ctx.tool.transform((tools) => { … }) } }`, with no import;
  - each tool is `tools.add({ name, description, options: { codemode: codeMode }, input, execute })`, `input` built like upstream's (an `action` with `oneOf` per definition and no `enum`; a `parameters` object; flattened inputs accepted, an explicit `parameters` winning);
  - `execute` posts `{ tool, input, sessionID: context.sessionID }` to `process.env.MITTRCRAFT_TOOLS_URL` with `authorization: Bearer <MITTRCRAFT_TOOLS_TOKEN>`, forwards the abort signal Task 1 P18 found, and returns `{ content, metadata: { mittrcraft: { schemaVersion: 1, action, description, ok } } }`, never `output`;
  - it adds the callback host to `NO_PROXY`/`no_proxy`, as upstream's template does;
  - `wrapCapture` is filled by Task 5; Task 8 adds the approval step.
- `materializeToolsPlugin({ dataDir, source }) -> string`: writes `<dataDir>/engine-plugins/mittrcraft-tools/{package.json,index.js}` (mode 600, temp + rename), returns the folder. `toolsFragment(dir) -> { plugins: [dir] }`.
- **Callback.** `createToolsCallback({ crypto, registry, resolveSessionDirectory, logger }) -> { engineEnv(port: number) -> { MITTRCRAFT_TOOLS_URL, MITTRCRAFT_TOOLS_TOKEN }, register(app, express), abortSession(sessionId): number }`:
  - `engineEnv` mints a new 32-byte base64url token on every call (every engine start) and drops the old one; the URL is `http://127.0.0.1:<port>/mittr-tools/v1/call`;
  - the route sits outside `/api`, like the shim: it refuses with 401 a non-loopback peer, a request carrying any relay header (`cameThroughProxy`), or a bearer that is not the current token (timing-safe compare);
  - body `{ tool, input, sessionID }`, `jsonBody(express, { limit: '1mb' })`; it resolves the action with `registry.resolve(input.action, tool)`, the directory with `resolveSessionDirectory(sessionID)`, and runs `registry.execute(action, input.parameters merged with input, { directory, sessionId, signal, surface: 'agent' })`;
  - it answers `{ schemaVersion: 1, ok: true, action, data }` or `{ schemaVersion: 1, ok: false, action, error: { message, kind: 'usage' | 'runtime', code?, host? } }`, `usage` for 4xx;
  - it logs one line per failure, `[mittr] tool <action> failed: <status>`, never the body or the token.
- **Setup.** `setupMittrTools(context, { registry, mittrSettings, resourcesDir, signedIn, logger }) -> { engineEnv(), managedConfig(), applySwitches(patch), switches(), dispose() }`:
  - **Inclusion:** `mittrcraft_computer` when `context.host` is set, the cua driver resolves and `tools.computer !== false`; `mittrcraft_chrome` when `context.host` is set, agent-browser resolves, Chrome is installed and `tools.chrome !== false`; `mittrcraft_work` when an account is signed in and upstream's `agentControlToolEnabled !== false`. The actions themselves come from Tasks 6, 7, 9 and 10.
  - `codeMode` is upstream's `agentToolsCodeMode === true`, read from `context.settings.read()`.
  - `managedConfig()` writes the plugin and returns `toolsFragment(dir)`, or `{}` when no tool and no wrap is included.
  - `applySwitches(patch)` stores, then `context.managedConfig.refresh()` (and `context.opencode.refresh('mittr tools changed')` if Task 1 P17 failed).
  - It subscribes to `context.events` and calls `abortSession` on `session.idle` with `aborted: true`.
- Contract items:
  - `agent-tool-settings-keys`: upstream's settings registry still has `agentControlToolEnabled`, `agentWebToolEnabled` and `agentToolsCodeMode`;
  - `managed-config-plugin-order`: `managed-config-file.js` writes upstream's plugin folders before contributed `plugins`;
  - `session-idle-aborted-event`: the event translation still carries `session.idle` with `properties.aborted` and `properties.sessionID`.

- [ ] **Step 1:** Write the failing tests:
  - `the generated plugin has no import and adds each tool with codemode false`: the source parses as a module, contains no `import`, and `codemode: false` once per tool;
  - `a tool lists only its own actions and parameters`;
  - `turning Chrome off removes its tool from the plugin and refreshes the managed config` (A-01): after `applySwitches({ chrome: false })` the written source has no `mittrcraft_chrome` and `managedConfig.refresh` was called once;
  - `a hosted runtime offers no computer or chrome tool`: with `context.host` null and both drivers present, the source has neither;
  - `an unbundled driver offers no tool for it`;
  - `the work tool needs a signed-in account and the control switch`;
  - `Code Mode follows upstream's setting`;
  - `a call carrying the previous start's token is refused`: two `engineEnv()` calls, then a call with the first token answers 401;
  - `a call from another machine or through a proxy header is refused`: remote address `10.0.0.5`, and loopback with `x-forwarded-for`;
  - `the token and the request body never reach the log`;
  - `an aborted turn aborts its in-flight action`;
  - `1.22 tool settings parked under mittr are carried once`, and `a later change is not overwritten by the carry`;
  - `a bad host in the stored list is dropped on read`;
  - the three contract items.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test` and `iso bun run --cwd packages/mittr-opencode test`. Expected: FAIL.
- [ ] **Step 3:** Implement and wire. `setupMittr` merges `setupMittrTools`'s `managedConfig()` into its fragment list and its `engineEnv()` into the plugin's engine env.
- [ ] **Step 4:** Re-run both. Expected: PASS. Touch check: 34 of 40.
- [ ] **Step 5:** Commit `feat(mittr-server): the Mittr tools plugin, its loopback callback and the Computer and Chrome switches`.

Upstream files added: 0. Running total: 34.

### Task 5: Screenshots the model sees (A-13; the image path for A-18 and A-26)

**Files:**
- Create `packages/mittr-server/src/mittr/tools/screenshots.js` with `screenshots.test.js`.
- Modify `tools/plugin-source.js`, `tools/callback.js`, `tools/index.js` and their tests; `packages/mittr-server/src/mittr/provider-config.js` and its test (only under the P14 rule below); `packages/mittr-server/src/upstream-contract.{js,test.js}`.
- **Fallback, only if Task 1 P13b failed** (hook): `packages/web/server/lib/agent-tool/runtime.js` (**new counted file, +1**) with `runtime.test.js`; `packages/web/server/index.js` (counted); `brand/upstream-hooks.json`.

**Interfaces:**
- `SCREENSHOT_DIRECTORY = '.openchamber/screenshots'`, the same folder as upstream's (contract item `screenshot-directory`).
- `writeScreenshot({ directory, base64, mime = 'image/png', label, now }) -> { path, absolutePath }`: a port of 1.22's, with the same slug and stamp rules.
- `MAX_IMAGE_BYTES = 5 * 1024 * 1024`.
- `readCapture({ directory, relativePath }) -> { base64, mime } | { tooLarge: true }`:
  - `relativePath` normalized must start with `.openchamber/screenshots/`, contain no `..`, and its `realpath` must be inside `realpath(directory)/.openchamber/screenshots`;
  - extension `.png|.jpg|.jpeg|.webp` gives the mime; anything else is refused;
  - a refusal throws `MittrToolError('That image is not a saved screenshot of this project', 400)`.
- `imageContent({ base64, mime, name }) -> Content`: exactly the content part Task 1 P14 proved (expected `{ type: 'file', uri: 'data:<mime>;base64,<b64>', mime, name }`).
- A Mittr action that returns `data.image = { base64, mime }` gets, from the plugin, `content: [{ type: 'text', text: <envelope without data.image> }, imageContent(...)]`. Over `MAX_IMAGE_BYTES` the text says `The image is too large to attach; it is saved at <path>` and no image part is sent.
- **Wrap route (P13b passed):** `toolsPluginSource({ …, wrapCapture: true })` wraps `openchamber_web`'s `execute`. After the original returns an ok envelope for `browser.capture` with `data.path`, it posts `{ tool: 'openchamber_web', internal: 'capture-image', path, sessionID }` to the callback, which answers `readCapture` for that session's directory. The original content stays first. `wrapCapture` is on while upstream's `agentWebToolEnabled !== false`.
- **Hook route (P13b failed):** `createAgentToolRuntime` gains option `attachCaptureImage: () => boolean`, default `() => false`. When it answers true, `execute` adds `data.image` for an ok `browser.capture` by reading the saved file under the same rules and size cap, and the template returns the two-part content. `index.js` passes `() => serverPlugins?.attachCaptureImage?.() === true`; `loadServerPlugins` aggregates a plugin's `attachCaptureImage()`. The hook test uses neutral fixtures.
- **Provider (only if P14 needed it):** `mittrProviderFragment` gives every Mittr model `capabilities: { tools: true, input: ['text', 'image'] }`.
- Contract item `web-capture-result`: `service.js` answers `browser.capture` with a project-relative `path` under `SCREENSHOT_DIRECTORY`, and the agent-tool template returns its envelope as text `content`.

- [ ] **Step 1:** Write the failing tests:
  - `a capture inside the screenshots folder is attached as an image part` (fixture PNG, temp project);
  - `a path outside .openchamber/screenshots is refused`, for `../x.png`, `/etc/x.png`, `.openchamber/screenshots/../../x.png` and a symlink in the folder pointing outside;
  - `a file over 5 MiB is not attached and the reply says where it is`;
  - `a failed upstream capture passes through unchanged`;
  - `our screenshots land under .openchamber/screenshots with the label slug`;
  - `the image part has the shape the engine accepts` (the P14 shape, value-equal);
  - P14 rule only: `every Mittr model takes images`;
  - hook route only: in `runtime.test.js`, `a capture is attached only when the option says so` and `without the option the result is unchanged`;
  - the contract items.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test` (and, hook route, `iso bun run --cwd packages/web test -- server/lib/agent-tool/runtime.test.js`). Expected: FAIL.
- [ ] **Step 3:** Implement the route Task 1 chose. Hook route: append `{ hook: 'agent-tool-capture-image', why }` to the `agent-tool/runtime.js`, `index.js` and `server-plugins.js` entries. The why: a downstream build lets the model see the page it captured, instead of only its path, without changing what the user sees or where the file is saved.
- [ ] **Step 4:** Re-run. Expected: PASS. Touch check: **34 of 40** (wrap route) or **35 of 40** (hook route); neutral scan 0.
- [ ] **Step 5:** Commit `feat(mittr-server): the model sees the screenshots its tools save` (hook route: first `hook(agent-tool-capture-image): attach a saved browser capture as an image the model sees`).

Upstream files added: 0 (wrap) or 1 (hook). Running total: 34 + T5, where T5 is 0 or 1.

### Task 6: The desktop tool (A-23 to A-26)

**Files:**
- Create in `packages/mittr-server/src/mittr/tools/`, each with a `*.test.js`:
  - `computer-control.js`;
  - `computer-actions.js`.
- Modify `tools/index.js` and its test.

**Interfaces:**
- `resolveCuaDriver({ resourcesDir, env }) -> string | null`: the first existing of `$MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR/cua-driver` and `<resourcesDir>/cua-driver/cua-driver`.
- `createComputerControl({ binary, spawn = child_process.spawn, timeoutMs = 15_000 }) -> { available: boolean, request(tool: string, args?: object): Promise<object> }`: a port of 1.22's; `spawn(binary, [tool, JSON.stringify(args)])` without a shell; non-zero exit rejects with stderr; non-JSON rejects with the first 200 characters.
- `registerComputerActions(registry, { control, launchApp, writeScreenshot })` registers on tool `mittrcraft_computer`, with 1.22's titles and descriptions and `COMPUTER_TOOL_DESCRIPTION` verbatim:
  - `computer.list_apps` (read): `{ apps: [{ name, pid, running, bundleId }] }`;
  - `computer.open_app` (change): `app` must match `APP_NAME_PATTERN = /^[\w .()&-]{1,80}$/`; `launchApp(name)` spawns `open` with `['-a', name]`, no shell; answers `{ launched: true, app }`, or 502 `Could not open "<app>": <stderr>`;
  - `computer.bring_to_front` (change): finds the running app case-insensitively (404 `No running app named "<app>"`), calls `bring_to_front { pid }`, and answers `{ activated, windowVerified }`, or for `ambiguous_window_target` `{ activated: false, reason, candidates, hint }`, as 1.22;
  - `computer.screenshot` (read): `get_desktop_state`, saved as `desktop-*.png` through `writeScreenshot`, answered with `{ path, hint, width, height, image: { base64, mime } }` (Task 5 turns `image` into content).
- **A missing grant** reads plainly. A driver error whose text names Screen Recording or Accessibility (the exact driver texts recorded in the gate's Part A against the stub, and in Part B for real) answers 403 `MittrCraft needs the <grant> permission for CuaDriver. Turn it on in System Settings → Privacy & Security → <grant>.`
- `available()` of every computer action is `control.available && context.host !== null`.

- [ ] **Step 1:** Write the failing tests (fake spawn, fake launchApp):
  - `list_apps maps the driver's fields`;
  - `an app name outside the plain-name pattern is refused before open runs`, for `Calc; rm -rf ~`, `../x`, `-a` and an 81-character name;
  - `open_app runs open -a without a shell`;
  - `bring_to_front with several windows reports the candidates and activates nothing`;
  - `a screenshot is saved as desktop-*.png and carries the image`;
  - `a missing Screen Recording grant names it and where to turn it on`;
  - `a driver that is not bundled makes every computer action unavailable`.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement, porting 1.22 `computer-control.js` and the `computerAction` part of `service.js`. Register from `setupMittrTools`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): agents list, open and bring desktop apps forward and see the desktop`.

Upstream files added: 0. Running total: 34 + T5.

### Task 7: The Chrome tool: sessions, actions, site fence and clean-up (A-15 to A-19, A-33)

**Files:**
- Create in `packages/mittr-server/src/mittr/tools/`, each with a `*.test.js`:
  - `chrome-control.js`;
  - `chrome-service.js`.
- Modify `tools/index.js`, `packages/mittr-server/src/mittr/index.js` (switch and dispose hooks) and their tests; `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- `CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`.
- `resolveAgentBrowser({ resourcesDir, env }) -> string | null`: the first existing of `$MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR/agent-browser` and `<resourcesDir>/agent-browser/agent-browser`.
- `createChromeControl({ binary, chromePath = CHROME_EXECUTABLE, exists, execute, bannerPath, env = process.env }) -> { available, chromeInstalled(), run(command, { sessionName, profile, headed, signal }), profiles(), closeAll() }`: a port of 1.22's, with `AGENT_BROWSER_EXECUTABLE_PATH` and `AGENT_BROWSER_NAMESPACE: 'mittrcraft'`, `--session`, `--profile`, `--json`, `--max-output 12000`, and `--headed --init-script <bannerPath>` when headed.
  - `bannerPath` is `<dataDir>/mittr-chrome-banner.js` (mode 600), not 1.22's shared temp folder; the script and banner text are 1.22's, verbatim.
  - The process env passes through, so the gate's quiet-Chrome arguments from Task 2 reach Chrome with no product change.
- `chromeSessionName(sessionId) = 'mc-' + sessionId stripped to [A-Za-z0-9_-]`.
- `createChromeService({ control, settings, approvals, stepper, writeScreenshot }) -> { execute(action, input, ctx), profiles(), removeHost(host), closeSession(sessionId), closeAll(), allowForConversation(sessionId), endConversation(sessionId), isHostAllowed(sessionId, host) }`, a port of 1.22's `chromeAction`:
  - **No calling session:** 400 `The Chrome tool needs the calling session`.
  - **Profile:** with none chosen and exactly one listed, that one is used and stored (`tools.chromeProfile`). Otherwise 409 `{ code: 'chrome_profile_required' }`, `No Chrome profile is chosen yet; ask the user to choose one in Settings → Integrations → MittrCraft tools → Chrome profile`.
  - **Visible window:** headed when `ctx.headed === true` or `tools.chromeHeaded`; a change of mode closes and reopens that session's Chrome.
  - **Commands:** 1.22's `CHROME_COMMANDS`, `refOf` (`/^@?(e\d+)$/`), `keyOf` (`/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/`), `plainArg` (a value starting with `-` is refused with `<name> cannot start with "-"`), and `hostOf` (http and https only).
  - **Site fence:** before every action, `ensureApproved(host)` of the current page (Task 8 supplies `approvals`). After every action, `ensureStillApproved()` reads `get url`; another host answers 409 `{ code: 'site_moved', host }`, `The page moved to <host>, which the user has not allowed; nothing from it is returned. Call chrome.open with that page's URL to ask the user`, and the action's own result is dropped.
  - **Screenshot:** to a temp file in a `mkdtemp` folder (removed in `finally`), saved through `writeScreenshot` with label `chrome` by default, answered with `{ path, hint, url, image: { base64, mime: 'image/png' } }`.
  - **No page open:** 400 `No page is open in this session; call chrome.open first`.
  - **Conversation grants** (for 4B): `allowForConversation(sessionId)` lets every host for that session until `endConversation(sessionId)`; `isHostAllowed(sessionId, host)` answers both kinds.
- **Clean-up (A-19):**
  - `closeSession(sessionId)` on the `session.deleted` event (`context.events`);
  - `closeAll()` and forgetting every grant on an account switch (`setupMittr`'s `onAccountChange`);
  - `closeAll()` in `dispose()`, bounded at 3 s.
- **A-33:** `CHROME_TOOL_DESCRIPTION` is 1.22's, verbatim, including "If a page asks you to sign in, stop and tell the user which site — never type a password or fill a sign-in form."
- Registered on tool `mittrcraft_chrome`: `chrome.open`, `snapshot`, `read`, `click`, `fill`, `type`, `press`, `select`, `wait`, `screenshot`, `close` (Task 9 adds `chrome.do`), with 1.22's definitions; read actions are `open`, `snapshot`, `read`, `wait` and `screenshot`.
- Contract item `session-deleted-event`: the event translation still carries `session.deleted` with `properties.info.id`.

- [ ] **Step 1:** Write the failing tests (fake `execute` recording argv):
  - `chrome.open runs agent-browser with the session, profile and json flags`;
  - `a value starting with - is refused for every chrome action`, for `--headed`, `--profile`, `-s` in `value`, `selector` and `text`, with no argv run;
  - `a ref that is not from a snapshot is refused`;
  - `only http and https pages open`;
  - `a click that lands on another host returns nothing from it and names the host`;
  - `chrome.open whose redirect leaves the approved host answers site_moved`;
  - `the only profile is chosen and stored, two profiles ask the user`;
  - `a headed request closes the headless session first and adds the banner`;
  - `a screenshot is saved and its scratch folder is removed even when the driver fails`;
  - `a deleted session closes its Chrome`;
  - `an account switch closes every agent Chrome and forgets every session grant`;
  - `dispose closes every Chrome within 3 seconds even when the driver hangs`;
  - `the tool description says never to type a password`;
  - contract item `session-deleted-event`.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement, porting 1.22 `chrome-control.js` and `service.js` `chromeAction`. Until Task 8, `approvals` is a stub that allows nothing, so live use waits for Task 8.
- [ ] **Step 4:** Re-run. Then one live check under Task 2's probe rules: the staged agent-browser, headless, throwaway profile, the loopback form page, `chrome.open` → `snapshot` → `fill` → `click` through `registry.execute` with an allow-all approvals fake. Expected: PASS, every peer loopback, no process left (AB5).
- [ ] **Step 5:** Commit `feat(mittr-server): agents drive a Chrome session from the person's profile, fenced to allowed sites`.

Upstream files added: 0. Running total: 34 + T5.

### Task 8: Chrome site approvals, never answered by auto-accept (A-21, A-30)

Take **one** path, as Task 1 ruled: **E** (the engine's own prompt) or **M** (MittrCraft's own prompt).

**Files:**
- Create `packages/mittr-server/src/mittr/tools/chrome-approvals.js` with `chrome-approvals.test.js`.
- Modify `tools/plugin-source.js`, `tools/chrome-service.js`, `tools/index.js` and their tests; `packages/mittr-server/src/upstream-contract.{js,test.js}`.
- **Path E** (hook):
  - `packages/web/server/lib/permission-auto-accept/runtime.js` (**new counted file, +1**, only if Task 1 P16 showed `auto` answers our ask) with `runtime.test.js`;
  - `packages/web/server/lib/server-plugins.js` (generic hook file) with `server-plugins.test.js`;
  - `packages/web/server/index.js` (counted);
  - `brand/upstream-hooks.json`.
- **Path M:** create in `packages/mittr-ui/src/tools/`, with tests: `chromeApprovalApi.ts`, `chromeApprovalController.ts`, `ChromeApprovalDialog.tsx`; modify `packages/mittr-ui/src/product-ui-plugin.tsx` (the root wrapper renders the dialog) and `mittr.en.ts`.

**Interfaces:**
- `CHROME_PERMISSION = 'mittrcraft_chrome'`.
- `createChromeApprovals({ settings }) -> { isApproved(sessionId, host), awaitDecision(sessionId, host, signal), record(sessionId, host, reply: 'once' | 'always' | 'reject'), removeHost(host) -> string[], forgetSession(sessionId), forgetAll() }`, a port of 1.22's:
  - `always` adds the host to `tools.chromeApprovedHosts`, and `once` or `always` grants it to that session;
  - `removeHost` removes it from settings and every session grant;
  - `awaitDecision` rejects with `Cancelled while waiting for the user` on abort.
- The site fence's `ensureApproved(host)`:
  - an approved host passes;
  - the first call answers 403 `{ code: 'site_approval_required', host }`, `The user has not yet allowed using their Chrome sign-in on <host>`;
  - the plugin then asks the person and calls again with `approvalAnswered: true`, which awaits the decision. `reject` answers 403 `The user did not allow using their Chrome sign-in on <host>`.
- **Path E:**
  - the plugin's `mittrcraft_chrome` execute raises the prompt with the call Task 1 P15 proved, with resources `[host]`, save `[host]`, message `Allow the agent to use your Chrome sign-in on <host>?` and metadata `{ host }`, then posts again with `approvalAnswered: true`;
  - `subscribeApprovals(events, approvals)` records `permission.asked` (`action === CHROME_PERMISSION`) and `permission.replied` (field names as P15 recorded) into `approvals`;
  - `removeHost` also deletes the engine's saved rule through the route P15d found, if the engine saves one;
  - the managed fragment adds the permission rule `CHROME_PERMISSION: 'ask'` in the v2 shape P15 recorded, if the engine needs it to ask;
  - **hook:** `createPermissionAutoAcceptRuntime({ …, neverAutoAnswer = () => false })`:
    - in `replyOnce`, after the mode is resolved and before the safety classifier, a mode other than `ask` with `neverAutoAnswer(permission) === true` returns `'held'`, so upstream broadcasts `left-for-user` and the client shows the request;
    - `isPermissionAutoAnswered` returns `false` for a request whose recorded outcome is `'held'`, before its `auto` shortcut;
    - `loadServerPlugins` returns `neverAutoAnswer(permission)`: true when any plugin's answers true, and a plugin that throws counts as true;
    - `index.js` passes `neverAutoAnswer: (permission) => serverPlugins?.neverAutoAnswer?.(permission) === true`;
    - mittr-server returns `neverAutoAnswer: (permission) => permission?.action === CHROME_PERMISSION`;
    - contract items `permission-never-auto-answer` and `permission-event-shape` (`action`, `resources`, `requestID`, the reply field).
- **Path M:**
  - the plugin posts once more with `awaitApproval: true`, and the server holds the call on `createChromePrompt`;
  - `createChromePrompt({ timeoutMs = 10 * 60_000 }) -> { ask({ sessionId, host, signal }) -> Promise<'once' | 'always' | 'reject'>, answer(id, reply) -> boolean, pending() -> Array<{ id, sessionId, host, askedAt }>, waitForChange(sinceRevision, ms) }`; a timeout or an abort counts as `reject`;
  - routes: `GET /api/mittr/tools/chrome/approvals?since=<rev>` (long-poll up to 25 s, answers `{ revision, pending }`) and `POST /api/mittr/tools/chrome/approvals/:id` `{ reply }` (404 for an unknown id);
  - `ChromeApprovalDialog` is upstream's `Dialog` with the text `mittr.tools.chrome.approval.title` ("Allow the agent to use your Chrome sign-in on {host}?") and three buttons, `mittr.tools.chrome.approval.once` ("Allow once"), `.always` ("Always allow"), `.reject` ("Don't allow"). It shows the oldest pending request first, closes when the request leaves `pending`, and is wrapped in `MittrErrorBoundary`;
  - no upstream permission path ever sees the question, so A-30 holds with no hook.

- [ ] **Step 1:** Write the failing tests:
  - Both paths:
    - `Allow once grants the session only`: a new session for the same host is asked again;
    - `Always saves the host and a removed host asks again`;
    - `Don't allow answers the refusal and opens nothing`;
    - `an aborted turn stops waiting and opens nothing`.
  - Path E:
    - in `runtime.test.js`, with permission `acme_browser`: `a request the plugin marks is held in every mode`, `held requests are broadcast as left for the user`, `isPermissionAutoAnswered is false for a held request in auto mode`, and `without the option nothing changes`;
    - `server-plugins.test.js`: `a plugin that throws in neverAutoAnswer holds the request`;
    - mittr-server: `an auto session leaves the Chrome question for the person and broadcasts it`, `a safety session never asks the classifier about it`, `the reply count for an auto session is zero` (fake engine), and `a reply event records once and always`.
  - Path M:
    - `the long-poll answers when a request is added and when it is answered`;
    - `an unknown approval id answers 404`;
    - controller: `the oldest request shows first` and `a request answered elsewhere closes the dialog`;
    - view: `the dialog names the host and offers three answers`, and `Mittr strings are English in Japanese`;
    - `no upstream auto-accept path ever sees the question`: no `permission.asked` is raised by the plugin source (source scan).
- [ ] **Step 2:** Run `iso bun run --cwd packages/mittr-server test`. Path E: also `iso bun run --cwd packages/web test -- server/lib/permission-auto-accept/runtime.test.js server/lib/server-plugins.test.js`. Path M: also `iso bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement the chosen path. Path E: the hook first, and append `{ hook: 'permission-never-auto-answer', why }` to the `permission-auto-accept/runtime.js`, `server-plugins.js` and `index.js` entries. The why: a downstream build has requests that must always reach the person (a site sign-in question), whatever the session's permission mode, and the auto-accept runtime had no way to leave one for the user.
- [ ] **Step 4:** Re-run, then `bun run type-check`, `bun run lint` and `node scripts/mittr/neutral-hook-tests.mjs` (0). Touch check: **34 + T5 + 1** (path E with the hook) or **34 + T5** (path M, or path E without it).
- [ ] **Step 5:** Commit. Path E: `hook(permission-never-auto-answer): leave marked permission requests for the user in every mode`, then `feat(mittr-server): agents ask before using the person's Chrome sign-in on a site`. Path M: `feat(mittr): agents ask before using the person's Chrome sign-in on a site`.

Upstream files added: 1 (path E with the hook) or 0. Running total: 34 + T5 + T8, where T8 is 0 or 1.

### Task 9: chrome.do, step by step through the Mittr platform (A-20)

**Files:**
- Create `packages/mittr-server/src/mittr/tools/browser-stepper.js` with `browser-stepper.test.js`.
- Modify `tools/chrome-service.js`, `tools/index.js` and their tests; `packages/mittr-server/src/mittr/platform.test.js` (`PLATFORM_CALLERS` gains the stepper).

**Interfaces:**
- `createBrowserStepper({ broker, ensureFreshSession, fetchImpl, timeoutMs = 30_000 }) -> { nextStep({ goal, snapshot, history, values }, signal) -> Promise<{ step, values?, decidedBy: string[], ms: number | null }> } | null`, a port of 1.22 `mittr-browser-step/service.js`:
  - `POST /desktop/browser/next-step` with the active account's bearer;
  - a step is used only when its action is one of `click`, `fill`, `select`, `done`, `ask`, `stop`, a click, fill or select has `ref` matching `/^e\d+$/`, and a fill or select has a string `value`; anything else answers 502 `The Mittr platform returned no usable step`;
  - no session: 401 `Sign in to Mittr first`; the timeout: 504 `The Mittr platform took too long to choose a step`; the platform's own `message` passes through;
  - it uses the R1 platform constants except the 30 s timeout, which 1.22 set for the decision model.
- `chrome.do` (change): a port of 1.22's `doChromeTask`:
  - `goal` is required; `maxSteps` defaults to 15 and is capped at 40;
  - it stops with `done`, `ask` (with `question`), `stopped` (with `reason`), `stuck` (the same step line three times) or `step_limit`;
  - every step is run with Task 7's checks and followed by `ensureStillApproved()`;
  - a platform failure is reported as `stopped` with its reason, not thrown;
  - the result always carries `{ outcome, steps: [{ step, decidedBy, ms }], url }`.
- `chrome.do` is available only while an account is signed in.

- [ ] **Step 1:** Write the failing tests (fake fetch, fake chrome control):
  - `a form goal fills the name, submits and ends done with every step listed`;
  - `a goal missing a value stops with the platform's question`;
  - `the same step three times stops as stuck`;
  - `maxSteps 50 is capped at 40`;
  - `a platform 503 ends as stopped and keeps the steps taken`;
  - `a chrome.do step that leaves the host stops with site_moved and keeps the steps taken`;
  - `a step without a ref is not run`;
  - `no account makes chrome.do unavailable`;
  - `the access token appears in no log line or result`.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): chrome.do works through a page step by step with the Mittr platform's choices`.

Upstream files added: 0. Running total: 34 + T5 + T8.

### Task 10: Jira and Plane cards by key (A-28, A-29)

**Files:**
- Create `packages/mittr-server/src/mittr/tools/work-lookup.js` with `work-lookup.test.js`.
- Modify `tools/index.js`, `packages/mittr-server/src/mittr/platform.test.js` and their tests.

**Interfaces:**
- `registerWorkActions(registry, { broker, ensureFreshSession, fetchImpl, engineAccount: () => string | null })` registers on tool `mittrcraft_work` (description: 1.22's sentences about `jira.get_issue` and `plane.get_issue`, including "A Plane link is a sign-in page to a plain fetch; read it with plane.get_issue."):
  - `jira.get_issue` (read): `key` required (400 `key is required for jira.get_issue`), `GET /desktop/jira/issues/<encoded key>`;
  - `plane.get_issue` (read): `ref` required (400 `ref is required for plane.get_issue`), `GET /desktop/plane/issues?ref=<encoded ref>`;
  - the platform body passes through unchanged; a non-ok answer gives its `message`, or `Failed to load Jira issue <key>` / `Failed to load Plane work item <ref>`, with the platform's status; a timeout is 504 `Mittr platform request timed out`; no account is 401 `Not signed in to Mittr. Sign in to continue.`
- **Account guard:** the read uses `ensureFreshSession()`. When that session's `subject.userId` differs from `engineAccount()` (the account the running engine was started for), the action answers 409 `The Mittr account changed; ask again in a moment.` and reads nothing.

- [ ] **Step 1:** Write the failing tests (fake fetch):
  - `a Jira key is read through the platform and passed through`;
  - `a Plane link is sent as ref, encoded`;
  - `a missing key answers 400 and calls nothing`;
  - `a platform 404 passes its message`;
  - `a lookup whose session changed account during the call answers 409 and returns nothing`;
  - `the access token appears in no reply or log line`.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement, porting 1.22 `mittr-work/service.js` `readLive`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): agents read a Jira or Plane card by key through the person's Mittr account`.

Upstream files added: 0. Running total: 34 + T5 + T8.

### Task 11: MittrCraft tools in Settings (A-01 UI half, A-22)

**Files:**
- Create `packages/mittr-server/src/mittr/tools/settings-routes.js` with `settings-routes.test.js`.
- Create in `packages/mittr-ui/src/tools/`, each with tests:
  - `toolsApi.ts`;
  - `toolsController.ts`;
  - `MittrToolsSection.tsx`.
- Modify `packages/mittr-ui/src/product-ui-plugin.tsx`, `packages/mittr-ui/src/strings/mittr.en.ts` and `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- Routes (UI auth, `/api`):
  - `GET /api/mittr/tools` answers `{ computer: { offered: boolean, enabled: boolean }, chrome: { offered: boolean, chromeInstalled: boolean, enabled: boolean, profile: string | null, headed: boolean, approvedHosts: string[] } }`. `offered` is false on a hosted runtime or without the driver;
  - `PUT /api/mittr/tools` takes `{ computer?, chrome?, chromeProfile?, chromeHeaded? }` (`jsonBody`, 8kb) and calls `applySwitches`. An unknown key or a wrong type is 400 `Unknown or invalid tool setting: <key>`;
  - `GET /api/mittr/tools/chrome/profiles` answers `{ profiles: [{ directory, name }] }`;
  - `DELETE /api/mittr/tools/chrome/approved-hosts/:host` answers `{ hosts }`.
- `createToolsController({ api }) -> { state(), subscribe(fn), load(), setComputer(on), setChrome(on), setProfile(directory), setHeaded(on), removeHost(host), dispose() }`: only the latest request sets state, and a failed write reloads.
- `MittrToolsSectionView({ state, profiles, … })` is markup only, built from upstream's `SettingsSection`, `SettingsCheckboxRow`, `SettingsFieldRow`, `Select` and `Button`, ported from 1.22 `MittrCraftToolsSettings.tsx` (the Computer and Chrome rows; upstream's own Tools section keeps control, web, notify and Code Mode):
  - a tool with `offered: false` shows no switch; when nothing is offered the section renders nothing;
  - Chrome offered but not installed shows one line, `mittr.tools.chrome.notInstalled` ("Install Google Chrome to let agents use it."), and no switch;
  - with Chrome on: the profile picker (no profiles listed shows `mittr.tools.chrome.noProfiles`, "Chrome has no profiles on this Mac.", and no picker), the "Show the Chrome window" switch, and the allowed-sites list with Remove (an empty list shows `mittr.tools.chrome.sitesEmpty`).
- **Placement (owner item 4):** `'integrations-page'` gains `MittrToolsSection` after `WorkTrackingSettingsItem`, wrapped in `MittrErrorBoundary` (0 files).
- Strings: every 1.22 key under `settings.mittrcraft.tools.*` for the Computer and Chrome rows moves into `mittr.en.ts` as `mittr.tools.*`, English values unchanged, plus the new keys above (and Task 8's on path M). The section title is `mittr.tools.title` ("MittrCraft tools").
- Contract item `settings-section-primitives`: `SettingsSection`, `SettingsCheckboxRow` and `SettingsFieldRow` are still exported from `components/sections/shared/SettingsSection`.

- [ ] **Step 1:** Write the failing tests:
  - Routes: `GET lists what this install offers`, `PUT changes a switch and refreshes the tools`, `an unknown key answers 400 and stores nothing`, `removing a site answers the remaining list`.
  - Controller: `a failed write reloads the stored state` and `a slow load never overwrites a newer one`.
  - View (`renderToStaticMarkup`):
    - `a tool this install cannot run shows no switch`;
    - `a hosted runtime renders nothing`;
    - `Chrome not installed shows the install line and no switch`;
    - `no Chrome profiles shows the line and no picker`;
    - `the allowed sites list each host with Remove`;
    - `Mittr strings are English in Japanese` (C-02).
  - Plugin: `the integrations slot holds Work tracking, then MittrCraft tools`.
  - Contract item.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test` and `iso bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement per `settings-ui-patterns` and `theme-system`.
- [ ] **Step 4:** Re-run, then `bun run type-check`, `bun run lint` and `node scripts/mittr/test-baseline.mjs`. Expected: PASS. Touch check unchanged.
- [ ] **Step 5:** Commit `feat(mittr): Computer and Chrome tool settings with the Chrome profile and allowed sites`.

Upstream files added: 0. Running total: 34 + T5 + T8.

### Task 12: Phase 4A gate — every A row on an isolated Dev build

**Files:**
- Create `docs/plans/2026-10-21-phase-4a-gate.md`.
- Modify `scripts/mittr/stub-platform.mjs` and `scripts/mittr/stub-platform.test.mjs`.
- Create, each with a test:
  - `scripts/mittr/stub-pages.mjs`: a loopback test-page server;
  - `scripts/mittr/stub-cua-driver.mjs`: an executable stub of the driver;
  - `scripts/mittr/stub-open.mjs`: an executable stub of `open` that records its arguments.

**Isolation.** Every launch follows the Global Constraints:
- a fresh `p4.XXXX` temp HOME per scenario;
- the Dev binary launched directly, killed by its PID;
- the R46 per-call guard;
- R9 recorded;
- a before and after `stat` of the real dirs **and** of the real Chrome folder's top level (`stat -f %m` of `~/Library/Application Support/Google/Chrome` only, never its contents);
- the owner's Chrome PIDs and start times before and after.

The evidence stays outside the repository, holds no secret, and is never named.

The gate runs in two parts:
- **Part A** is headless on a loopback stub with a throwaway Chrome, and needs no owner.
- **Part B** runs only with the owner present, and the owner's yes for each numbered step.

- [ ] **Step 1: Stubs and static checks.**
  - **Stub platform**, extended with tests:
    - `POST /desktop/browser/next-step`: scripted, for the form goal fill `e1` "Somchai" → click `e3` → done, and `ask` "What email should I use?" when the goal holds no email the page asks for;
    - `GET /desktop/jira/issues/MRKB-1` (SA: summary "Fix login", status "In Progress");
    - `GET /desktop/plane/issues?ref=` (SA: `TF-7`, name "Draft spec", state "Todo");
    - the stub model calls our tools on fixed phrases (`chrome open <url>`, `chrome do <goal>`, `computer list apps`, `computer screenshot`, `read jira <key>`, `read plane <ref>`, `capture the page`, `list your tools`), and records the tools offered and whether each request carried an image (by sha256), never a header.
  - **Stub pages** on `127.0.0.1` and `localhost`, so they are two hosts:
    - `/form` (name, email, a select, submit → `/thanks`);
    - `/error` (logs a console error);
    - `/redirect` (sends `localhost` to `127.0.0.1/landing`);
    - `/sign-in` (a password field);
    - `/style` (an `h1` at 32px, a button `#0a7`).
  - **Stub driver and `open`:** canned `list_apps` (Finder, MittrCraft Dev, Calculator not running), `bring_to_front`, `get_desktop_state` (a fixed PNG), and a mode that answers the driver's Screen Recording error text; `open` records its arguments to a file.
  - **Build and static checks:**
    - `node scripts/mittr/build-desktop.mjs --flavor dev`: exit 0, leak scan clean, drivers and notices verified (Task 2);
    - `node scripts/mittr/check-upstream-touch.mjs --no-write`: **34 + T5 + T8 of 40**, nothing unlisted, nothing stale;
    - `bun run type-check`, `bun run lint`, `node scripts/mittr/test-baseline.mjs`;
    - `iso bun run --cwd packages/mittr-server test`, `iso bun run --cwd packages/mittr-ui test`, `iso bun run --cwd packages/mittr-opencode test`, `node scripts/mittr/neutral-hook-tests.mjs`.
- [ ] **Step 2 — Part A, headless.** Launch with `MITTRCRAFT_BROKER_URL=http://127.0.0.1:<stub>`, `MITTRCRAFT_SHIM_LOG=1`, `MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR=<stub driver dir>`, `PATH=<stub open dir>:/usr/bin:/bin`, the quiet-Chrome arguments Task 2 proved in the env, and `chromeHeaded` false. A throwaway Chrome profile is seeded under the temp HOME and chosen in Settings. Record the command, the observed value and PASS or FAIL for each:
  - **Upstream tools, verify only:**
    - **A-02:** "create a session in this project that writes hello.txt" → a new session appears and runs;
    - **A-03:** `projects.list` names the temp project;
    - **A-04:** `schedule.create` daily 09:00 with `mittr/stub-sa-fast` is listed, and `schedule.run` starts a session whose turns the shim log ties to that model. The same with `openai/gpt-4o` is refused, or its run never completes and nothing leaves loopback; record which;
    - **A-05 to A-12** in the browser panel against stub pages: open at mobile size (375-wide), the snapshot quotes `/error`'s console error, click "Submit", type with Enter, scroll to the footer, back and forward, `inspect` gives the h1 `32px`, resize to tablet;
    - **A-31:** `POST /api/openchamber/control {action:'session.list'}` through the window's runtime fetch lists sessions, and `POST /api/mittr/control {action:'computer.list_apps'}` answers the stub list.
  - **A-01:** "list your tools" shows `mittrcraft_chrome`, `mittrcraft_computer` and `mittrcraft_work`. Turn Chrome off: within 5 s the next turn has no Chrome tool and the engine PID is unchanged (or the one restart Task 1 P17 recorded). Turn it on: back.
  - **A-13:** "capture the page" on `/style` → a PNG under `<project>/.openchamber/screenshots/`, and the stub's next request carries that image's sha256.
  - **A-15 to A-19:**
    - Chrome opens `http://127.0.0.1:<p>/form` headless after approval;
    - `read` matches the page text;
    - `fill`, `select` and `press Enter` submit it;
    - the value `--headed` is refused;
    - `screenshot` saves a PNG and the stub sees its image;
    - `close`, then deleting a session, closes that session's Chrome;
    - quitting the app leaves no `agent-browser` or throwaway-profile Chrome process.
  - **Site fence (Review Focus 2):** opening `http://localhost:<p>/redirect` after allowing `localhost` answers `site_moved` naming `127.0.0.1`, and no landing text reaches the stub.
  - **A-20:** "chrome do fill name Somchai and submit" lists the steps and ends `done`; the email goal ends `ask` with the stub's question.
  - **A-21:** the first `chrome.open` on `127.0.0.1` shows the prompt naming the host (DOM read). Then:
    - Allow once opens it; a new session on the same host asks again;
    - Always allow saves it and Settings lists `127.0.0.1`;
    - Remove there, and it asks again;
    - Don't allow opens nothing.
  - **A-30:** with the session in Auto, the prompt still shows and waits, and the stub sees no Chrome page text before the answer. In Safety: the same (with no classifier provider Safety waits anyway; the hook's Safety branch is covered by Task 8's tests).
  - **A-22:** change the profile and the visible-window switch, restart the app on the same HOME: both kept; `mittr-settings.json` holds them; the removed site is gone.
  - **A-23 to A-26 (stub driver):**
    - the app list has Finder and MittrCraft Dev;
    - "open Calculator" records `open -a Calculator`;
    - bring to front calls the stub with Calculator's pid;
    - the screenshot is saved as `desktop-*.png` and the stub sees it;
    - in the error mode, the answer names Screen Recording and where to turn it on.
  - **A-27:** in the packed app, `agent-browser --version` gives 0.38.1 and `cua-driver --version` gives 0.28.2; both sha256 values match the pin; `CuaDriver.app` keeps `com.trycua.driver` and `YCK386LBJ7`; `THIRD_PARTY_NOTICES.md` is in `Contents/Resources`.
  - **A-28 / A-29:** "read jira MRKB-1" quotes "Fix login" and "In Progress"; "read plane <TF-7 url>" quotes "Draft spec".
  - **Accounts (Review Focus 3):** sign SA and SB in; switch to SB while a `chrome.do` runs against a slow stub step: every agent Chrome closes; a call carrying SA's token answers 401; SB's Jira lookup uses SB's session.
  - **Hosted (Review Focus 5):** the packed `mittrcraft serve` (the phase 3 R-F7 layout): "list your tools" shows `mittrcraft_work` and neither Chrome nor computer; `GET /api/mittr/tools` reports both not offered.
  - **Secrets:**
    - `grep -r -F` of the tools token, held in a shell variable read from `ps eww` and never written down, across the temp HOME and the server and engine logs finds nothing;
    - `ps eww <engine>` holds no Mittr access token, shim key, `JIRA_TOKEN` or `PLANE_API_KEY`.
  - **C-02:** in Japanese, the MittrCraft tools section and the approval prompt (path M) show English Mittr strings and no raw key.
  - **Egress:** `lsof` every 0.3 s over the app, server, engine, `agent-browser` and Chrome PIDs: loopback only, apart from phase 3's known upstream peers (recorded, not counted as new).
- [ ] **Step 3 — Part B, INTERACTIVE BLOCK (owner at the keyboard; one sitting; the owner's yes per numbered step).** The owner types every credential and answers every OS dialog. The controller reads results only (R10). Every step records its before state.
  1. Sign in as A on a fresh HOME (R66 symlinks).
  2. **Desktop before grants:** ask for a desktop screenshot. Expected: the answer names Screen Recording.
  3. **TCC grants (owner only):** the owner turns on Accessibility and Screen Recording for the gate build's `CuaDriver.app` in System Settings, and records which entries existed before.
  4. **Desktop:** list apps, open Calculator, bring it to the front, take a screenshot and describe what is open (A-23 to A-26).
  5. **Chrome, the owner's real profile:** the owner chooses their profile in Settings and turns the visible window on. Record the profile folder's top-level mtime before and after; whether `agent-browser` opens the profile in place or copies it; and whether the owner's running Chrome is affected (Chrome may refuse a profile in use; quitting Chrome is the owner's call).
  6. **Chrome on sites the owner names:** `https://example.com` (banner on the page; read the heading; screenshot and description: A-15, A-16, A-18) and one site the owner is signed in to (shows signed in, A-15). Approvals: once, then always, then remove (A-21). The same in Auto mode (A-30).
  7. **A-33:** with a real Mittr model, ask Chrome to log in on the loopback `/sign-in` page: the agent stops and names the site, and types nothing.
  8. **A-20 on the dev platform:** `chrome.do` on the loopback `/form`. Expected: `done` with steps, or a NOT RUN with the reason if the dev platform's decision model is not configured.
  9. **A-28:** read one of A's real Jira keys. Plane is NOT RUN (no Plane account, phase 3 finding 27).
  10. **A-13 and A-04 with a real Mittr model:** capture `/style` and name the button colour without opening the file; create and run one scheduled task on a Mittr model.
  11. **Clean-up:** close every agent Chrome; restore Settings; the owner decides whether to revoke the TCC grants. Record after.
- [ ] **Step 4:** Isolation evidence:
  - the real dirs `diff` is empty;
  - the real Chrome folder's top level was untouched in Part A;
  - no upstream default dirs in any temp HOME;
  - the installed apps' PIDs and uptime are unchanged;
  - the holder of 57133 before each launch, and every `$PORT` call guarded;
  - R9 before and after;
  - the TCC entries before and after Part B;
  - the egress table.
- [ ] **Step 5:** Write the gate note:
  - a verdict table by group: upstream tools, switches, images, desktop, Chrome, chrome.do, approvals, work lookups, settings, drivers, accounts, hosted, secrets, egress, isolation;
  - every row with evidence, and findings numbered;
  - the touch count, with each new file's hook and why;
  - a "needs the owner" list naming each NOT RUN row and what would unblock it;
  - platform follow-ups.

  Commit `docs(mittr): phase 4A gate on the Dev build`. **Do not push.**

Upstream files added: 0. Running total: 34 + T5 + T8.

---

## Interfaces 4B will consume

4B (voice, P4-V1 to P4-V9) builds its tools (`mittrcraft`, `mittrcraft_web`, `mittrcraft_voice`) and its turn loop on these. 4A names them, tests them, and changes none of them without updating this list.

- **Upstream's contract (Task 3):** `context.control.execute(action, input, contextDirectory, { signal, contextSessionId })`, `context.control.resolveSessionDirectory(sessionID)` and `context.control.definitions() -> { control, web }`.
  - Agents get `returnResult` and no `wait`. The CLI keeps `wait`. Voice calls the service directly and may use `wait` (P4-V6).
- **Mittr actions (Task 3):** `registry.register({ action, tool, title, description, effect, voiceOnly: true, available, execute })` is how 4B adds `session.stop`, `session.read_reply` and `chrome.allow_site`.
  - `registry.definitions({ includeVoiceOnly: true })` and `registry.tools()` give the schemas.
  - `registry.execute(action, input, { directory, sessionId, signal, headed: true, surface: 'voice' })` runs any Mittr or upstream action. `headed: true` opens Chrome visibly for voice, as 1.22's `510964a11` did.
  - `effect: 'read' | 'change'` on every Mittr action feeds P4-V8's "text read in a turn cannot change work in the same turn"; 4B keeps 1.22's refusal list.
  - `MittrToolError` carries `code` (`site_approval_required`, `site_moved`, `chrome_profile_required`) and `host`, which the voice loop turns into its one spoken question.
- **Chrome conversation (Task 7):** `chrome.allowForConversation(sessionId)`, `chrome.endConversation(sessionId)` and `chrome.isHostAllowed(sessionId, host)`. A grant is never stored; removing a site in Settings removes it.
- **Switches (Task 4):** `setupMittrTools(...).switches() -> { computer, chrome }` beside upstream's `agentControlToolEnabled` / `agentWebToolEnabled`. Together these are the four switches the voice loop honours.
- **HTTP (Task 3):** `POST /api/mittr/control` for anything that cannot call in-process.

---

## Coverage and budget

| Inventory item | Task(s) |
|---|---|
| A-01 tool switches | 1 (P17), 4, 11, 12 |
| A-02 session actions (verify) | 12 |
| A-03 projects and models (verify) | 12 |
| A-04 scheduled tasks, Mittr model (verify) | 12 |
| A-05 to A-12 in-app browser (verify) | 12 |
| A-13 capture the model sees | 1 (P13b, P14), 5, 12 |
| A-15 chrome.open from the person's profile, banner | 2, 7, 12 |
| A-16 chrome snapshot and read | 7, 12 |
| A-17 chrome click/fill/type/press/select/wait, flag refusal | 7, 12 |
| A-18 chrome screenshot seen | 5, 7, 12 |
| A-19 chrome close, every Chrome closed on quit | 7, 12 |
| A-20 chrome.do | 9, 12 |
| A-21 Chrome site approvals | 1 (P15), 8, 12 |
| A-22 Chrome settings | 4, 11, 12 |
| A-23 computer.list_apps | 6, 12 |
| A-24 computer.open_app | 6, 12 |
| A-25 computer.bring_to_front | 6, 12 (Part B) |
| A-26 computer.screenshot seen | 5, 6, 12 |
| A-27 bundled drivers and notices | 2, 12 |
| A-28 jira.get_issue | 10, 12 |
| A-29 plane.get_issue | 10, 12 (Part A only) |
| A-30 never auto-accept the Chrome question | 1 (P16), 8, 12 |
| A-31 one action contract | 3, 12 |
| A-33 never type passwords | 7, 12 (Part B) |
| Voice seam (P4-V6 to P4-V8 interfaces) | 3, 4, 7 |
| C-01 settings pages (MittrCraft tools) | 11, 12 |
| C-02 English Mittr strings | 8 (path M), 11, 12 |
| C-08 env flags `MITTRCRAFT_BUNDLED_*` | 6, 7 |
| C-10 screenshot folder | 5 |
| C-11 settings keys moved under `mittr` | 4 |
| C-13 plugin context (control, shutdown) | 3, 7 |

Carried, not in this phase:
- **Phase 5 walk:** A-14 (the browser panel for the person) and A-32 (the `mittrcraft` CLI). With A-32, the bin also sends Mittr action names given to `mittrcraft control` to `/api/mittr/control`. 1.22's CLI reached `computer.*` and `jira.*`; this keeps that, and is not dropped.
- **4B:** P4-V1 to P4-V9.
- **Platform follow-up:** a vision flag on catalog models, if Task 1 P14 made every Mittr model take images.

### Upstream files this phase may count

| File | Task | Hook | When |
|---|---|---|---|
| `packages/web/server/lib/permission-auto-accept/runtime.js` | 8 | `permission-never-auto-answer` | path E, and P16 shows `auto` answers our ask |
| `packages/web/server/lib/agent-tool/runtime.js` | 5 | `agent-tool-capture-image` | only if P13b fails |

Edits to files already counted or generic (no count change):
- `packages/web/server/index.js` (Tasks 3, 5 hook route, 8 path E);
- `packages/web/server/lib/server-plugins.js` (Tasks 5 hook route, 8 path E).

Zero-touch routes taken first:
- our own plugin tools instead of entries in upstream's template;
- a transform wrapper instead of a capture hook;
- the existing `integrations-page` slot instead of a tools slot;
- our own loopback callback outside `/api`, as the shim uses;
- `dispose()` and `session.deleted` events for Chrome clean-up, so no shutdown hook;
- a MittrCraft prompt (path M) that needs no auto-accept hook.

### Budget, against the cap of 40

| Point | Counted files | Remaining |
|---|---|---|
| After phase 3 (today) | 34 | 6 |
| **4A best:** wrap works, path M or no hook needed | **34** | 6 |
| **4A expected:** wrap works, path E with the auto-accept hook | **35** | 5 |
| **4A worst:** capture hook and auto-accept hook | **36** | 4 |
| 4B projected: `ComposerFooter.tsx` (Talk button slot), `ComposerDictation.tsx` (dictation quota), `VoiceSettings.tsx` (voice settings) | +3 → 37–39 | 1–3 |
| 4B with voice settings in an existing Mittr slot | +2 → 36–38 | 2–4 |
| Phase 5 named: `ChatInput.tsx`, `MainLayout.tsx`, `useUIStore.ts`, `ContextSidebarTab.tsx` | +4 → 40–43 | 0 to −3 |
| Phase 5 with both named savings | +2 → 38–41 | 2 to −1 |
| Phase 3 owner items, if taken: org-connector listing (R128), I3 redaction, Settings search | +1 each | |

**Plainly:** 4A fits in every case (34–36). The whole re-fork fits the cap of 40 only if 4A ends at 34 or 35, 4B puts voice settings in an existing slot (+2), phase 5 takes both savings (+2), and none of phase 3's optional hooks is taken. Otherwise it reaches 41–43, and that is an owner decision before phase 5: raise the cap, or accept reduced variants.

## Owner decisions this plan needs

1. **Budget** (table above). Approve that 4A may add up to 2 counted files, and that the cap question waits until 4B is planned.
2. **Chrome approval prompt (A-21, A-30).** Default: the engine's own permission prompt (as 1.22), with the auto-accept hook (+1), when Task 1 P15 proves it works. Alternative: MittrCraft's own prompt (0 files), which auto-accept can never answer, shown in MittrCraft windows only. If P15 fails, the alternative is forced and only reported.
3. **How the model sees a browser-panel capture (A-13).** Default: our plugin wraps upstream's panel tool (0 files). If Task 1 P13b fails: a hook in `agent-tool/runtime.js` (+1). A 0-file option is a separate "look at this screenshot" action, at the cost of a second tool call per capture.
4. **Where the Computer and Chrome settings live.** Default: Settings → Integrations, after Work tracking, through the existing slot (0 files). Alternative: 1.22's place, beside upstream's own tool switches in Settings → Tools, through a new slot in `OpenChamberToolsSettings.tsx` (+1).
5. **Images and Mittr models.** If Task 1 P14 shows the engine passes images only to models marked as taking them, every Mittr model is marked, because the catalog has no vision flag. A model that cannot take images then answers the platform's error. Platform follow-up: a vision flag in `/desktop/catalog`.
6. **Driver downloads.** None is needed for the arm64 build. Local copies were found in the main checkout's build cache and are copied read-only, pinned by sha256:
   - `agent-browser-darwin-arm64` 0.38.1, 15,768,448 bytes, sha256 `2e612872…e892e0d`;
   - `cua-driver-rs-0.28.2-darwin-universal.tar.gz`, 70,078,129 bytes, sha256 `e273181b…fc3fbb1`.

   An **x64** build has no local `agent-browser-darwin-x64` (from `https://github.com/vercel-labs/agent-browser/releases/download/v0.38.1/agent-browser-darwin-x64`; size not known until the release is listed). Downloading it is an outward action that needs your yes. Until then the x64 build has no Chrome tool.
7. **CuaDriver's identity.** macOS asks for Accessibility and Screen Recording under "CuaDriver" (Cua AI's Developer ID `YCK386LBJ7`), as in 1.22. The build must not re-sign it, or every grant is lost. Accept as 1.22.
8. **Allowed Chrome sites are per Mac, not per Mittr account,** as in 1.22 and like phase 3's enablement (item 14). Session grants and agent Chrome sessions are cleared on every account switch.
9. **Q5, upstream's newer agent tools.** Default: keep upstream's defaults. Notify is off, memory ships switched off upstream, and `session.link` and `file.open` are part of the control tool.
10. **Part B with your real Chrome profile and desktop.** Each step needs your yes:
    - the sites you name (they are third parties);
    - letting `agent-browser` start from your real profile (it may need Chrome quit, and may write to the profile if it opens it in place; recorded);
    - `chrome.do` and Jira reads through the dev platform.
11. **TCC grants for the gate build.** You grant Accessibility and Screen Recording to the gate build's `CuaDriver.app`. Because it carries Cua's own signature, the same grant may already cover, or will also cover, the installed 1.22's `CuaDriver.app`. You choose whether to revoke afterwards.
12. **Code Mode and images.** If Task 1 shows images are lost through Code Mode, then with "Run through Code Mode" on, screenshots reach the model as a saved path only. Accept, or ask for our tools to stay direct whatever that setting says.
13. **Carried from phase 3, still open:** gate builds share their name and bundle id with the installed Dev 1.x (item 23); Go work's first turn fetches the card's URL without a prompt (item 24; `mittrcraft_work` now lets an agent read the card by key, but the Go work prompt is unchanged).
