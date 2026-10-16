# MittrCraft on Current Upstream, Kept Cheap to Update — Design

Date: 2026-10-16
Status: approved direction; owner decisions recorded 2026-10-16 (§10)
Repos: `mittr-craft` (this repo); `ai-agent-platform` only if a platform change turns out to be needed (none is planned)

## 1. Intent

MittrCraft is a downstream of OpenChamber. It forked at upstream 1.18.4 on 2026-08-15 and is now 1,918 upstream commits behind 2.1.1. Upstream 2.1.1 contains fixes from a private security report, runs on OpenCode 2, and adds enterprise mode, extensions, message search, permission modes, multi-run and large performance work. Today none of that can be taken in, because a merge is unmanageable.

The owner wants a way to follow upstream that may be expensive once, but makes every later update cheap. The owner approved this direction on 2026-10-16:

- Re-base MittrCraft on a current upstream release.
- Keep upstream's internal identifiers. Brand only what a person sees.
- Move Mittr behaviour into our own packages that plug into upstream through upstream's own extension points, plus a short list of small, generic hooks.

## 2. Why the current shape cannot be updated (measured)

Measured on a throwaway clone. The real repo was not touched.

| Merge of upstream 2.1.1 with… | Conflicted files | Conflict hunks |
|---|---|---|
| `develop` as it is | 468 | 1,301 |
| `develop` with the OpenChamber→MittrCraft rename reversed | 177 | 606 |
| …and with our edits to locale files removed | 154 | 327 |

- 919 of the 1,256 upstream files we modified differ only by the rename. 211 upstream code files carry real edits, and we added 248 files.
- Upstream moves about 219 commits and 2.75 releases per week. 200 of the 211 files we hand-edit were touched upstream since the fork. The locale files were touched about 190 times each.
- A simulation of weekly syncing, with the current shape, needed 449 file resolutions over 8 weeks, against 177 for one jump. **Updating more often does not help while we edit hot upstream files.** Only shrinking the surface we touch does.

Other downstreams that survive a fast upstream all keep the delta small, explicit and re-applicable: VSCodium (build-time branding plus about 40 patches), Electron (a patch list with a stated reason per patch), Brave (override files plus patches).

## 3. Goals, non-goals, anti-goals

**Goals**

1. MittrCraft runs on upstream 2.1.1 (or the newest release tag when work starts), including its security fixes and OpenCode 2.
2. Every feature a MittrCraft user has today keeps working (see §6). The owner chose to drop nothing (§10).
3. After this, moving to a new upstream release is a routine of hours, not weeks. The target is **≤ 24 upstream files patched and ≤ ~600 patched lines**, each patch with a written reason, plus one build-time text replacement step for hard-coded brand strings (§5.2).
4. A person updating from MittrCraft 1.21/1.22 keeps their Mittr sign-in(s), session history, settings, skills and integrations.

**Non-goals**

- Tracking upstream `main`, or taking every release. We take release tags: monthly, and immediately for security releases.
- New Mittr features in this round. Behaviour stays as it is, apart from things upstream now provides better.
- CI/CD. MittrCraft is still built locally and handed to the team (see §9).

**Anti-goals: this round fails even if it technically works when…**

- A teammate who updates loses session history, sign-in, or their Jira/Plane setup.
- "OpenChamber" or "OpenCode" shows anywhere a user can see it: window title, menus, dialogs, About, tray, Dock, notifications, or the model's answer to "who are you". The only exception is the open-source licences screen, which must credit upstream (MIT).
- Company code or config ends up inside upstream's files in a way that makes the next update conflict again (logic inside `server/index.js`, `MainLayout.tsx`, locale files…).
- Data or prompts reach a provider other than Mittr, or the team build talks to anything other than the prod platform (`api.mittr.asia`).
- The new build silently replaces, or collides with, a real OpenChamber install on the same machine.

## 4. Constraints

- Package manager **bun**, at the version the upstream tag declares (2.1.1 declares `bun@1.4.2`; today's develop uses 1.3.14). Node ≥ 22. Respect `.nvmrc` if present.
- Builds are ad-hoc signed today (the installed app shows `Signature=adhoc`, no team id), and this design keeps that. Keychain and `safeStorage` behave across this update exactly as across every past MittrCraft update.
- Branches: product work goes to `develop` in `techflowasia/mittr-craft`. `main` there mirrors upstream and is never touched. Push and PRs need the owner's go-ahead each time.
- The prod build talks to the prod platform. Any feature that needs a new platform route only works once that route is on platform prod. This design needs **no platform change**. If a builder finds one is needed, it goes dev → prod through the platform's own git flow first.
- The "MittrCraft Dev" flavor must keep installing beside prod, with its own app id, scheme, data and port. All local testing happens on Dev, never by replacing the prod app.
- Upstream extensions run in a sandboxed iframe. They get no microphone, no loopback access and at most 8 approved https origins, and they run on web and desktop only.

## 5. Architecture

```
┌───────────────────────── MittrCraft build ─────────────────────────┐
│ brand/            product.json per flavor, builder config, icons│
│ packages/mittr-server      in-process server plugin (routes, auth, │
│                            catalog sync, quota, speech, voice)     │
│ packages/mittr-ui          UI plugin: root wrapper + slot fills    │
│ packages/mittr-extensions  built-in SDK extensions (My work, tools │
│                            settings)                               │
│ packages/mittr-opencode    OpenCode 2 plugin/config (identity,     │
│                            tools) + MCP/skills written as config   │
│ patches/upstream/*.patch   ≤24 generic hooks, one reason each      │
├────────────────────────────────────────────────────────────────────┤
│ upstream OpenChamber at a release tag — internal names unchanged   │
│ (packages/ui, web, electron, sdk, extensions …)                    │
└────────────────────────────────────────────────────────────────────┘
```

### 5.1 Repository layout and history

- The new base is a branch from upstream's 2.1.1 release commit (`e302062e3`, "release v2.1.1"). Our packages, `brand/` and the hook edits are ordinary commits on it. Our packages are new directories, so they never conflict.
- At release (phase 5), `develop` adopts it once with a merge whose tree is the new branch's (`git merge -s ours --no-commit <new>; git read-tree -m -u <new>; git commit`). Old history stays reachable and nothing is force-pushed.
- **Later updates are plain merges** of the next upstream release commit into a branch off `develop`, with `rerere` on. *(Designer's call.)*
  - The measured pain came from how much of upstream we touched, not from merging. With ≤ 24 small hooks, a merge is the simplest flow for a one-person team, and it keeps ordinary PRs.
  - `brand/UPSTREAM` records the upstream commit we are on.
  - Every commit that edits an upstream file has a `hook(<name>):` subject and a body saying why.
  - `scripts/mittr/check-upstream-touch.mjs` lists every upstream file that differs from `brand/UPSTREAM`, fails above 24, and writes `patches/upstream/<file>.patch` as a readable record (not applied by anything).

### 5.2 Branding at build time only

- **Product file, VSCodium-style.** *(Designer's call; it replaces an earlier idea of a separate entry module, which would have fought upstream's bundled `dist-bundle/entry.mjs`.)*
  - Each flavor has `brand/product.<flavor>.json`. The build packs it into the app as `product.json` next to `package.json`.
  - A new generic upstream-side module, `packages/electron/product.mjs`, reads it with upstream's values as defaults. It is imported first by `early-startup.mjs`.
  - It applies the file's `env` map to `process.env` (only keys not already set by the person) and pre-creates the listed directories before any other upstream module loads.
  - The `env` map carries:
    - `OPENCHAMBER_DATA_DIR`: the **existing** MittrCraft data dir, `~/.config/mittrcraft` or `~/.config/mittrcraft-dev`. No data-dir move is needed.
    - `OPENCODE_CONFIG_DIR`: the existing engine config dir. It is read at module load in `lib/opencode/shared.js`, so it must be set this early.
    - the policy-file path and the managed-process-registry path override.
  - The pre-created directories are `projects/`, `themes/` and `speech-models/` in the data dir. Upstream's `data-dir-migration.js` copies those from `~/.config/openchamber` only when they are missing, so this keeps it from importing a real OpenChamber install.
  - `serverPlugins`: built plugin bundles (paths inside the app), loaded by hook 1.
- **Electron packaging:** `packages/electron/scripts/package.mjs` passes its arguments straight to electron-builder (`process.argv.slice(2)`, verified). `brand/electron-builder.<flavor>.json` sets:
  - `appId` (`dev.mittrcraft.desktop` / `dev.mittrcraft.desktop.dev`), `productName` (`MittrCraft` / `MittrCraft Dev`), icons and mac/win metadata;
  - `extraMetadata.version`;
  - `publish` off. Releases stay as today: build locally and hand the dmg to the team (decision A). No in-app update feed is published.
  - `files` entries that add `product.json` and the built plugin bundles.

  Upstream's `bundle-main.mjs` is untouched.
- **Product constants that upstream hard-codes**, and so need a hook (§5.6), all read from `product.mjs`:
  - `app.setName('OpenChamber')` in `entry.mjs`, which also decides the userData folder, so it must become `MittrCraft` to keep today's folder;
  - the deep-link scheme and app user model id (`early-startup.mjs`);
  - the default desktop port, bug/ideas/Discord links and fallback labels (`main.mjs`);
  - the updater feed (`updater-feed.mjs`);
  - the policy-file path (`enterprise-mode.js`, through an env override).
  - MittrCraft prod: scheme `mittrcraft`. Dev: scheme `mittrcraft-dev`, default port 57133 (already the Dev default in `app-flavor.mjs`).
  - When Dev was seen on 57123, the cause was a saved `desktopLocalPort` setting, not the default. The data migration (§7) resets a Dev install's saved port when it equals the prod port.
- **UI protocol: keep upstream's `openchamber-ui`.** *(Designer's call.)*
  - It is hard-coded in at least 7 upstream files (`early-startup.mjs`, `preload.mjs`, `server/index.js`, `security/request-security.js`, `ui/lib/url.ts`, `openCodeStatus.ts`, `desktopCurrentHost.ts`), so renaming it would cost 4+ more patches on every update.
  - It never shows to a user. Renderer storage lives under each app's own user-data folder, so it does not clash with a real OpenChamber install.
  - The cost is a one-time reset of renderer `localStorage`, which holds only UI preferences and unsent drafts (§7). Sign-in, history and Jira/Plane setup do not live there.
- **Visible strings in the translation system:** one overlay hook in `packages/ui/src/lib/i18n/store.ts`. It must cover all three paths:
  - `loadDictionary` for non-default locales;
  - the English dictionary that is put into the cache and initial state directly;
  - the `formatMessage` fallback to `enDict`.

  It merges `brand/strings/<locale>` over upstream's dictionary and substitutes "OpenChamber"/"OpenCode" in values our overlay does not cover. Upstream locale files are never edited again.
- **Visible strings outside the translation system** are handled at build time, not by source patches. Today these are `Header.tsx`, `MiniChatLayout.tsx`, `AboutSettings.tsx`, `AboutDialog.tsx` and Electron dialogs in `main.mjs`:
  - (a) Upstream's logo component renders our logo through hook 24.
  - (b) A replacement step on the **built** bundles rewrites a reviewed list of exact visible strings (VSCodium-style). Each entry is the exact string and its replacement. An entry that no longer matches fails the build, so upstream changes are noticed.
- **Version:** the app version stays **upstream's version with build metadata**, e.g. `2.1.1+mittr.1`. Upstream checks extension compatibility with semver ranges, and build metadata is ignored in comparisons. About shows "MittrCraft 2.1.1+mittr.1". *(Designer's call.)*
- **Licence:** the open-source licences screen keeps upstream's `LICENSE` and credits "based on OpenChamber" (MIT obligation). This is the only place the upstream name appears.
- **Brand-leak scan:** a script greps the built UI bundle, `app.asar` strings, `Info.plist` and the window titles of a launched Dev build for `OpenChamber|OpenCode|openchamber://`. It fails the build except for a reviewed allowlist (licence text, internal identifiers never shown).

### 5.3 Upstream mechanisms we use instead of patching

| Need | Upstream mechanism (2.1.1) |
|---|---|
| App data dir, engine config dir | `OPENCHAMBER_DATA_DIR`, `OPENCODE_CONFIG_DIR` |
| Engine data per account | The `XDG_*` variables on the engine process only, never on the whole app, exactly as 1.22's `lib/opencode/home.js` lays them out (§7). Upstream builds the engine env as `{...shellEnv, ...process.env, ...await getManagedOpenCodeEnv()}` (`lifecycle.js` ~768). Hook 1 lets a server plugin contribute to `getManagedOpenCodeEnv` (`server/index.js` ~1463). Switching accounts uses upstream's restart. |
| Lock to Mittr models | Enterprise mode stays **off** (decision B). mittr-server writes OpenCode 2 policies into the managed config (`provider.use`: deny all, allow `mittr`). Defaults turn relay, tunnels and upstream's classifier off. A user can still turn those extras on; that is accepted. |
| Mittr models as a provider | OpenCode 2 config `providers.mittr` (OpenAI-compatible, `baseURL` = our loopback shim), hot-reloaded from upstream's managed config file. Credentials go through OpenCode 2's credential API (there is no `auth.json` in 2.x). |
| Skills and MCP from the Mittr catalog | files under `$OPENCODE_CONFIG_DIR/skills`, and MCP entries in the v2 config shape |
| Engine pinning, no self-update | bundled CLI (`OPENCODE_BINARY`) |
| My work (Jira/Plane), tool settings | Built-in extensions. `scripts/build-builtin-extensions.mjs` exports `buildBuiltInExtensions({ sourceRoot })` as a function option, so a small script of ours calls it with our registry. Built-ins are auto-approved. **With enterprise mode on, bundled extensions lose the `network` capability** (`guests/enterprise.js` ~61–68), so My work could not reach the Mittr API. Enterprise mode stays off (decision B), so this does not apply. |
| Speech (dictation / read aloud) | upstream's OpenAI-compatible STT/TTS, pointed at the loopback shim's `/v1/audio/*` |
| Quota cards | upstream's quota provider registries (server + UI). They need a registration hook (§5.6). |
| Themes | theme JSON in the data dir's `themes/`; default seeded in settings |

### 5.4 Our packages

- **`packages/mittr-server`** is loaded in-process through the server-plugin hook. It owns:
  - Mittr sign-in: start, callback, refresh, multi-account store, sign-out;
  - the session store (Electron `safeStorage`, available because the backend runs in-process);
  - the loopback OpenAI-compatible shim, including quota refusal handling and the "answered by a backup model" markup;
  - catalog sync → providers, skills, MCP;
  - the quota provider;
  - My work and integration proxy routes;
  - voice-assistant routes;
  - the agent tool backends.

  It talks to upstream only through the context the hook hands it, plus documented upstream modules listed in a single `upstream-contract.js` (§8). It never deep-imports other upstream internals.
- **`packages/mittr-ui`** mounts through the root-wrapper hook. It owns:
  - the sign-in gate and account menu;
  - the quota marks under answers and in the model picker (through slots);
  - the Talk button and voice bar (composer-action slot, plus a portal from the root wrapper);
  - Mittr settings pages, through upstream's settings registration if one exists, otherwise a slot.
- **`packages/mittr-extensions`** holds built-in SDK extensions. My work becomes a `page` + `attach` + `commands` extension whose `integration.apiOrigin` is the Mittr API. The server plugin keeps the extension's credential fresh from the active Mittr account.
- **`packages/mittr-opencode`** holds the OpenCode 2 plugin: identity (the model answers as MittrCraft) and Mittr agent tools (Chrome / computer use) with OpenCode's permission prompt and `codemode:false`. It also generates the MCP/skills config.

### 5.5 Sign-in callback

Keep today's deep-link flow (`mittrcraft://auth/callback`), because the platform allowlist (`DESKTOP_REDIRECT_URIS`, exact match) already accepts both flavors' schemes. That needs no platform change. Upstream's `main.mjs` already handles `openchamber://connect`, so the hook adds a small deep-link handler registry that our server plugin registers `auth/*` into. *(Designer's call. A loopback redirect would remove that hook but needs a platform allowlist change on prod first.)*

### 5.6 The hook patches (target list, ≤ 24)

Each is generic: it names no Mittr concept and keeps upstream's behaviour when unused. We do **not** send hooks upstream (decision 3), so this list is ours to carry for good. That is why each must stay a few lines long.

| # | File | Hook |
|---|---|---|
| 1 | `packages/web/server/index.js` | `serverPlugins` loaded from options/env. They run after CORS/auth and before the OpenCode proxy, with a context object (express app, data dir, settings read/persist, event hub, control service, OpenCode URL and auth headers, refresh). |
| 2 | `packages/web/server/lib/quota/providers/index.js` | `registerQuotaProvider` |
| 3 | `packages/ui/src/lib/quota/providers/index.ts` | `registerQuotaProvider` (UI) |
| 4 | `packages/web/server/lib/permission-auto-accept/runtime.js` | a "never auto-accept these tools" list |
| 5 | `packages/electron/early-startup.mjs` | deep-link scheme and app user model id from product config (UI protocol stays upstream's) |
| 6 | `packages/electron/main.mjs` | default port, links and names from product config; deep-link handler registry |
| 7 | `packages/electron/updater-feed.mjs` | updater owner/repo from product config (per decision A) |
| 8 | `packages/web/server/lib/enterprise-mode.js` | policy-file path from product config, so our build never reads a real OpenChamber's `policy.json` |
| 9 | `packages/ui/src/main.tsx` | load UI plugins; root-wrapper slot |
| 10 | `packages/ui/src/apps/renderElectronMiniChatApp.tsx` | same root-wrapper slot |
| 11 | `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx` | composer-action slot |
| 12 | `packages/ui/src/components/chat/ChatMessage.tsx` | assistant-message footer slot |
| 13 | `packages/ui/src/components/chat/ModelControls.tsx` | model-row badge slot |
| 14 | `packages/ui/src/lib/i18n/store.ts` | dictionary overlay + substitution, covering `loadDictionary`, the initial English dictionary and the `formatMessage` fallback |
| 15 | `packages/web/server/lib/opencode/v1-migration-topup.js` + its call in `lifecycle.js` | honour the engine's real data dir (`XDG_DATA_HOME` / `OPENCODE_DB`) instead of hard-coded `~/.local/share/opencode`. Without this it would write a resume cursor into a developer's **personal** OpenCode database. |
| 16 | `packages/web/server/lib/fs/routes.js` | replace hard-coded `~/.config/openchamber` (~line 786) with the data dir. |
| 17 | `packages/web/server/lib/ui-auth/ui-auth.js` | an auth-provider registry, so mittr-server can register the AD/Entra providers we keep (decision 4) |
| 18 | `packages/ui/src/components/auth/SessionAuthGate.tsx` | a slot for extra sign-in methods (the AD/Entra buttons) |
| 19 | `packages/ui/src/components/layout/MainLayout.tsx` | a "sidebar side" layout option (left/right), read from settings (decision 4) |
| 20 | `packages/ui/src/stores/useUIStore.ts` | persisted sidebar-side setting (may fold into 19 if the setting can live in mittr-ui) |
| 21 | `packages/ui/src/components/chat/ChatInput.tsx` | a composer keydown extension point, used by our Markdown list continuation (decision 4). This is upstream's most-changed file, so the hook must be one call site. |
| 23 | `packages/electron/entry.mjs` | app name (and so the userData folder) and Linux desktop name from `product.mjs` |
| 24 | upstream's logo component (`OpenChamberLogo`) | render a registered override when one exists |
| 22 | `packages/ui/src/components/layout/ContextSidebarTab.tsx` | only if the activity timeline cannot be a built-in Work Status section extension (`contributes.statusSection`); try the extension first |

`managed-process-registry.js` also hard-codes `~/.config/openchamber`, but it has an env override, so set it through the `product.json` env map instead of patching. If a builder needs more than 24 files, stop and bring it to the owner with the reason. Do not quietly grow the list.

## 6. Feature map

| Feature (today) | Where it goes | Notes |
|---|---|---|
| Branding, Dev/prod flavors | §5.2 | Dev port bug fixed on the way |
| Mittr sign-in, multi-account (MITTRAI-21, on `build/1.22.0-team`), sign-out | mittr-server + mittr-ui | Per-account engine data via env overlay (§5.3) |
| Model catalog → providers, default model, agents/roles | mittr-server writes OpenCode 2 config | Re-prove "a quota refusal is not retried" on 2.x |
| Quota: Settings → Usage, picker marks, marks under answers, Try again | quota registries (hooks 2–3) + slots (12–13) | Drop our separate `MittrUsagePage` in favour of upstream's usage card if it can show "remaining this week" first. Otherwise keep ours as the card body. |
| Dictation, read aloud | upstream's OpenAI-compatible STT/TTS → loopback shim | Quota reasons and reset times must still reach the user (see §9 check) |
| Voice assistant / Talk mode | mittr-server routes + mittr-ui (hook 11 + root portal) | Largest port: OpenCode 2 has one global event stream, cursor paging, and `x-opencode-directory` on every read |
| Goal mode judge | **adopt upstream's goal loop**, its check pointed at a Mittr model (decision 1) | Then measure it with the same 4-goal set used to prove platform PR #204: count criteria judged with another criterion's reason, and whether a thin deliverable is sent back. If it does worse than our judge, port ours as a plugin through the server hook. Our `session-goal` edits and `mittr-goal-judge` are not ported up front. |
| My work (Jira/Plane, several Plane workspaces — MITTRAI-20, on `build/1.22.0-team`), work-tracking settings | built-in extension + mittr-server proxy | Web/desktop only, which is fine |
| Catalog skills and MCP sync | mittr-server → config files | Watch MCP process fan-out per directory on 2.x |
| Agent tools: Chrome (`chrome.do`, approvals), computer use, `plane/jira.get_issue` | mittr-opencode plugin + mittr-server backends + hook 4 | Turn off upstream's own browser tool for agents if both would be offered |
| Engine identity, `.mittr` project dir | **Drop the engine fork; use upstream's `.opencode`** (decision 2). Identity ("who are you" → MittrCraft) comes from the mittr-opencode plugin (verify the system-prompt hook in OpenCode 2.0.x). | Projects that already hold a `.mittr/` folder lose its agents/commands/skills/plans to the engine. On opening a project, mittr-ui shows a one-time notice offering to copy `.mittr/` → `.opencode/`. It never moves or deletes the user's files. `engine/` and its patch are retired, and `prepare-opencode-cli` uses upstream's OpenCode release. |
| Self-update removal | `opencodeBinary` policy + bundled CLI; app updater off via product config | |
| Audit routes (`lib/mittr/audit-*`) | **kept** (decision 4): ported into mittr-server as they are | No caller in `develop` today (verified); keep behaviour, do not wire new callers in this round |
| AD/Entra UI auth (`ui-auth`) | **kept** (decision 4): providers in mittr-server, through hooks 17–18 | Keep today's behaviour for hosted web |
| Activity timeline, sidebar on either edge, markdown list continuation | **kept** (decision 4): timeline as a Work Status extension if possible, else hook 22; sidebar side via hooks 19–20; list continuation via hook 21 | These sit in upstream's hottest files. Keep each hook to one call site. |
| VS Code extension, mobile app | **kept and branded** (decision 4). Branding at package time: a script rewrites `packages/vscode/package.json` fields (`name`, `displayName`, `publisher`, icon) and `packages/mobile/capacitor.config.ts`/assets into the build output, never the source. | Today's Mittr behaviour on these surfaces (e.g. `vscode/src/skillsCatalog.ts`, `quotaProviders.ts`) is inventoried and ported. Anything needing a source edit counts toward the hook cap. |
| Themes, design-system tweaks | theme JSON + overlay CSS from mittr-ui | Prefer no CSS patches |

## 7. Data carried over from 1.21/1.22

| Data | How it survives |
|---|---|
| App data dir | `OPENCHAMBER_DATA_DIR` points at the existing dir; nothing moves |
| Engine home and sessions | **Today the engine home is not one folder.** 1.22 (`lib/opencode/home.js`) spreads it over four XDG bases, `~/.config`, `~/.local/share`, `~/.local/state` and `~/.cache`, each under `mittrcraft/engine[/accounts/<home>]/opencode`, set as `XDG_*` on the engine process. Database files are named `opencode-*.db`. The 2.x build keeps setting the same `XDG_*` values on the engine process, so OpenCode 2 finds the same folders. OpenCode 2 runs its own one-time 1.x→2.x session migration. Upstream's `v1-migration-topup.js` only re-arms it, and it gets hook 15 so it looks in our folders. **Phase 1 must first prove** what OpenCode 2.0.x opens (it uses `opencode.db` unless `OPENCODE_DB` is set). If it does not pick up `opencode-*.db`, mittr-server sets `OPENCODE_DB` or copies the file before the first engine start. Upstream server paths derived from XDG (for example the worktree root in `git/service.js`) are checked in the same proof. |
| Per-account engine homes (`accounts/<home>`) | the same migration must run for every account home, not only the active one. mittr-server starts the engine once per account home on first launch, or migrates the inactive ones lazily on first switch (builder's call). |
| Mittr accounts (`mittr-accounts/`) | read by mittr-server unchanged |
| Engine credentials (`auth.json`) | re-written through OpenCode 2's credential API on first start |
| Mittr sign-in tokens (`safeStorage`) | unchanged; ad-hoc signing as today (§4) |
| Renderer `localStorage` | **Reset once** (the UI protocol changes to upstream's, §5.2). Lost:<ul><li>theme/sidebar/UI preferences;</li><li>chosen UI language (`mittrcraft.i18n.v1`);</li><li>unsent chat drafts;</li><li>My work view preferences (source, open groups);</li><li>the settings mirror cache, which rebuilds from the server.</li></ul>The release notes tell the team to send or copy any unsent draft before updating. mittr-ui re-applies the UI language from the server settings if one is stored there. |
| Settings file | upstream settings keys we renamed are copied once by mittr-server. Unknown Mittr keys move into a `mittr` section. A Dev install whose saved `desktopLocalPort` equals the prod port is reset to the Dev default. |

Before the first migration, the app copies the data dir and engine home to `<dir>.pre-2x-backup` once, and logs where. Restoring from it is documented in the release notes for the team.

## 8. The upstream update routine (what "cheap" means)

A script, `scripts/mittr/upstream-update.mjs <upstream-commit>`, does:

1. Fetch upstream and create `upstream-update/<short-sha>` from `develop`.
2. Merge the upstream commit with `rerere` on. On conflict it stops and lists each conflicted file with the reason of the hook that owns it, taken from that hook commit's body.
3. Update `brand/UPSTREAM`, then run `check-upstream-touch.mjs`.
4. `bun install`, then type-check, lint and tests (root `package.json` scripts).
5. Run our **upstream-contract tests**. They exercise every upstream module listed in `packages/mittr-server/src/upstream-contract.js`, plus each hook, against the new commit: provider config upsert, managed config reload, credential API, quota registry, control service, extension credential store, i18n overlay, slots render. Silent breakage from upstream internals is the main risk of this design, and these tests are the guard.
6. Build Dev, run the brand-leak scan, and print the walk checklist.

Cadence: every upstream release tag that is a security fix, at once (built and handed to the team as a dmg, as today). Otherwise roughly monthly, taking the newest tag that is at least a few days old. The routine is done when the Dev build has been walked through §9's checklist.

## 9. How we know it works

There is no CI, so "done" means a built Dev app, walked, on a machine that has 1.21/1.22 data.

Phase gates. Each phase ends with a Dev build the owner can try.

1. **Base + data:**
   - Upstream tag, product config and branding hooks build as MittrCraft Dev.
   - Opening it on a copy of real 1.22 data keeps every session (count before/after, open three old ones) and every account.
   - Brand-leak scan is clean.
2. **Sign-in + models:**
   - Mittr sign-in (two accounts, switch, sign out).
   - Catalog sync shows the same models, a chat answers through Mittr, and quota marks and Try again work.
   - A quota refusal is not retried.
   - Only Mittr models can be chosen or used (OpenCode policy).
3. **Work + skills:**
   - My work shows Jira and several Plane workspaces.
   - Catalog skills and MCP connectors install and run.
   - Integrations settings save and test.
4. **Voice + tools:**
   - Dictation and read aloud through Mittr show quota reasons.
   - Talk mode drives sessions and Chrome as today.
   - Chrome approvals still ask.
   - Computer use works.
5. **Release:**
   - Full walk of every sidebar item, Settings page and exit (per house rule).
   - The prod build points at `api.mittr.asia` (checked in `app.asar`).
   - Version `2.1.1+mittr.1`.
   - VS Code extension and mobile builds carry the MittrCraft brand and today's Mittr features.
   - The first 2.x dmg is handed out with release notes covering the backup location, the one-time UI-preference reset, unsent drafts, and the `.mittr` → `.opencode` notice.
   - Team release notes include the backup location.

Separately and first, while this runs: **backport upstream 2.1.1's security fixes into 1.21/1.22** and ship that to the team. These are the request-level server fixes, the WebSocket refusal from sandboxed pages, and HTML preview / theme code execution. That is its own small change and does not wait for this design.

## 10. Owner decisions (2026-10-16)

- **A. Distribution:** unchanged. Build locally and hand the dmg (and other builds) to the team. No in-app update feed, and 2.x is never published to the GitHub releases that 1.22's updater reads.
- **B. Enterprise mode:** off. The provider lock is OpenCode policy plus our defaults.
- **1. Goal mode:** adopt upstream's, measure it, and port ours only if upstream's is worse (§6).
- **2. Project directory:** drop `.mittr` and the engine fork; use upstream's `.opencode` with a copy offer (§6).
- **3. Upstream contributions:** none. Hooks are carried by us.
- **4. Nothing is dropped:** audit routes, AD/Entra UI auth, branded VS Code and mobile builds, the activity timeline, sidebar on either edge, and list continuation are all kept (§5.6 hooks 17–22, §6).

## 11. Left to the builder

- Exact package names and internal module layout inside `packages/mittr-*`.
- Slot API shape (a registry keyed by slot name is enough). It just has to stay generic.
- Script language and flags for §8.
- Order of work within a phase.
- Whether a feature's UI uses upstream primitives or our own. Upstream primitives are preferred, per `theme-system`.

## 12. Main risks

1. **Data migration.** One wrong step loses history. Mitigation: the backup, phase 1 proving it first, and per-account homes included.
2. **Hidden coupling to upstream internals** breaks silently. Mitigation: `upstream-contract.js` plus the contract tests on every update.
3. **Hook patches in very hot files** (`server/index.js`, `main.mjs`, `ChatMessage.tsx`). Mitigation: keep each hook a few lines and at one call site. Contract tests catch a hook that has moved.
4. **Voice-assistant port to OpenCode 2's event model** is the largest single piece. Mitigation: it is last, and the old app keeps working for the team until phase 5 ships.
5. **Brand leakage from new upstream strings** on every update. Mitigation: the leak scan fails the build.
