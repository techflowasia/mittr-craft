# Upstream Rebase — Phase 1: Base, Branding, Data Carry-over — Implementation Plan

**Goal:** A MittrCraft Dev build on upstream OpenChamber 2.1.1 that is branded MittrCraft, opens on a copy of real 1.22 data with every session intact, and never touches a real OpenChamber/OpenCode install. It does not sign in to Mittr yet; that is phase 2.

**Architecture:** A new branch starts at upstream's 2.1.1 release commit. Upstream files get only small generic hooks:
- `product.json` drives the Electron constants;
- a server-plugin loader that can add engine env;
- a UI plugin registry for strings and logo;
- two path bug-fixes.

Mittr code lives in new packages (`packages/mittr-server`, `packages/mittr-ui`), `brand/` and `scripts/mittr/`. A build script assembles a flavor.

**Tech Stack:** Bun 1.4.2 workspaces, Node ≥ 22, Electron 43 + electron-builder 26, React/Vite UI (vitest), web server tests via `node --test` (`scripts/run-isolated-tests.mjs`), OpenCode 2.0.23 (upstream's bundled CLI).

**Spec:** `docs/specs/2026-10-16-upstream-rebase-design.md`. Read §5–§7 before starting.

## Global Constraints

- Upstream base: commit `e302062e3` ("release v2.1.1", 2026-10-05). Write its full hash to `brand/UPSTREAM`.
- Bun version: whatever the base's root `packageManager` says (`bun@1.4.2`). Node ≥ 22.
- Do not add dependencies. Do not modify `../opencode`.
- Every commit that edits a file upstream owns gets a `hook(<name>): …` subject and a body with one paragraph saying why the hook exists. The hook may name no Mittr concept and must keep upstream behaviour when unused.
- Files we own and may edit freely: `packages/mittr-*/**`, `brand/**`, `scripts/mittr/**`, `patches/**`, `docs/**`. Everything else is upstream.
- Upstream files edited in this phase, which must stay ≤ 24 for the whole programme:
  - `entry.mjs`, `early-startup.mjs`, `main.mjs`, `updater-feed.mjs` (plus the updater capability check if needed);
  - `enterprise-mode.js`, `fs/routes.js`, `server/index.js`, `v1-migration-topup.js` + its call in `lifecycle.js`;
  - `ui/src/main.tsx`, `renderElectronMiniChatApp.tsx`, `i18n/store.ts`, `OpenChamberLogo.tsx`.

  New upstream-side files (`packages/electron/product.mjs`, `packages/web/server/lib/server-plugins.js`, `packages/ui/src/lib/product-plugins.ts`) are generic and count as hooks for review, not toward the 24.
- Company rules:
  - Git and pushing need the owner's word. Work on local branches; **do not push** without asking.
- Never write to `~/.config/openchamber`, `~/.local/share/opencode`, `~/.config/opencode`, or the installed prod MittrCraft's data. All runtime proofs use copies under a temp `HOME`.
- Product values, copied from today's `packages/electron/app-flavor.mjs` and `lib/opencode/home.js`:

| | prod | dev |
|---|---|---|
| appId | `dev.mittrcraft.desktop` | `dev.mittrcraft.desktop.dev` |
| productName / app name | `MittrCraft` | `MittrCraft Dev` |
| deep-link scheme | `mittrcraft` | `mittrcraft-dev` |
| default desktop port | `57123` | `57133` |
| `OPENCHAMBER_DATA_DIR` | `~/.config/mittrcraft` | `~/.config/mittrcraft-dev` |
| engine XDG bases | config `~/.config/mittrcraft/engine`, data `~/.local/share/mittrcraft/engine`, state `~/.local/state/mittrcraft/engine`, cache `~/.cache/mittrcraft/engine` | all four `~/.config/mittrcraft-dev/engine` (`MITTRCRAFT_ENGINE_HOME`) |
| `OPENCODE_CONFIG_DIR` | `~/.config/mittrcraft/engine/opencode` | `~/.config/mittrcraft-dev/engine/opencode` |
| account data/state | `<base>/accounts/<16-hex>` for data and state only | same |
| policy file | `/Library/Application Support/MittrCraft/policy.json` | `/Library/Application Support/MittrCraft Dev/policy.json` |
| version | `2.1.1+mittr.1` | `2.1.1+mittr.1` |
| updater | off | off |
| bug / ideas / Discord links | none (menu items hidden) | none |

## Review Focus

1. **A developer's shell has `OPENCODE_CONFIG_DIR`, `XDG_*` or `OPENCHAMBER_DATA_DIR` set for their personal tools.** Product env must still win for the app process. The engine must still get our XDG values (the engine env is `{...shellEnv, ...process.env, ...managedEnv}`). Test: Task 2 `applyProductEnv overrides a preset OPENCODE_CONFIG_DIR`; Task 6 `engine env wins over a shell XDG_DATA_HOME`.
2. **A real OpenChamber is installed on the same Mac.**
   - Our build must not read its `~/.config/openchamber` folders, its `policy.json`, or its userData `~/Library/Application Support/OpenChamber`.
   - Test: Task 2 `ensureProductDirs pre-creates projects/themes/speech-models`; Task 3 `app name comes from product`; Task 4 `policy path follows OPENCHAMBER_POLICY_FILE`.
3. **The backup cannot be made** (disk full, permission). The engine must not start on the un-backed-up data. Test: Task 6 `setup rejects when backup copy fails` and Task 4 `server start fails when a plugin setup rejects`.
4. **`mittr-accounts/index.json` is missing, corrupt, or names an account with no folder yet.** The engine falls back to the legacy home and logs it, with no crash. Test: Task 6 `activeAccountHome falls back on corrupt index`.
5. **The V1 top-up must never touch `~/.local/share/opencode`** when the engine data dir is elsewhere. Test: Task 6 `topUp resolves the data dir from the engine env`.

---

### Task 1: Base branch and baseline

**Files:**
- Create: `brand/UPSTREAM` (one line: full hash of `e302062e3`)
- Modify: `.git/info/exclude` (local only): add `packages/electron/.product/` and `packages/electron/product-plugins/`

- [ ] **Step 1:** In `~/Documents/mittr-craft`, confirm the checkout is clean apart from untracked `packages/electron/dist-*`. Create the branch `rebase/upstream-2.1.1` from `e302062e3`. Use a worktree at `.worktrees/rebase-2x` so the team's 1.22 builds in the main checkout stay usable; the repo already uses `.worktrees/`.
- [ ] **Step 2:** `bun install` with bun 1.4.2. Expected: the install succeeds and creates no new lockfile.
- [ ] **Step 3:** Record the untouched baseline:
  - `bun run type-check`, `bun run lint`, `bun run test`
  - Save the pass/fail summary to `docs/plans/2026-10-16-phase-1-baseline.txt`.
  - Upstream failures found here are not ours to fix. Later tasks must not add any.
- [ ] **Step 4:** Commit `brand/UPSTREAM` and the baseline file: `chore(brand): record upstream base 2.1.1`.

### Task 2: `product.mjs` — read the product file

**Files:**
- Create: `packages/electron/product.mjs`, `packages/electron/product.test.mjs`

**Interfaces:**
- Produces:
  - `UPSTREAM_PRODUCT`: frozen defaults, equal to upstream's literals today. Keys:
    - `appName:'OpenChamber'`, `linuxDesktopName:'openchamber.desktop'`, `deepLinkProtocol:'openchamber'`;
    - `appUserModelId:{packaged:'dev.openchamber.desktop',dev:'dev.openchamber.desktop.dev'}`, `desktopPort:57123`;
    - `links:{bugReport,ideas,discord}` (upstream URLs from `main.mjs` ~233–235);
    - `updaterFeed:{provider:'github',owner:'openchamber',repo:'openchamber'}`;
    - `env:{}`, `ensureDirs:[]`, `serverPlugins:[]`.
  - `readProduct({ appPath: string, fs?, homeDir? }) -> Product`:
    - reads `<appPath>/product.json` when present and deep-merges it over the defaults;
    - expands a leading `~/` with `homeDir`;
    - resolves `serverPlugins` entries relative to `appPath`;
    - `links.*: null` and `updaterFeed: null` are kept as `null`.
  - `applyProductEnv(product, env = process.env) -> string[]`: sets every key of `product.env`, **overriding** existing values, and returns the keys set.
  - `ensureProductDirs(product, fs?) -> void`: `mkdir -p` each `ensureDirs` entry.
  - `PRODUCT`: computed once at import with `appPath = app.getAppPath()`. Then applies env, sets `OPENCHAMBER_SERVER_PLUGINS = JSON.stringify(PRODUCT.serverPlugins)` when non-empty, and ensures dirs.

- [ ] **Step 1:** Write the failing tests in `product.test.mjs` (`node:test`):
  - `readProduct without product.json returns UPSTREAM_PRODUCT` (deepEqual);
  - `readProduct merges product.json and expands ~/`: a `{appName:'X', env:{A:'~/a'}}` file gives `appName==='X'`, `env.A===<home>/a`, and other defaults intact;
  - `serverPlugins resolve against appPath`;
  - `null links and updaterFeed survive the merge`;
  - `applyProductEnv overrides a preset OPENCODE_CONFIG_DIR`: env `{OPENCODE_CONFIG_DIR:'/personal'}` becomes the product value;
  - `ensureProductDirs pre-creates projects/themes/speech-models` (temp dir).
- [ ] **Step 2:** `node --test packages/electron/product.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `product.mjs`. `PRODUCT` is the only part that imports `electron`. Keep the pure functions importable without Electron, for example via `export function` plus a lazy `PRODUCT` getter in a second tiny module `product-runtime.mjs`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `hook(product): read product.json with upstream defaults`, with a body explaining that it lets a downstream rebrand without editing literals.

### Task 3: Electron hooks read the product

**Files:**
- Modify:
  - `packages/electron/early-startup.mjs`: import the runtime product first; `DEEP_LINK_PROTOCOL` and `APP_USER_MODEL_ID` come from it. `UI_PROTOCOL` stays `openchamber-ui`.
  - `packages/electron/entry.mjs`: `app.setName(PRODUCT.appName)`, `app.setDesktopName(PRODUCT.linuxDesktopName)`, and the dev userData name `${PRODUCT.appName} Dev`.
  - `packages/electron/main.mjs`:
    - `DEFAULT_DESKTOP_PORT = PRODUCT.desktopPort`;
    - the three link constants from `PRODUCT.links`, with the menu items omitted when `null`;
    - the `'OpenChamber'` fallback labels at ~1217 and ~1815 become `PRODUCT.appName`.
  - `packages/electron/updater-feed.mjs`: `PRODUCTION_UPDATER_FEED` from the product. When it is `null`, the updater capability reports unavailable. Find the capability check in `updater-capability.mjs` and gate it there, so it is one place.
- Test: extend `packages/electron/product.test.mjs` and the existing `updater-capability.test.mjs` / `updater-feed.test.mjs`.

- [ ] **Step 1:** Write the failing tests:
  - `updater is unavailable when product.updaterFeed is null`;
  - `app name comes from product`: entry's name resolver returns `'MittrCraft Dev'` for a product with that `appName`. Expose a pure `resolveAppNames(product, { isDev })` from `product.mjs`, and have `entry.mjs` call it.
- [ ] **Step 2:** Run `bun run --cwd packages/electron test`. Expected: the new tests FAIL and the existing ones pass.
- [ ] **Step 3:** Implement the hooks. Every literal is replaced by a product read, with the same default.
- [ ] **Step 4:** Run `bun run --cwd packages/electron test` and `bun run --cwd packages/electron type-check`. Expected: PASS, and the baseline is unchanged.
- [ ] **Step 5:** Commit `hook(electron): take name, scheme, port, links and update feed from the product`.

### Task 4: Server hooks — policy path, data-dir path, server plugins

**Files:**
- Create: `packages/web/server/lib/server-plugins.js`, `packages/web/server/lib/server-plugins.test.js`
- Modify:
  - `packages/web/server/lib/enterprise-mode.js` (~84–91): when `OPENCHAMBER_POLICY_FILE` is set, it is the only candidate path.
  - `packages/web/server/lib/fs/routes.js` (~786): the hard-coded `~/.config/openchamber` becomes the resolved data dir (`OPENCHAMBER_DATA_DIR`, else the same default).
  - `packages/web/server/index.js`:
    - load plugins once, before the managed OpenCode starts;
    - change `getManagedOpenCodeEnv` (~1463) to merge `{...managedConfigEnv, ...await plugins.engineEnv()}`;
    - mount plugin routers after CORS/auth and before the OpenCode proxy.

**Interfaces:**
- Produces:
  - `loadServerPlugins({ specifiers: string[], context: { app, dataDir, logger } }) -> Promise<{ engineEnv(): Promise<Record<string,string>> }>`.
  - Each specifier is an absolute file path to an ESM module whose default export is `async (context) => ({ engineEnv?: () => Record<string,string> | Promise<Record<string,string>> })`.
  - Plugins load in order; their `engineEnv` results merge in order, later winning.
  - A rejecting setup rejects `loadServerPlugins`.
  - `index.js` reads specifiers from `OPENCHAMBER_SERVER_PLUGINS` (a JSON array). Unset means no plugins and no behaviour change.

- [ ] **Step 1:** Write the failing tests:
  - `loads plugins in order and merges engineEnv, later wins` (two fixture modules in a temp dir);
  - `server start fails when a plugin setup rejects`: `loadServerPlugins` rejects with the plugin's error;
  - `no OPENCHAMBER_SERVER_PLUGINS means no plugins`;
  - `policy path follows OPENCHAMBER_POLICY_FILE` (in `enterprise-mode` tests);
  - `fs routes use OPENCHAMBER_DATA_DIR` (in the nearest existing `fs/routes` test).
- [ ] **Step 2:** Run `bun run --cwd packages/web test`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
  - If a plugin load fails, `index.js` lets the startup error surface through upstream's existing startup-failure path. Do not swallow it.
- [ ] **Step 4:** Run `bun run --cwd packages/web test` and `bun run type-check`. Expected: PASS, and the baseline is unchanged.
- [ ] **Step 5:** Commit as three commits:
  - `hook(server): load in-process server plugins and their engine env`
  - `hook(enterprise): allow the policy file path to be set`
  - `hook(fs): use the data dir instead of a fixed path`

### Task 5: Prove what OpenCode 2.0.23 does with 1.x session data (spike)

**Files:**
- Create: `scripts/mittr/prove-session-carryover.mjs`, `docs/plans/2026-10-16-phase-1-session-proof.md` (findings)

The design (§7) needs facts before Task 6 can be built. Today's engine data dirs hold `opencode.db`, `opencode-.db` and `opencode-mittr-desktop.db` (with `-wal`/`-shm`). Which one 1.18.18 writes, and which one 2.0.23 opens and migrates, is unknown.

- [ ] **Step 1:** Write the script. It takes `--source <engine data dir>`.
  1. Copy the source (all `opencode*.db*`) into a temp `HOME`.
  2. Count sessions per DB file with `bun:sqlite` (`select count(*) from session`). If 2.x adds `session_v2`, count that table too.
  3. Start the OpenCode 2.0.23 binary that `prepare:opencode-cli` stages, with `XDG_*` pointing into the temp copy (Global Constraints layout) and a random port and password.
  4. Wait for health, then list sessions through the 2.x API, paging the cursor to the end, with `x-opencode-directory` set.
  5. Print before/after counts per file, and which file the engine opened (check the file's mtime and the engine log).
- [ ] **Step 2:** Run it on copies of both real layouts:
  - Dev: `~/.config/mittrcraft-dev/engine/opencode`;
  - prod: `~/.local/share/mittrcraft/engine/opencode`, plus one `accounts/<home>/opencode` if it exists.

  Read-only on the real dirs: copy first, always.
- [ ] **Step 3:** Write the findings note:
  - which DB file holds the live 1.x sessions;
  - whether 2.0.23 migrates it without `OPENCODE_DB`;
  - if not, whether `OPENCODE_DB=<name>` or a pre-start copy makes it migrate;
  - counts before and after for each layout.

  Expected outcome: one rule Task 6 implements. If no rule preserves every session, stop and bring the note to the owner. This is the riskiest assumption of the whole programme.
- [ ] **Step 4:** Commit `docs(mittr): record how OpenCode 2 carries 1.x sessions`, with the script.

### Task 6: `packages/mittr-server` — engine home, backup, V1 top-up hook

**Files:**
- Create:
  - `packages/mittr-server/package.json`: name `@mittrcraft/server`, private, type module, `test` script `node --test src`.
  - `packages/mittr-server/src/plugin.js`: default export, the server-plugin setup.
  - `packages/mittr-server/src/engine-home.js` and test.
  - `packages/mittr-server/src/backup.js` and test.
  - `packages/mittr-server/src/accounts.js` and test.
- Modify:
  - `packages/web/server/lib/opencode/v1-migration-topup.js`: resolve the data dir from a passed `env`: `XDG_DATA_HOME/opencode`, else the current default; the DB from `env.OPENCODE_DB`.
  - The call in `packages/web/server/lib/opencode/lifecycle.js` (~759): build the managed env before the top-up and pass `{ env: { ...process.env, ...managedOpenCodeEnv } }`.

**Interfaces:**
- Consumes: `loadServerPlugins` contract (Task 4), Task 5's rule.
- Produces:
  - `engineBases({ homeDir, env }) -> {config,data,state,cache}`: a port of 1.22 `home.js` `sharedBase()`, including the `MITTRCRAFT_ENGINE_HOME` override.
  - `engineEnv({ bases, accountHome: string|null, rule }) -> Record<string,string>`: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, with data and state under `accounts/<home>` when set, plus `OPENCODE_DB` if Task 5's rule needs it.
  - `activeAccountHome(dataDir) -> string|null`: reads `mittr-accounts/index.json` in the format of `lib/mittr/account-store.js` on branch `feat/multi-account`. It returns `null` on missing or corrupt files, and on an active account whose `home` is `null`.
  - `backupOnce({ dirs: string[], marker: string }) -> Promise<{ made: boolean, where: string[] }>`:
    - copies each existing dir to `<dir>.pre-2x-backup` when `marker` is absent, then writes the marker;
    - rejects if any copy fails, leaving no marker.
  - `migrateSettingsOnce({ dataDir, flavor: 'prod'|'dev', upstreamKeys: ReadonlySet<string> }) -> Promise<{ renamed: string[], moved: string[] }>`, run once and marked in the data dir. It acts on `<dataDir>/settings.json`:
    - a key whose name contains `mittrcraft`/`MittrCraft` and whose rename-reversed name is in `upstreamKeys` is renamed to that name;
    - any other key upstream does not know moves under `mittr`;
    - for `dev`, a saved `desktopLocalPort` of `57123` becomes `57133`. This takes effect from the next launch, because Electron reads the port before the server starts.

    Build `upstreamKeys` from upstream's settings schema or defaults module (find it from `main.mjs` ~1503 and `readSettings`).
  - `plugin.js` setup:
    - `await backupOnce` over the engine data/state/config bases and the data dir (marker in the data dir), then `migrateSettingsOnce`;
    - returns `{ engineEnv: () => engineEnv(...) }`;
    - applies Task 5's pre-start copy here if that is the rule.

- [ ] **Step 1:** Write the failing tests:
  - `engineBases matches 1.22 home.js for prod` and `…for MITTRCRAFT_ENGINE_HOME`: exact paths from the Global Constraints table;
  - `engineEnv puts data and state under accounts/<home>`;
  - `activeAccountHome falls back on corrupt index`, plus the cases for a missing file and `home:null`;
  - `backupOnce copies once then skips`;
  - `setup rejects when backup copy fails` (a read-only target dir);
  - `migrateSettingsOnce renames known keys, parks unknown ones under mittr, resets dev port 57123, and runs once`;
  - `engine env wins over a shell XDG_DATA_HOME`: simulate upstream's merge order `{...shell, ...process.env, ...engineEnv}`;
  - in `v1-migration-topup.test.js`, `topUp resolves the data dir from the engine env`: with `env.XDG_DATA_HOME=/tmp/x`, it only ever touches `/tmp/x/opencode`, asserted with an injected fs spy.
- [ ] **Step 2:** Run `bun run --cwd packages/mittr-server test` and `bun run --cwd packages/web test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run both suites. Expected: PASS.
- [ ] **Step 5:** Commit as two commits:
  - `feat(mittr-server): keep the engine in the existing MittrCraft home and back it up once`
  - `hook(opencode): let the V1 top-up follow the engine's data dir`

### Task 7: UI plugin registry, i18n overlay, logo — and `packages/mittr-ui`

**Files:**
- Create:
  - `packages/ui/src/lib/product-plugins.ts` and `product-plugins.test.ts`;
  - `packages/mittr-ui/package.json` (`@mittrcraft/ui-plugin`, private);
  - `packages/mittr-ui/src/product-ui-plugin.tsx`;
  - `packages/mittr-ui/src/strings/en.ts`;
  - `packages/mittr-ui/src/MittrCraftLogo.tsx`, from today's develop logo/icon assets.
- Modify:
  - `packages/ui/src/main.tsx` and `packages/ui/src/apps/renderElectronMiniChatApp.tsx`: one line each, `import.meta.glob('../../*/src/product-ui-plugin.{ts,tsx}', { eager: true })` (adjust the relative depth per file). Add the Vite `server.fs.allow` only if the build needs it, and say so in the hook body.
  - `packages/ui/src/lib/i18n/store.ts`: every dictionary read goes through `overlayDictionary(locale, dict)`. That covers the eager English seed, `loadDictionary`, the `formatMessage` fallback to `enDict`, and the initial `dictionary: enDict`. Registering a plugin clears the cache.
  - `packages/ui/src/components/ui/OpenChamberLogo.tsx`: render `getProductLogo()` when it is set.

**Interfaces:**
- Produces, in `product-plugins.ts`:
  - `type ProductUiPlugin = { id: string; dictionaries?: Partial<Record<Locale, Partial<I18nDictionary>>>; substitutions?: ReadonlyArray<readonly [from: string, to: string]>; logo?: React.ComponentType<React.SVGProps<SVGSVGElement> & { className?: string }> }`
  - `registerProductUiPlugin(plugin) -> void`
  - `overlayDictionary(locale, dict) -> I18nDictionary`: the plugin entries for that locale win. For keys not overlaid, every substitution is applied to the value (whole-word, case-sensitive).
  - `getProductLogo() -> ProductUiPlugin['logo'] | undefined`
- `mittr-ui` registers:
  - `id:'mittrcraft'`;
  - `substitutions: [['OpenChamber','MittrCraft'],['OpenCode','MittrCraft']]`;
  - an `en` dictionary for any value where plain substitution reads wrong;
  - the logo.

- [ ] **Step 1:** Write the failing vitest tests in `product-plugins.test.ts`:
  - `overlay wins over upstream value`;
  - `substitution rewrites a value not overlaid`;
  - `English seen before registration is overlaid after registration` (formatMessage with a key, then register, then formatMessage again);
  - `formatMessage fallback to English is overlaid`;
  - `no plugins leaves dictionaries identical`.
- [ ] **Step 2:** Run `bun run --cwd packages/ui test -- product-plugins`. Expected: FAIL.
- [ ] **Step 3:** Implement the registry and the hooks. Then create `packages/mittr-ui`.
- [ ] **Step 4:** Run `bun run --cwd packages/ui test`, `bun run type-check` and `bun run lint`. Expected: PASS and the baseline unchanged. `bun run dead-code`: inspect the report.
- [ ] **Step 5:** Commit as two commits:
  - `hook(ui): product UI plugins for strings and logo`
  - `feat(mittr-ui): MittrCraft name and logo`

### Task 8: Brand files and the build script

**Files:**
- Create:
  - `brand/product.prod.json` and `brand/product.dev.json`: values from the Global Constraints table. `env` holds `OPENCHAMBER_DATA_DIR`, `OPENCODE_CONFIG_DIR`, `OPENCHAMBER_POLICY_FILE` and `OPENCHAMBER_MANAGED_PROCESS_REGISTRY` (`<data dir>/managed-opencode`); dev also has `MITTRCRAFT_ENGINE_HOME`. Also `ensureDirs` (`<data dir>/{projects,themes,speech-models}`), `serverPlugins: ["product-plugins/mittr-server.mjs"]`, `updaterFeed: null`, and `links` all `null`.
  - `brand/electron-builder.prod.json` and `brand/electron-builder.dev.json`: appId, productName, mac/win icon paths under `brand/icons/`, `extraMetadata.version: "2.1.1+mittr.1"`, `publish: null`, `files` adding `.product/product.json` → `product.json` and `product-plugins/**`.
  - `brand/icons/`: copy today's `packages/electron/resources/icons/*` and the macOS icon files from `develop`.
  - `brand/visible-strings.json`: `[{ "file": "<glob in built output>", "from": "<exact>", "to": "<exact>" }]`. Starts empty; filled in Task 9.
  - `scripts/mittr/build-desktop.mjs`.

**Interfaces:**
- Produces the CLI `node scripts/mittr/build-desktop.mjs --flavor dev|prod`. In order, it:
  1. `bun run build` at the root (the UI picks up `mittr-ui` through the glob);
  2. bundles `packages/mittr-server/src/plugin.js` with `Bun.build` (target node, ESM, external `electron` and `@openchamber/web*`) to `packages/electron/product-plugins/mittr-server.mjs`;
  3. writes `brand/product.<flavor>.json` to `packages/electron/.product/product.json`;
  4. in `packages/electron`, runs `build:web-assets`, `prepare:opencode-cli`, `bundle:main` and `rebuild:native`, one by one rather than through `package`, so step 5 can sit before packing;
  5. applies `brand/visible-strings.json` to the built web assets and `dist-bundle/`, and fails if any entry matches zero times;
  6. runs `node scripts/package.mjs --config ../../brand/electron-builder.<flavor>.json`;
  7. prints the dmg path.

- [ ] **Step 1:** Write the script and the brand files.
- [ ] **Step 2:** `node scripts/mittr/build-desktop.mjs --flavor dev`. Expected: `packages/electron/dist/MittrCraft Dev-2.1.1+mittr.1-mac-arm64.dmg`, or electron-builder's normalised name for that version.
- [ ] **Step 3:** Verify identity:
  - `Info.plist` has `CFBundleIdentifier=dev.mittrcraft.desktop.dev`, a `CFBundleName` of MittrCraft Dev, and the `mittrcraft-dev` URL scheme;
  - `LC_ALL=C grep -a` in `app.asar` finds `product.json` with port 57133 and `product-plugins/mittr-server.mjs`.
- [ ] **Step 4:** Commit `feat(brand): MittrCraft product files and desktop build script`.

### Task 9: Brand-leak scan and first triage

**Files:**
- Create: `scripts/mittr/brand-leak-scan.mjs`, `brand/leak-allowlist.json`
- Modify: `brand/visible-strings.json`, `packages/mittr-ui/src/strings/en.ts`

**Interfaces:**
- `node scripts/mittr/brand-leak-scan.mjs <path to .app>`:
  - extracts `app.asar` to a temp dir with the `@electron/asar` already in `node_modules` (no new dependency);
  - scans `Info.plist`, the web assets and `dist-bundle/*.mjs` for `OpenChamber`, `OpenCode` and `openchamber://` inside string literals;
  - prints `file:line: snippet`, minus entries in `brand/leak-allowlist.json` (`{ file, snippet, reason }`);
  - exits 1 if anything is left.

- [ ] **Step 1:** Write the scan. Run it on the Task 8 build. Expected: a list of hits.
- [ ] **Step 2:** Triage every hit into one of three:
  - (a) a translation key: add it to `strings/en.ts` or rely on substitution;
  - (b) a hard-coded visible string: add an exact entry to `visible-strings.json`;
  - (c) not visible to a person (internal id, log text): add it to the allowlist with a reason.

  Provider names a person could see (e.g. "OpenCode Zen") go to (a) or (b) unless the phase-2 provider lock hides them; note those as `phase-2` in the reason.
- [ ] **Step 3:** Rebuild Dev and re-run the scan. Expected: exit 0.
- [ ] **Step 4:** Commit `feat(brand): scan the built app for upstream names`.

### Task 10: Upstream-touch check, update script, contract tests skeleton

**Files:**
- Create:
  - `scripts/mittr/check-upstream-touch.mjs`;
  - `scripts/mittr/upstream-update.mjs`;
  - `packages/mittr-server/src/upstream-contract.js` and `upstream-contract.test.js`.

**Interfaces:**
- `check-upstream-touch.mjs`:
  - diffs `HEAD` against `brand/UPSTREAM`, excluding our owned paths (Global Constraints);
  - lists upstream files touched and fails if there are more than 24;
  - fails if a commit since the base touches an upstream file without a `hook(` subject;
  - writes `patches/upstream/<path with / → __>.patch` per touched file.
- `upstream-update.mjs <upstream-commit>`: the steps of spec §8. It stops at the first failure with a clear next action. It never pushes and never touches `develop` itself; it works on `upstream-update/<short-sha>`.
- `upstream-contract.js` exports the list of upstream modules and symbols we rely on in phase 1:
  - `getManagedOpenCodeEnv` wiring;
  - `OPENCHAMBER_SERVER_PLUGINS`, `OPENCHAMBER_POLICY_FILE`, `OPENCHAMBER_MANAGED_PROCESS_REGISTRY`;
  - `product.json` keys read by Electron;
  - `overlayDictionary`, the `import.meta.glob` hook line.

  The test asserts each one is still present and behaves as recorded. Later phases append to it.

- [ ] **Step 1:** Write the failing `upstream-contract.test.js`, one case per contract item.
- [ ] **Step 2:** Run it. Expected: FAIL until the contract module exists.
- [ ] **Step 3:** Implement the three scripts and the contract.
- [ ] **Step 4:** Run `node scripts/mittr/check-upstream-touch.mjs`. Expected: ≤ 24 files, every touching commit is a `hook(`, and patches are written. Then run `bun run --cwd packages/mittr-server test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr): upstream touch check, update script and contract tests`.

### Task 11: Phase 1 gate — walk the Dev build on real data

**Files:**
- Create: `docs/plans/2026-10-16-phase-1-gate.md` (results)

- [ ] **Step 1:** Prepare data:
  - copy the real `~/.config/mittrcraft-dev` (including `engine/`) into a temp `HOME`;
  - record the session counts from Task 5's script;
  - copy the prod layout the same way for a second run.
- [ ] **Step 2:** Launch the Task 9 Dev build with `HOME` pointing at the copy (`open -n --env HOME=… "MittrCraft Dev.app"`, or `/path/MacOS/MittrCraft\ Dev` with env). Check, and record the result of each:
  - **Data:**
    - the session count in the sidebar or API equals the before-count;
    - three old sessions open with their messages;
    - `<dir>.pre-2x-backup` exists;
    - nothing under the temp `HOME`'s `.config/openchamber`, `.local/share/opencode` or `Library/Application Support/OpenChamber` was created.
  - **Branding:**
    - window title, About, menus and the Dock name say MittrCraft Dev;
    - the logo is ours;
    - the brand-leak scan exits 0.
  - **Port:** the app listens on 57133, from the second launch if the copied settings held 57123.
  - **Settings:** after the first launch, `settings.json` carries upstream key names, and Mittr-only keys sit under `mittr`.
  - **Side-by-side:** the installed prod MittrCraft 1.22 still opens with its data untouched.
- [ ] **Step 3:** Repeat the data checks with the prod-layout copy, using a prod flavor build.
- [ ] **Step 4:** Commit the gate note. Report to the owner with the Dev dmg path. **Do not push.**

---

## What comes after this plan (separate plans, written when phase 1 is done)

- **Phase 2: sign-in and models.** Mittr sign-in and multi-account in mittr-server and mittr-ui:
  - the deep-link handler registry hook in `main.mjs`;
  - the root-wrapper slot;
  - catalog → OpenCode 2 provider and credential API;
  - OpenCode policy lock;
  - quota registries and slots;
  - AD/Entra providers (hooks 17–18);
  - port the audit routes.
- **Phase 3: work and skills.** My work as a built-in extension (several Plane workspaces), integrations settings, catalog skills and MCP in the v2 shape.
- **Phase 4: voice and tools.** Dictation and read aloud through the shim, Talk mode on the 2.x event stream, Chrome and computer-use tools as an OpenCode plugin, the never-auto-accept hook.
- **Phase 5: goal, extras, release.**
  - Measure upstream's goal loop with the 4-goal set.
  - Port the UX extras: sidebar side, list continuation, activity timeline.
  - Branded VS Code and mobile packaging.
  - `.mittr` → `.opencode` copy notice.
  - Full walk, then `develop` adopts the branch.
  - Hand the dmg to the team with release notes.
- **Independent, can start now:** backport 2.1.1's security fixes to 1.22 for the team (spec §9).
