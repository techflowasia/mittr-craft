# MittrCraft 1.22 feature inventory for the 2.1.1 base

Date: 2026-10-17
Status: master checklist for phases 2–5 of `docs/specs/2026-10-16-upstream-rebase-design.md`
Base: branch `rebase/upstream-2.1.1` (upstream release commit `e302062e3`, phase 1 gate `docs/plans/2026-10-16-phase-1-gate.md`)

## 0. How this list was built

Sources of "the old MittrCraft":

- `origin/develop` at `be34959cb` (1.22.0). Fork point from upstream: `c6772a636` (1.18.4). `git log --no-merges c6772a636..origin/develop` has 165 commits. 256 files were added and 261 upstream files carry edits beyond the OpenChamber→MittrCraft rename (measured by reversing the rename and diffing).
- `origin/fix/engine-single-instance` (`5c4be9880`, one commit, not merged): see C-12.
- `origin/feat/brand` (9 commits by the team, branched at the fork point): it holds **mobile and DMG assets that are not in develop**: Android launcher icons and splash screens, iOS `AppIcon-512@2x.png` and `Splash.imageset`, `packages/electron/resources/dmg-background.png`, `mittr-logo*.png`. Listed in P5-11 and P5-12. Its other commits (splash icon, logo swap, version reset) were superseded by develop.
- `origin/feat/scripts` (191 commits): 183 are upstream commits that are all in 2.1.1 (checked by subject, e.g. single-project sidebar, projectless chats, record-then-transcribe dictation, JSONC config guards). The team's commits are the AD/Entra sign-in (already in develop, P2-17/P2-18), an i18n merge fix, and `scripts/sync-feature.sh` (a developer helper, not user-facing). **No user-facing feature is only there.**
- Mittr platform repo `ai-agent-platform`, `origin/main` (= prod) and `origin/develop` (= dev). Every route below was checked on both by reading the NestJS controllers.

Reading a row:

- **Sees/does**: the person's point of view.
- **1.22 code**: key files on `origin/develop` (paths as in 1.22, so `mittrcraft-control` is upstream's renamed `openchamber-control`).
- **Platform**: the Mittr route the feature calls and whether it is on platform main (prod) and develop (dev). "Local" means no platform call.
- **Upstream 2.1.1**: whether `e302062e3` already has it, and what in 2.1.1 changes the 1.22 approach.
- **Target**: where it lives on the new base (spec §5–§6). Hook numbers are spec §5.6.
- **Accept**: what a tester does on the Dev build and what must happen.
- **Phase / Size / Risk**.

Accounts and builds used by the acceptance checks:

- **Dev build**: `node scripts/mittr/build-desktop.mjs --flavor dev`, pointed at the dev platform `https://api-dev.mittr.asia`. Prod-platform checks are only the release checks in §6.
- **Account A**: dev-platform user with desktop entitlement, at least two Mittr agents granted, a weekly quota configured (Quota admin), Jira and Plane connected for that user, at least one Jira issue and one Plane work item assigned, member of two Plane workspaces, speech models pinned on the platform.
- **Account B**: a second dev-platform user in the same directory.
- **Account Q**: like A, but with a weekly model and speech quota set low enough to run out in a few calls.

Cross-cutting items are in §7, totals in §8, features upstream already covers in §9, owner questions in §10, and the file-by-file cross-check in §11.

**Hook budget warning (read first).** `check-upstream-touch` reports 20 of 24 upstream files touched after phase 1. The rows below name about 18 more upstream files that a straight port would touch (quota registries ×2, auto-accept, ComposerFooter, ChatMessage, ModelControls, ModelPickerList, ui-auth, SessionAuthGate, MainLayout, useUIStore, ChatInput, ContextSidebarTab, AboutDialog, SidebarFooter, agent-tool runtime, plus the five extra layout files the sidebar-side feature edits). Each row says which file it needs. See owner question Q1.

---

## 1. Phase 1 items (done; re-check in the phase 5 walk)

### P1-01 Branding everywhere a person looks
- **Sees/does**: the app is "MittrCraft" (or "MittrCraft Dev") in the Dock, window title, menus, About, splash, loading overlay, logo, tray glyph and app icons. No upstream community links. The model's own name is separate (P2-15).
- **1.22 code**: rename commit `01e22a942`; `packages/electron/resources/icons/*`, `tray/tray-glyph.svg`, `splash-icon.png`; `packages/ui/src/components/ui/MittrCraftLogo.tsx`, `mittrMark.ts`; `packages/web/public/*` icons; `AboutDialog.tsx`, `AboutSettings.tsx`.
- **Platform**: none.
- **Upstream 2.1.1**: no. Phase 1 added `brand/`, visible-strings replacement, i18n overlay (hook 14), logo override (hook 24), menu labels, splash hook.
- **Target**: done in phase 1 (`brand/`, `packages/mittr-ui`).
- **Accept**: gate §5 and §5a (all PASS). In the phase 5 walk also check the tray icon and a macOS notification title, which the gate did not list.
- **Phase**: 1 (done) / S / new upstream strings leak on each update; the leak scan guards it.

### P1-02 Dev flavor that installs beside prod
- **Sees/does**: "MittrCraft Dev" runs next to the installed MittrCraft with its own data, scheme `mittrcraft-dev://`, app id and port 57133.
- **1.22 code**: `packages/electron/app-flavor.mjs`, `app-flavor-env.mjs`, `deep-link-protocol.mjs`, `lib/mittr/deep-link-scheme.js` (`06bec9152`).
- **Platform**: `DESKTOP_REDIRECT_URIS` default already lists both schemes (main and develop).
- **Upstream 2.1.1**: no. Phase 1 product files `brand/product.{dev,prod}.json`, hooks in `entry.mjs`, `early-startup.mjs`, `main.mjs`.
- **Target**: done.
- **Accept**: gate §6 (port) and §2 (isolation).
- **Phase**: 1 (done) / S / a real prod-flavor launch is still unproven (gate R31), checked at release.

### P1-03 History, settings and engine data carried over from 1.21/1.22
- **Sees/does**: after updating, every old session, project and setting is there.
- **1.22 code**: `lib/opencode/home.js` (four XDG bases per account), `mittr-accounts/`.
- **Platform**: none.
- **Upstream 2.1.1**: OpenCode 2 migrates 1.x sessions itself; phase 1 added the backup, settings migration and engine env.
- **Target**: done (`packages/mittr-server/src/{backup,settings,engine-home,accounts}.js`).
- **Accept**: gate §1, §3, §7. Open: per-account homes other than the active one are migrated when first switched to (P2-03 checks it). Gate finding B1 (settings rewritten before the backup) stays as recorded.
- **Phase**: 1 (done) / L / B1.

### P1-04 No app self-update and no upstream update or usage call
- **Sees/does**: no "Check for updates", no update toast, no call to upstream's update service. Releases are dmgs handed to the team (decision A). 1.22 had its own in-app updater reading GitHub releases of `techflowasia/mittr-craft` (`0fb9074f3`, `updater-feed.mjs`); that is retired by decision A.
- **Upstream 2.1.1**: has an updater; phase 1 turned it off (`hook(updater*)`, `hook(update-check)`).
- **Target**: done.
- **Accept**: gate §4.
- **Phase**: 1 (done) / S / none.

### P1-05 Engine pinned, no engine self-update
- **Sees/does**: the engine is the one bundled with the app; there is no "update engine" button or toast and no engine-update setting.
- **1.22 code**: `41d42f18b` removed `OpenCodeUpdateToast`, `upgrade-capability.js`, the VS Code upgrade bridge, and the "Show engine update notifications" setting.
- **Upstream 2.1.1**: bundled CLI via `OPENCODE_BINARY` (done), but desktop Settings → General → Engine CLI still offers "Show engine update notifications", and the server still looks up the latest `@opencode/cli` on npm (gate U1).
- **Target**: remaining part in P5-13.
- **Phase**: 1 (done, remainder in phase 5).

---

## 2. Phase 2: sign-in, accounts, models, quota, AD/Entra, audit

### P2-01 Mittr sign-in gate
- **Sees/does**: on a fresh install the whole app (main window and Mini Chat) shows one "Sign in with Mittr" screen with a short note on what the audit trail records. Clicking it opens the browser; after signing in the browser hands back to the app and the app opens without a second click.
- **1.22 code**: `ui/src/components/mittr/MittrSignInGate.tsx`, `mittrSignInGateState.ts`, `AuditNotice.tsx`; `ui/src/main.tsx`, `apps/renderElectronMiniChatApp.tsx`; `web/server/lib/mittr/auth-routes.js`, `sign-in-transaction.js` (PKCE-style verifier), `session.js`; `electron/auth-deep-link.mjs`, `main.mjs` (deep link → `POST /api/mittr/auth/callback`, then a `mittr-signed-in` window event).
- **Platform**: `GET /auth/desktop/start`, `POST /auth/desktop/exchange`, `POST /auth/desktop/refresh` (`desktop-auth.controller.ts`, main and develop). Redirect allowlist `DESKTOP_REDIRECT_URIS` defaults to `mittrcraft://auth/callback` and `mittrcraft-dev://auth/callback`.
- **Upstream 2.1.1**: no Mittr sign-in. Upstream `main.mjs` handles `openchamber://connect` only. 2.1.1 has its own UI-auth gate (`SessionAuthGate`) for hosted web; it is a different thing.
- **Target**: mittr-server routes `/api/mittr/auth/*`; mittr-ui root wrapper (hook 9, and hook 10 for Mini Chat, both already in place) renders the gate; deep-link handler registry in `main.mjs` (hook 6, file already touched) registers `auth/*`.
- **Accept**: Dev build, empty temp HOME. (1) App opens on the sign-in screen; Mini Chat (from the tray or shortcut) shows the same screen. (2) Click sign in, sign in as Account A on api-dev in the browser. (3) The app leaves the gate within 5 s without a second click. (4) `GET http://127.0.0.1:57133/api/mittr/auth/status` reports signed in with Account A's user id. (5) Quit and relaunch: no sign-in screen.
- **Phase**: 2 / M / the deep-link registry must not break upstream's `connect` pairing links.

### P2-02 Sign-in kept safe and fresh
- **Sees/does**: the person stays signed in across restarts; the refresh token sits in the macOS keychain (Electron `safeStorage`), never in plain text on desktop. An expired access token refreshes on its own.
- **1.22 code**: `electron/secret-store.mjs`; `lib/mittr/index.js` (`createPlaintextSecretStore` fallback for a non-desktop host, which logs a warning); `auth-routes.js` `ensureFreshSession`.
- **Platform**: `POST /auth/desktop/refresh`.
- **Upstream 2.1.1**: no.
- **Target**: mittr-server; the secret store comes from the Electron main process through the server-plugin context. **The phase 1 plugin context is only `{ app, dataDir, logger }`**; it must be widened (hook 1, `server/index.js`, already touched) with the secret store and the other items spec §5.6 lists.
- **Accept**: after P2-01, `grep -a refresh ~/.config/mittrcraft-dev/mittr-accounts/*` (in the temp HOME) finds no readable token; restart the app with the clock moved past the access-token life (or wait for expiry on dev) and send a chat: it answers without a sign-in prompt.
- **Phase**: 2 / S / safeStorage must be reachable from the in-process server.

### P2-03 Several Mittr accounts, switch between them (MITTRAI-21)
- **Sees/does**: the account menu at the bottom of the sidebar lists signed-in accounts. "Add account" signs in another account without signing out the first; picking an account switches to it. Each account has its own session history and its own model list; the first account keeps the history it already had.
- **1.22 code**: `ui/.../sidebar/MittrAccountMenu.tsx`, `SidebarFooter.tsx`, `lib/mittrAccountsApi.ts`, `i18n/messages/mittr-accounts.i18n.ts`; `web/server/lib/mittr/account-store.js`, `auth-routes.js` (`/api/mittr/auth/accounts`, `/accounts/activate`), `index.js` `switchAccount()`, `lib/opencode/home.js` (`accounts/<home>` engine dirs), per-account catalog cache `mittr-accounts/<home>.catalog.json`.
- **Platform**: auth routes only.
- **Upstream 2.1.1**: no.
- **Target**: mittr-server (account store already read by phase 1 `accounts.js`); the engine env per account comes from `engineEnv()` (done); switching uses upstream's engine restart (needs the refresh function in the plugin context). Menu: mittr-ui. **Placement needs a hook**: upstream `SidebarFooter.tsx` has no slot; either a new slot there (new upstream file) or move the menu into a root-wrapper overlay.
- **Accept**: signed in as A with a session "A-1". Open the account menu → Add account → sign in as B. Menu lists A and B, B active, session list has no "A-1", model picker shows B's agents. Create "B-1". Switch to A: "A-1" back, "B-1" gone. Quit, relaunch: last active account still active. With a 1.22 Dev data copy that already has two accounts, the second account's old sessions appear after the first switch (proves the lazy per-account migration).
- **Phase**: 2 / L / per-account OpenCode 2 migration on first switch; a stray refresh of the inactive account must never sign out the active one.
- **Limit**: with an external OpenCode server (one the app did not start), a switch does not move the engine to another home: that server keeps its own folders and history for every account; only the managed engine changes home.

### P2-04 Sign out of Mittr
- **Sees/does**: "Sign out" in the account menu, in the desktop About dialog, and in the About settings page (mobile/web). Signing out the active account switches to the next signed-in account or returns to the sign-in screen.
- **1.22 code**: `MittrAccountMenu.tsx`, `ui/components/ui/AboutDialog.tsx` (`8fe528faa`), `sections/mittrcraft/AboutSettings.tsx` (`097d51d33`); `DELETE /api/mittr/auth/session`.
- **Platform**: none (local session removal).
- **Upstream 2.1.1**: no.
- **Target**: mittr-server route; buttons: account menu (mittr-ui), About settings via the existing `hook(about-settings)` file, desktop `AboutDialog.tsx` needs a slot (new upstream file) unless the owner accepts sign-out from the account menu only.
- **Accept**: with A and B signed in and A active: About → Sign out → app reloads on B. Account menu → Sign out on B → sign-in screen. `GET /api/mittr/auth/accounts` returns an empty list.
- **Phase**: 2 / S / About dialog hook.

### P2-05 Mittr models through a loopback provider
- **Sees/does**: chats answer through Mittr. The person never types an API key. A packaged build talks to the platform it was built for (prod build: `api.mittr.asia`; a dev build may be pointed at `api-dev.mittr.asia`), and a packaged build cannot be redirected at run time.
- **1.22 code**: `lib/mittr/shim-routes.js` (streams `/v1/chat/completions` without buffering), `local-token.js` (`mittr-shim-token`), `loopback-guard.js`, `upstream-config.js`, `broker-target.js` (default `https://api.mittr.asia`, `MITTRCRAFT_BROKER_URL` baked in by `electron/scripts/bundle-main.mjs`), `server/index.js` `storeMittrCredential` (writes `auth.json` `mittr` key).
- **Platform**: `POST /v1/chat/completions`, `GET /v1/models` (`openai.controller.ts`, main and develop).
- **Upstream 2.1.1**: no. OpenCode 2 has no `auth.json`; credentials go through its credential API (spec §5.3). Provider config is `providers.mittr` in the managed config.
- **Target**: mittr-server shim + OpenCode 2 config writer; broker URL in `brand/product.<flavor>.json` (not a run-time env in packaged builds).
- **Accept**: signed in as A, new session, pick a Mittr agent, send "say hi": an answer streams in. `strings` on `app.asar` of the Dev build shows the dev broker; on the prod build (release check) `api.mittr.asia`. `MITTRCRAFT_BROKER_URL=https://example.invalid` at launch of the packaged Dev app does not change where requests go.
- **Phase**: 2 / M / OpenCode 2 credential API and provider config shape.

### P2-06 Model list driven by the Mittr catalog
- **Sees/does**: the model picker shows exactly the Mittr agents granted to the signed-in person, with their labels. When an admin grants or withdraws an agent, the list follows after the next sync, without a manual restart. On start, the last known list appears at once, before the network answers.
- **1.22 code**: `lib/mittr/catalog-routes.js` (`GET /api/mittr/catalog`, `POST /api/mittr/catalog/sync`), `catalog.js`, `catalog-cache.js`, `index.js` `applyCachedCatalog`, `server/index.js` `syncMittrModels`, `lib/opencode/providers.js` (`readProviderModelIds`); `ui/stores/useMittrCatalogStore.ts`.
- **Platform**: `GET /desktop/catalog` (main and develop).
- **Upstream 2.1.1**: no. Upstream hot-reloads the managed config file, so the 1.22 "restart the engine when the list changes" (`8e3f4afd9`) may be replaced by a managed-config write.
- **Target**: mittr-server writes `providers.mittr.models` into upstream's managed config.
- **Accept**: as A, picker lists A's granted agents. On dev, withdraw one agent from A (platform admin), then `POST /api/mittr/catalog/sync`: within 10 s the picker no longer lists it, without restarting the app. Restart offline (Wi-Fi off): picker still shows the last list.
- **Phase**: 2 / M / managed-config reload timing on OpenCode 2.

### P2-07 A fresh install starts on the first Mittr agent
- **Sees/does**: after the first sign-in, new sessions already use a Mittr agent. A default on another provider is never changed; a Mittr default that is withdrawn moves to one still offered, and is cleared when none is.
- **1.22 code**: `lib/opencode/providers.js` `syncProviderDefaultModel` (`104a11e1e`).
- **Platform**: `/desktop/catalog`.
- **Upstream 2.1.1**: no.
- **Target**: mittr-server, writing `model` in the managed or user config.
- **Accept**: fresh temp HOME, sign in as A, open a new session without touching the picker: the picker shows A's first agent and a message is answered. Withdraw that agent on dev, sync: the default becomes the next agent.
- **Phase**: 2 / S / none.

### P2-08 Only granted Mittr models in the picker, with an opt-in switch for others
- **Sees/does**: by default the picker shows only the Mittr roster. Settings → Providers has a switch "show models from other providers" that a developer can turn on to see providers they added themselves.
- **1.22 code**: `ui/stores/useMittrCatalogStore.ts` (`grantedProviderId`), `ModelControls.tsx`, `sections/providers/ProvidersPage.tsx`, `useUIStore.ts` `showExternalModels` (`3addb3dad`).
- **Platform**: `/desktop/catalog`.
- **Upstream 2.1.1**: no picker filter. **Conflict**: spec §5.3 and the anti-goals lock the engine to Mittr with OpenCode policy (`provider.use` deny all but `mittr`), which removes what this switch exposed. See Q2.
- **Target**: policy written by mittr-server (gate 2: "only Mittr models can be chosen or used"). If the owner keeps the switch: hook in `ProvidersPage.tsx` (new file) or a mittr-ui settings page.
- **Accept**: with policy only: add any other provider in Settings → Providers; picker still lists only Mittr agents; a session forced to that model (CLI `session create --model other/x`) is refused by the engine.
- **Phase**: 2 / S / owner decision.

### P2-09 Quota marks in the model picker
- **Sees/does**: each Mittr agent in the picker carries a small pill with this week's remaining quota; agents near the limit are marked; an agent whose quota is used up is greyed out and cannot be picked, with a tooltip saying when it resets. Role names and the agents behind each model come from Mittr.
- **1.22 code**: `ui/components/model-picker/mittrAgentStatus.ts`, `ModelPickerList.tsx` (`ModelPickerStatusPill`, `entryStatus`), `ModelControls.tsx`; `lib/mittr-quota/quota-me*.ts`; `web/server/lib/mittr-quota/service.js` (`agentStatus`, `lines`, `resetsAt`, `weekStart`).
- **Platform**: `GET /api/quota/me` (main and develop, `agentStatus` field present on both).
- **Upstream 2.1.1**: no per-entry status in the picker.
- **Target**: hook 13 (`ModelControls.tsx` model-row badge slot) **plus** `ModelPickerList.tsx` (the pill and the blocked state are drawn per entry there): two new upstream files.
- **Accept**: as Q with one agent exhausted: open the picker: that agent shows a pill and cannot be selected by click or Enter; its tooltip names the reset time; another agent shows its remaining amount.
- **Phase**: 2 / M / two hot UI files.

### P2-10 This week's Mittr quota in Settings → Usage
- **Sees/does**: Settings → Usage opens on "Mittr" first, showing this week's quota per agent and per speech kind with reset time. With no platform the panel is hidden; an empty week reads "no model available". Settings search finds it ("quota", "weekly").
- **1.22 code**: `sections/usage/MittrUsagePage.tsx`, `mittrUsage.ts`, `UsagePage.tsx`, `UsageSidebar.tsx`, `views/SettingsView.tsx`, `lib/settings/search.ts` (`sessions.mittrQuota`), `stores/useQuotaStore.ts`; `web/server/lib/mittr-quota/routes.js` (`GET /api/mittr/quota/me`).
- **Platform**: `GET /api/quota/me`.
- **Upstream 2.1.1**: has a usage page with a server and UI quota-provider registry, but no registration API.
- **Target**: hooks 2 and 3 (`registerQuotaProvider`, server and UI): two new upstream files. Spec: use upstream's card if it can show "remaining this week" first, else our card body.
- **Accept**: as A, Settings → Usage: Mittr is selected first and lists A's agents with remaining amounts and a reset date; search "quota" in settings jumps there.
- **Phase**: 2 / M / registry hooks.

### P2-11 Used-up weekly quota shown in chat, with Try again
- **Sees/does**: when a Mittr agent's weekly quota is used up, the answer area shows "quota used up, resets <time>" instead of an error dump, with one "Try again" button on the latest turn only. Try again resends the same message with its attachments.
- **1.22 code**: `chat/ChatMessage.tsx`, `chat/message/QuotaRetryButton.tsx`, `AssistantErrorNotice.tsx`, `MessageBody.tsx` (`errorAction`), `lib/mittr-quota/{exhausted,retry,resend,week,format}.ts`.
- **Platform**: `/v1/chat/completions` returns `llm_quota_exhausted` with `resetsAt` (main and develop).
- **Upstream 2.1.1**: no.
- **Target**: hook 12 (`ChatMessage.tsx` assistant-message footer slot). The error text itself may need `MessageBody.tsx` unless the slot can replace the error block: verify, else one more file.
- **Accept**: as Q, send until refused: the message shows the reset time and one Try again; earlier refused turns show no button. Attach an image, get refused, raise the quota on dev, press Try again: the new turn carries the image and is answered.
- **Phase**: 2 / M / OpenCode 2 error shape on the message.

### P2-12 A quota refusal is not retried
- **Sees/does**: a quota refusal ends the turn at once; the engine does not spin five retries.
- **1.22 code**: `lib/mittr/shim-routes.js` (429 `llm_quota_exhausted` → 402, mid-stream quota frame rewritten), `lib/mittr-quota/exhausted.js` (`3aa095e16`, `be60cf613`: no text the engine's retry patterns match).
- **Platform**: as P2-11.
- **Upstream 2.1.1**: no; OpenCode 2's retry rules differ from 1.x and must be re-measured (spec §6).
- **Target**: mittr-server shim.
- **Accept**: as Q, with the shim request log on: one refused request produces exactly one upstream call; the session status goes idle within 2 s with no "retrying" state.
- **Phase**: 2 / S / OpenCode 2 retry patterns.

### P2-13 "Answered by a backup model" note
- **Sees/does**: when Mittr answered with a backup agent because the chosen one was unavailable, a muted line under the answer names the backup and why.
- **1.22 code**: shim reads `answered_by` keyed by `X-Session-Id`; `lib/mittr-quota/answered-by.js`, `GET /api/mittr/answered-by`; UI `chat/message/AnsweredByNotice.tsx`, `lib/mittr-quota/answered-by*.ts`.
- **Platform**: `answered_by` in `/v1/chat/completions` (main and develop).
- **Upstream 2.1.1**: no. Check that OpenCode 2 still sends `X-Session-Id` (or an equivalent) to the provider.
- **Target**: mittr-server; hook 12 slot.
- **Accept**: on dev, make A's chosen agent unavailable so the platform substitutes; send a message: the line under the answer names the backup agent.
- **Phase**: 2 / S / session id header on OpenCode 2.

### P2-14 Model refusal and broken tool-call diagnostics
- **Sees/does**: an access refusal says whether it needs an admin (no entitlement) or a re-sync (stale catalog); the server log flags a model whose tool calls came back as plain text (`<tool_call>`, `<function=`).
- **1.22 code**: `lib/mittr/model-refusal.js`, `response-markup.js`, `shim-routes.js`.
- **Platform**: error codes `desktop_entitlement_required`, `agent_not_granted`.
- **Upstream 2.1.1**: no.
- **Target**: mittr-server shim.
- **Accept**: as a dev user without desktop entitlement, send a message: the error says an admin is needed. Pick an agent then withdraw it: the error says a re-sync fixes it.
- **Phase**: 2 / S / none.

### P2-15 The model says it is MittrCraft
- **Sees/does**: asked "who are you", the agent answers MittrCraft, not OpenCode.
- **1.22 code**: engine fork patch `engine/patches/0001-mittrcraft-identity-and-project-directory.patch` (9 prompt files); `web/server/lib/system-prompt/runtime.js` minimal identity.
- **Platform**: none.
- **Upstream 2.1.1**: **upstream removed its system-prompt runtime**; the engine is upstream's OpenCode 2 (decision 2 drops the fork).
- **Target**: `packages/mittr-opencode` plugin using an OpenCode 2 system-prompt hook (still to be proven on 2.0.22).
- **Accept**: three fresh sessions on two different Mittr agents, ask "who are you?" and "what product am I using?": every answer names MittrCraft and none names OpenCode or OpenChamber.
- **Phase**: 2 / M / the hook may not exist in OpenCode 2.0.x.

### P2-16 Only Mittr models can be used
- **Sees/does**: the engine refuses any non-Mittr provider, even one configured by hand.
- **1.22 code**: picker filter only (P2-08); no engine policy.
- **Upstream 2.1.1**: OpenCode 2 policies; enterprise mode stays off (decision B).
- **Target**: mittr-server writes the policy into the managed config.
- **Accept**: spec gate 2 check, see P2-08.
- **Phase**: 2 / S / Q2.

### P2-17 Active Directory (LDAP) sign-in for hosted web
- **Sees/does**: when MittrCraft is served as a web app with AD configured, the browser login offers a company username and password; the sidebar footer shows the person's name, title and department with a sign-out.
- **1.22 code**: `web/server/lib/ui-auth/ad-auth.js` (`ldapjs`), `ui-auth.js`, `opencode/core-routes.js` (`/auth/ad/status`, `/auth/ad/login`, `/auth/ad/callback`, `/auth/ad/profile`, `POST /auth/ad/session`, `DELETE /auth/session`), UI `auth/SessionAuthGate.tsx`, `sessionAuthGateState.ts`, `session/sidebar/SidebarFooter.tsx`, `sidebarUserProfile.ts`. Env: `MITTR_AD_ENABLED`, `MITTR_AD_URL`, `MITTR_AD_BIND_DN`, `MITTR_AD_BIND_PASSWORD`, `MITTR_AD_SEARCH_BASE`.
- **Platform**: none (talks to the AD server directly).
- **Upstream 2.1.1**: password, passkey and trusted-device auth only.
- **Target**: decision 4: providers in mittr-server through hook 17 (`ui-auth.js` provider registry) and hook 18 (`SessionAuthGate.tsx` slot). The profile chip needs `SidebarFooter.tsx` (same file as P2-03). Tunnel-scope refusals must be kept.
- **Accept**: `bunx` serve the web build with `MITTR_AD_*` pointed at a test LDAP (or the company AD on a dev host), open the browser: the gate shows the AD form; a valid user gets in and sees their name in the sidebar footer; a wrong password is refused; through a tunnel URL the AD login answers 403.
- **Phase**: 2 / M / needs a hosted-web deployment to test; see Q4.

### P2-18 Microsoft Entra ID sign-in for hosted web
- **Sees/does**: a "Sign in with Microsoft" button on the hosted-web login (not on desktop); sign-out in the sidebar footer signs out only that browser.
- **1.22 code**: `ui-auth/entra-auth.js` (OIDC, PKCE, ID-token checks), `SessionAuthGate.tsx`, `SidebarFooter.tsx`. Env: `MITTR_AD_CLIENT_ID`, `MITTR_AD_CLIENT_SECRET`, `MITTR_AD_TENANT_ID`, `MITTR_AD_REDIRECT_URI`. A partial config fails closed.
- **Platform**: none (Microsoft directly).
- **Upstream 2.1.1**: no.
- **Target**: as P2-17.
- **Accept**: hosted web with the four variables set to a test App Registration: button shown; sign in returns to the app; sidebar sign-out returns to the login; with three of four variables set the server refuses to start the UI unauthenticated. On the desktop app the button is absent.
- **Phase**: 2 / M / same as P2-17.

### P2-19 Audit routes
- **Sees/does**: nothing today (no caller in 1.22, verified). Routes record who did what, where and what they typed when called.
- **1.22 code**: `lib/mittr/audit-routes.js`, `audit-record.js`, `audit-serializer.js`, `repository-identity.js` (`/api/mittr/audit/{prompt,tool,turn,finish}`).
- **Platform**: `POST /desktop/audit` (main and develop).
- **Upstream 2.1.1**: no.
- **Target**: mittr-server, ported as is (decision 4); no new callers.
- **Accept**: `curl -X POST :57133/api/mittr/audit/prompt` with a 1.22-shaped body while signed in as A: 2xx, and the record appears in the dev platform's `GET /desktop/audit` for A.
- **Phase**: 2 / S / none.

### P2-20 Hosted web is not indexed by search engines
- **Sees/does**: a hosted MittrCraft answers `X-Robots-Tag: noindex, nofollow` and serves a `robots.txt` that disallows everything.
- **1.22 code**: `web/server/index.js` (added with the AD work).
- **Upstream 2.1.1**: check; not found in a search.
- **Target**: mittr-server route and middleware.
- **Accept**: `curl -I :57133/` shows the header; `curl :57133/robots.txt` shows `Disallow: /`.
- **Phase**: 2 / S / plugin middleware order (must run before static serving).

### P2-21 The engine starts once
- **Sees/does**: no second, orphaned engine process after startup (it showed up when the catalog sync restarted the engine while the first start was still running).
- **1.22 code**: `origin/fix/engine-single-instance` `5c4be9880`, `lib/opencode/lifecycle.js` (launch queue). Not merged into 1.22.
- **Upstream 2.1.1**: **the race is still there**: the first `startOpenCode()` is not serialised with `restartOpenCode()`.
- **Target**: hook in `lifecycle.js` (already touched, no new file), or have mittr-server delay its first catalog-driven refresh until the engine is ready.
- **Accept**: fresh temp HOME, sign in, quit, relaunch with network on: within 30 s, `pgrep -P <app pid> opencode` lists exactly one engine; repeat 5 times.
- **Phase**: 2 / S / none.

---

## 3. Phase 3: My work, Jira/Plane, integrations settings, catalog skills/MCP

### P3-01 My work panel
- **Sees/does**: a briefcase button in the sidebar header opens "My work": the Jira issues and Plane work items assigned to the signed-in person, with no separate login (the Mittr session is enough).
- **1.22 code**: `ui/components/session/MyWorkDialog.tsx`, `sidebar/SidebarHeader.tsx` (button), `MainLayout.tsx` (page), `useUIStore.ts` (`isMyWorkDialogOpen`), `lib/mittrWorkApi.ts`; `web/server/lib/mittr-work/{routes,service}.js` (`GET /api/mittr/work`).
- **Platform**: `GET /desktop/work` (main and develop; merges Plane and Jira server-side).
- **Upstream 2.1.1**: no Jira/Plane. It has GitHub, GitLab and Linear issue tracking (`tracked-items`, `linear`) and an extension `page`.
- **Target**: built-in extension (`page`, opened from the sidebar menu that upstream gives extension pages) + mittr-server proxy route; the extension's `integration.apiOrigin`/credential kept fresh by mittr-server (spec §5.4). No sidebar-header hook if the extension page entry is accepted as the way in.
- **Accept**: as A, open My work: A's assigned Jira issue and Plane item are listed with titles; their links open in the browser; as B, B's own items show instead.
- **Phase**: 3 / M / extension sandbox (no network if enterprise mode were on; decision B keeps it off).

### P3-02 My work grouping, filters and keys
- **Sees/does**: items grouped by source and status, groups fold and remember it, source filter chips, statuses told apart by colour, and each item shows its key (e.g. MRKB-2122, Plane key).
- **1.22 code**: `session/myWorkGrouping.ts`, `MyWorkDialog.tsx` (`dc46530ab`, `5a7e818de`, `83bd6f63e`).
- **Platform**: key field from `/desktop/work`.
- **Upstream 2.1.1**: no.
- **Target**: inside the My work extension.
- **Accept**: fold a status group, close and reopen: still folded (note: renderer storage is reset once on the update, spec §7). Choose the Plane chip: only Plane items. Every row shows its key.
- **Phase**: 3 / S / none.

### P3-03 Several Plane workspaces in My work (MITTRAI-20)
- **Sees/does**: with more than one Plane workspace connected, each workspace gets its own chip and group; with one, it looks as before; a saved "Plane" filter still means every workspace.
- **1.22 code**: `myWorkGrouping.ts`, `MyWorkDialog.tsx` (`33e08825c`).
- **Platform**: workspace on each item from `/desktop/work`. **Multi-workspace support (`workspaceSlugs`, platform commit `3da0045f7`) is on platform develop only, not on main (prod).** See Q3.
- **Upstream 2.1.1**: no.
- **Target**: My work extension.
- **Accept**: as A (two Plane workspaces, one item in each): two Plane chips and two groups, each with its item.
- **Phase**: 3 / S / prod platform lacks it.

### P3-04 Go work from a card
- **Sees/does**: "Go work" on an item asks which project to work in, checks a model is available, creates a session titled after the card and sends a prompt with the card key, title and link.
- **1.22 code**: `MyWorkDialog.tsx` `goWork` (`dc598b87f`, `f4a1e04fc`, `ba1b1738a`).
- **Platform**: none beyond `/desktop/work`.
- **Upstream 2.1.1**: an extension can `attach` a chip to the composer and run `commands`, but has no "create a session with this prompt" host call verified yet.
- **Target**: My work extension calling a mittr-server route that uses upstream's control service (`session.create` with prompt), then navigating to the session; or `attach` the card into the composer of a new session. Builder's call, keep the behaviour.
- **Accept**: Go work on a Jira item → pick a project: a new session in that project, titled with the card, with a first user message holding the key and link, and an agent answer. With no Mittr model available (Q exhausted on all agents): a message says so and no empty session is created.
- **Phase**: 3 / M / extension-to-host session creation.

### P3-05 Work-tracking settings: Jira
- **Sees/does**: Settings → Integrations → Work tracking: Jira site URL, email and API token; Save; Test connection shows who the token belongs to or the error.
- **1.22 code**: `sections/integrations/WorkTrackingIntegrationsSection.tsx`, `IntegrationsPage.tsx`, `lib/mittrIntegrationsApi.ts`; `web/server/lib/mittr-integrations/{routes,service}.js` (`GET/PUT /api/mittr/integrations`, `POST .../jira/test`).
- **Platform**: `GET/PUT /api/integrations`, `POST /api/integrations/jira/test` (main and develop). The token is stored on the platform per user.
- **Upstream 2.1.1**: no.
- **Target**: spec: "tool settings" as a built-in extension; extension `integration.settings` fields are simple, so the form likely needs the extension's own page or a mittr-ui settings page.
- **Accept**: as A, enter a valid Jira token, Save, Test: shows A's Jira name. Change the token to junk, Test: shows the Jira error. Reload: fields show the saved site and email, token masked.
- **Phase**: 3 / S / settings placement.

### P3-06 Work-tracking settings: Plane with several workspaces
- **Sees/does**: one Plane address and token, plus a list of workspaces added by name or by pasting a workspace URL, removable per row; Test connection shows a result per workspace.
- **1.22 code**: `WorkTrackingIntegrationsSection.tsx`, `mittrIntegrationsApi.ts` (`workspaceSlugs`), `i18n/messages/plane-workspaces.i18n.ts`.
- **Platform**: `PUT /api/integrations` with `workspaceSlugs`, `POST /api/integrations/plane/test` returning per-workspace results: **platform develop only** (Q3).
- **Upstream 2.1.1**: no.
- **Target**: as P3-05.
- **Accept**: as A, paste two workspace URLs, Save, Test: two rows each with ok and an item count; remove one, Save, reopen: one row.
- **Phase**: 3 / S / prod platform lacks it.

### P3-07 Skills from the Mittr catalog
- **Sees/does**: skills the organisation publishes in Mittr appear in the engine for the signed-in person without any install step; withdrawn ones go away.
- **1.22 code**: `lib/mittr/skill-reconciler.js` (writes into the engine skills dir), `index.js` (`refreshEngine` when skills change) (`7c9996753`).
- **Platform**: `GET /desktop/catalog` (skills section; `desktop-shipped-skills.ts`).
- **Upstream 2.1.1**: has a skills catalog UI for GitHub/ClawdHub skills; it writes under `OPENCODE_CONFIG_DIR/skills`.
- **Target**: mittr-server → `$OPENCODE_CONFIG_DIR/skills`.
- **Accept**: as A, a catalog skill (e.g. card-analysis on dev) is listed in Settings → Skills and the agent uses it when asked for its trigger; withdraw it on dev, sync: it disappears.
- **Phase**: 3 / S / skill folder layout in OpenCode 2.

### P3-08 MCP connectors from the Mittr catalog
- **Sees/does**: organisation MCP connectors (e.g. iApp Thai Legal) are configured for every project without setup.
- **1.22 code**: `lib/mittr/mcp-reconciler.js` (user scope), `local-enablement.js` (`mittr-enablement.json`, `PUT /api/mittr/catalog/enablement`, no UI caller in 1.22).
- **Platform**: `/desktop/catalog` (MCP section).
- **Upstream 2.1.1**: MCP config in the v2 shape.
- **Target**: mittr-server writes v2 MCP entries; watch MCP process fan-out per directory (spec §6).
- **Accept**: as A, Settings → MCP lists the catalog connector as connected; in a session, a tool from it runs (e.g. a Thai law search) and returns a result. Open three projects: no more than one connector process per project.
- **Phase**: 3 / M / OpenCode 2 MCP fan-out.

### P3-09 When the catalog syncs
- **Sees/does**: the model list, skills and connectors refresh on sign-in, on app start, on account switch, and when asked (`POST /api/mittr/catalog/sync`).
- **1.22 code**: `lib/mittr/index.js`, `catalog-routes.js`.
- **Target**: mittr-server.
- **Accept**: each trigger above produces one `GET /desktop/catalog` in the dev platform log for that user.
- **Phase**: 3 / S / none.

---

## 4. Phase 4: voice

### P4-V1 Mittr dictation
- **Sees/does**: in Settings → Voice, "Mittr (set on the platform)" can be chosen for voice input. The microphone button in the composer then transcribes through Mittr. If speech is not ready on the platform, the reason is shown.
- **1.22 code**: `web/server/lib/dictation/mittr-session.js`, `dictation/service.js` (provider `mittr`), `mittr-speech/client.js`, `voice-speech/routes.js` (`GET /api/voice/readiness`, `POST /api/voice/transcribe`); UI `hooks/useDictation.ts`, `lib/dictation/dictation-client.ts`, `VoiceSettings.tsx`, `MittrVoiceProviderNote.tsx`, `hooks/useMittrVoiceReadiness.ts`.
- **Platform**: `GET /desktop/speech/readiness`, `POST /desktop/speech/transcribe` (main and develop).
- **Upstream 2.1.1**: has dictation with local and OpenAI-compatible providers (record-then-transcribe). Spec §5.3: point upstream's OpenAI-compatible STT at the shim's `/v1/audio/*`.
- **Target**: mittr-server shim `/v1/audio/transcriptions` + settings seeded by mittr-server; no UI hook if upstream's provider is used. Q: whether "OpenAI-compatible" with a loopback URL visible in Settings is acceptable or the "Mittr" choice must stay (a `VoiceSettings.tsx` hook).
- **Accept**: as A, choose Mittr dictation, hold the dictation key (upstream shortcut), say a Thai sentence: the text appears in the composer. On a dev user without speech pinned: the reason text appears and no recording starts.
- **Phase**: 4 / M / provider naming in Settings.

### P4-V2 Dictation stops cleanly when the speech quota is used up
- **Sees/does**: when speech quota is used up the mic button is disabled with "voice input used up, resets <time>", no Retry button; it re-enables by itself once speech works again.
- **1.22 code**: `components/dictation/ComposerDictation.tsx`, `hooks/useDictation.ts`, `lib/mittr-quota/speech-quota-store.ts` (`a7e91ccc1`, `d70f90158`).
- **Platform**: `llm_quota_exhausted` + `resetsAt` from `/desktop/speech/transcribe`.
- **Upstream 2.1.1**: no.
- **Target**: spec §9: quota reasons and reset times must still reach the user. Either the shim returns an error message upstream's dictation already shows (no hook), or a hook in `ComposerDictation.tsx` (new file).
- **Accept**: as Q, dictate until refused: the button shows the reset time and is disabled; raise the quota on dev: the next dictation works and the block lifts.
- **Phase**: 4 / S / may cost a hook.

### P4-V3 Mittr read-aloud
- **Sees/does**: "Read aloud" on an answer speaks it with the Mittr voice; long answers are spoken in chunks; when speech is unavailable it says so instead of failing silently.
- **1.22 code**: `web/server/lib/tts/routes.js` (`providerId: 'mittr'`, 4000-char chunks, PCM→WAV), `hooks/useMessageTTS.ts`, `useServerTTS.ts`, `lib/voice/mittrVoice.ts`, `MessageBody.tsx` (provider label "Mittr").
- **Platform**: `POST /desktop/speech/synthesize`, `/desktop/speech/readiness`.
- **Upstream 2.1.1**: OpenAI-compatible TTS (`tts/openai-sdk.js`, `base-url.js`).
- **Target**: shim `/v1/audio/speech`, upstream TTS pointed at it.
- **Accept**: as A, read aloud a 6000-character answer: it plays to the end without a gap longer than 2 s; with speech disabled for the user on dev: a visible "speech unavailable" message.
- **Phase**: 4 / M / chunking behaviour vs upstream's player.

### P4-V4 Voice settings
- **Sees/does**: Settings → Voice shows the Mittr note, a "preview voice" button, "Most actions per spoken request" (1–20, default 8) and "Longest agent answer read aloud" (1000–30000 characters).
- **1.22 code**: `VoiceSettings.tsx`, `MittrVoiceProviderNote.tsx`, `opencode/settings-helpers.js` (`voiceStepCap`, `voiceReplyMaxChars`, provider `mittr`), `stores/useConfigStore.ts`, `lib/persistence.ts`.
- **Upstream 2.1.1**: voice settings page without these.
- **Target**: mittr-ui settings page (spec §5.4: upstream settings registration if any, otherwise a slot). The two keys moved under `settings.mittr` in phase 1.
- **Accept**: change both values, restart: still set; preview plays the Mittr voice.
- **Phase**: 4 / S / settings placement.

### P4-V5 Talk button and voice bar
- **Sees/does**: a Talk button next to the dictation button in the composer starts a spoken conversation. A bar shows Listening / Thinking / Speaking / "Working: <action>", what the person said and the reply. Escape or "End conversation" stops it.
- **1.22 code**: `components/voice-assistant/{TalkButton,VoiceBar,VoiceQuotaText}.tsx`, `lib/voice-assistant/{listen,player,queue,sentences,session,talk-store,turn,narration,keys}.ts`, `ComposerFooter.tsx`, `MainLayout.tsx`, `i18n/messages/voice.i18n.ts`; Silero VAD and ONNX runtime assets (`scripts/copy-vad-assets.mjs`).
- **Platform**: see P4-V6.
- **Upstream 2.1.1**: no voice assistant. Extensions get no microphone (spec §4), so this cannot be an extension.
- **Target**: mittr-ui: hook 11 (`ComposerFooter.tsx` composer-action slot, new file) + root portal for the bar (hook 9, done); VAD assets copied into the renderer build by our build script.
- **Accept**: as A, press Talk, say "what sessions are running?": the bar goes Listening → Thinking → Speaking and the reply is spoken and shown; press Escape: the bar closes and the mic indicator turns off.
- **Phase**: 4 / L / mic permission and VAD assets under 2.1.1's CSP.

### P4-V6 Voice assistant turn loop
- **Sees/does**: what the person says is decided on by the Mittr platform and carried out on this machine: start, send to, stop and read sessions; drive the browser panel, Chrome and the desktop; read Jira/Plane cards. Each action shows in the bar as it runs.
- **1.22 code**: `web/server/lib/voice-assistant/{routes,loop,tools,context}.js` (`POST /api/voice/turn` SSE, `POST /api/voice/end`); tools `mittrcraft`, `mittrcraft_web`, `mittrcraft_voice` built from `mittrcraft-control/actions.js` and the agent tool schemas; honours the four tool switches.
- **Platform**: `POST /desktop/voice/step` (main and develop); wire contract `docs/specs/2026-09-29-mittr-voice-wire.md` on develop.
- **Upstream 2.1.1**: no. **Its control contract changed**: agents no longer get `wait`/`timeout` (they get `returnResult`), and new actions exist (`session.link`, `file.open`, `memory.*`, `notify.send`). OpenCode 2 has one global event stream, cursor paging and `x-opencode-directory` on reads (spec §6).
- **Target**: mittr-server routes calling upstream's control service through the plugin context (needs the control service in hook 1's context) + mittr-ui client.
- **Accept**: as A with two sessions open: say "send 'add a README' to the newest session": that session gets the message and starts; say "what did it answer?": the bar reads its latest reply (capped at the setting); say "open example.com in Chrome and tell me the heading": Chrome opens visibly and the heading is spoken (after the site question, P4-V7).
- **Phase**: 4 / L / largest port (spec risk 4).

### P4-V7 Voice-only actions
- **Sees/does**: "stop that session" asks for confirmation first; "read me its answer" reads the latest reply; the first Chrome use on a site asks "allow <host> for this conversation?" and one spoken yes allows Chrome for the rest of the conversation (never saved); "goodbye/end the conversation" ends it by voice.
- **1.22 code**: `mittrcraft-control/actions.js` (`MITTRCRAFT_VOICE_ACTION_DEFINITIONS`: `session.stop`, `session.read_reply`, `chrome.allow_site`), `service.js` (`endChromeConversation`), `voice-assistant/loop.js` (`f69bd4dea`, `6e447c4be`, `c91bc1d0a`).
- **Platform**: `/desktop/voice/step` (with `desktop-voice-end.ts` on the platform).
- **Upstream 2.1.1**: none of these actions.
- **Target**: mittr-server (voice routes register these actions next to upstream's contract, not inside it).
- **Accept**: say "stop the newest session" right after starting a turn: it asks first; say yes: the session stops. Ask Chrome to open two pages on one site: one question, one yes, no second question; after "end the conversation", a new Talk asks again.
- **Phase**: 4 / M / none beyond P4-V6.

### P4-V8 Voice guards
- **Sees/does**: text read during a turn cannot start, change or stop work in the same turn; at most 20 calls per step; after the step cap the assistant says how far it got (in Thai if the person spoke Thai); a request for a busy session is queued and delivered when it goes idle.
- **1.22 code**: `voice-assistant/loop.js`, `tools.js`, `DOCUMENTATION.md`; UI queue `lib/voice-assistant/queue.ts` with upstream's `messageQueueStore`.
- **Target**: mittr-server + mittr-ui.
- **Accept**: say (in Thai) a request needing more steps than the cap set to 2: the spoken closing sentence is Thai and names 2 steps. Send to a busy session by voice: the composer queue shows the text and it is delivered when the session finishes.
- **Phase**: 4 / S / upstream queue store API.

### P4-V9 Voice and quota
- **Sees/does**: when the speech quota is used up, Talk stays off with the reset time and answers come as text; when the platform ends a voice step on quota, the reset time is kept and shown.
- **1.22 code**: `VoiceQuotaText.tsx`, `TalkButton.tsx`, `speech-quota-store.ts`, `mittr-quota/exhausted.js` (`31fbbd012`, `04cd5ec89`).
- **Platform**: `/desktop/voice/step`, `/desktop/speech/*` quota errors.
- **Target**: mittr-ui + mittr-server.
- **Accept**: as Q, run Talk until refused: Talk is disabled with the reset time; the last answer appears as text.
- **Phase**: 4 / S / none.

---

## 5. Agent and automation tools (one row per capability)

Shared facts for this section:

- 1.22 offers four managed engine tools: `mittrcraft` (control), `mittrcraft_web` (in-app browser panel), `mittrcraft_computer` (desktop) and `mittrcraft_chrome` (the person's Chrome). Each has a switch in Settings → MittrCraft → Tools (`agentControlToolEnabled`, `agentWebToolEnabled`, `agentComputerToolEnabled`, `agentChromeToolEnabled`). Code: `web/server/lib/agent-tool/runtime.js` (plugin template), `mittrcraft-control/{actions,service,routes,chrome-control,chrome-approvals,computer-control,screenshots}.js`, `ui/.../MittrCraftToolsSettings.tsx`, `lib/chromeProfilesApi.ts`.
- 2.1.1 offers `openchamber` (control), `openchamber_web`, `openchamber_memory` and `openchamber_notify`, generated by `agent-tool/runtime.js` as OpenCode 2 tools (`tools.add({ name, input: JSONSchema, execute(input, context) })`, `options.codemode` false by default, result `{ content, metadata }` and never `output`). 2.1.1 also lets an extension replace the in-app browser (`contributes.service.provides: ["browser"]`, Settings → Tools → Browser provider), answering the same `browser.*` actions.
- **OpenCode 2 change that hits us**: 1.22's Chrome tool calls `context.ask({ permission: "mittrcraft_chrome", patterns, always })` to raise the engine's permission prompt and returns images as `attachments`. Neither is used anywhere in 2.1.1's template; both must be proven on OpenCode 2.0.22 before A-15 to A-22 can keep their behaviour.
- The voice assistant drives every action marked "voice" below (P4-V6).

| ID | Capability (what the person sees) | 1.22 code | Platform | Upstream 2.1.1 | Target | Acceptance check on the Dev build | Phase / Size / Risk |
|---|---|---|---|---|---|---|---|
| A-01 | Tool switches: four switches turn each tool on or off; a change reaches the running engine | `MittrCraftToolsSettings.tsx`, `settings-helpers.js`, `agent-tool/runtime.js` | local | has switches for control/web/memory/notify and "Run through Code Mode" | mittr-opencode plugin registers `mittrcraft_computer`/`mittrcraft_chrome` with `codemode:false`; switches in a mittr settings page or extension settings | Turn Chrome off: within 5 s a new turn's tool list (ask the agent "list your tools") has no Chrome tool; turn on: it is back | 4 / S / two plugin sources (upstream's and ours) must not both offer a browser |
| A-02 | `session.list/create/send/fork/status/messages` (agent, CLI, voice) | `actions.js`, `service.js` (renamed upstream) | local | **yes**, plus `session.link`; agents use `returnResult` instead of `wait` | upstream; voice adapts to the 2.1.1 contract | Ask an agent "create a session in this project that writes hello.txt": a new session appears and runs | 4 / S (verify) / voice relied on `wait` being stripped |
| A-03 | `projects.list`, `models.list` | same | local | **yes** | upstream | Ask "which projects are configured?": the answer lists them | 4 / S (verify) / none |
| A-04 | `schedule.list/create/run/delete/toggle` (+`schedule.status` CLI only) | same | local | **yes** | upstream | Ask "schedule a daily 09:00 task that says hi with model <Mittr agent>": it appears under Scheduled tasks and `schedule.run` runs it | 4 / S (verify) / scheduled runs must use a Mittr model |
| A-05 | `browser.open` with mobile/tablet/desktop sizes | `actions.js` (`MITTRCRAFT_WEB_ACTION_DEFINITIONS`) | local | **yes** (same action) | upstream | Ask "open http://localhost:<dev server> in the browser panel at mobile size": panel opens at 375-wide layout | 4 / S (verify) / none |
| A-06 | `browser.snapshot` (text, elements, page errors) | same | local | **yes** | upstream | Ask "what errors does the page log?" on a page with a console error: the agent quotes it | 4 / S (verify) |
| A-07 | `browser.click` by selector or visible label | same | local | **yes** | upstream | Ask "click Sign up": the panel navigates | 4 / S (verify) |
| A-08 | `browser.type` (+Enter) | same | local | **yes** | upstream | Ask "search for mittr in the search box": results page loads | 4 / S (verify) |
| A-09 | `browser.scroll` | same | local | **yes** | upstream | Ask "scroll to the footer": footer in view | 4 / S (verify) |
| A-10 | `browser.back` / `browser.forward` | same | local | **yes** | upstream | Ask "go back": previous page | 4 / S (verify) |
| A-11 | `browser.inspect` (computed styles) | same | local | **yes** | upstream | Ask "what font size is the h1?": a px value matching devtools | 4 / S (verify) |
| A-12 | `browser.resize` (device sizes) | same | local | **yes** | upstream | Ask "show it at tablet size": panel relays out | 4 / S (verify) |
| A-13 | `browser.capture`: saved in the project **and the model sees the image** | `service.js`, `agent-tool/runtime.js` (`c22c40fe5`), `screenshots.js` (`.mittrcraft/screenshots/`) | local | saves the file and returns the path only; folder `.openchamber/screenshots/` | our tool result must carry the image as content: hook in `agent-tool/runtime.js` (new upstream file) or our own `mittrcraft_web` wrapper | Ask "capture the page and tell me the button colour": a PNG appears under `<project>/.openchamber/screenshots/` and the answer names the colour without opening the file | 4 / M / image content shape in OpenCode 2; Q6 folder name |
| A-14 | Browser panel for the person: tabs, comment on the page → chat, dev-server preview, crash recovery | upstream `ui/lib/browser/*` (unchanged in 1.22) | local | **yes** | upstream | Open two tabs; select an element and comment: the comment lands in the composer with a screenshot; a running dev server is offered in the panel | 5 / S (verify in walk) |
| A-15 | `chrome.open` in a Chrome session that starts from the person's chosen Chrome profile (signed-in sites stay signed in); optional visible window with a banner on every driven page; own `mc-<session>` namespace | `chrome-control.js` (`agent-browser --session --profile --headed --init-script`), `6a74bd9ae`, `15eb0469a`, `4a3717a2f` (only profile auto-chosen), `510964a11` (visible for voice) | local | **no** (upstream's browser provider is the panel or an extension, not the person's Chrome profile) | mittr-opencode plugin tool + mittr-server backend (spec §6); turn upstream's browser tool off only if both would be offered | Settings: profile "Default", visible on. Ask "open https://example.com in Chrome": a Chrome window opens with the banner, using that profile (a site already signed in in Chrome shows signed in) | 4 / M / agent-browser 0.38.1 on current Chrome |
| A-16 | `chrome.snapshot` (refs `@e1`), `chrome.read` (page as markdown) | `actions.js`, `service.js` | local | no | as A-15 | Ask "read the page": the text matches the page | 4 / S |
| A-17 | `chrome.click`, `fill`, `type`, `press`, `select`, `wait`; inputs that look like agent-browser flags are refused | `service.js` (`2e2d2fdcd`) | local | no | as A-15 | On a test form: fill name, choose an option, press Enter: the form submits. A value `--headed` is refused | 4 / S |
| A-18 | `chrome.screenshot` saved and seen by the model | `service.js`, `agent-tool/runtime.js` | local | no | as A-15 + image content (A-13) | Ask "screenshot Chrome and describe it": PNG saved, description correct | 4 / S |
| A-19 | `chrome.close`; every agent Chrome closes on app quit | `service.js`, `shutdown-runtime.js` (`closeBrowserSessions`) | local | no | mittr-server on shutdown (plugin context needs a shutdown hook) | Open Chrome via the agent, quit the app: no `agent-browser`/Chrome child of the app remains | 4 / S / shutdown hook in plugin context |
| A-20 | `chrome.do`: give a goal; MittrCraft works through the page step by step (click/fill/choose) until done, a question for the person, stop, the same step three times, or `maxSteps` (default 15, max 40); returns every step taken | `mittr-browser-step/service.js`, `service.js` (`73a8b71c6`) | `POST /desktop/browser/next-step` (main and develop) | no | mittr-server + plugin tool | Ask "in Chrome, on the test form, fill name Somchai and submit using chrome.do": the result lists the steps and ends "done"; with a goal missing a needed value it stops with a question | 4 / M / platform decision model availability on dev |
| A-21 | Chrome site approvals: first use of a site raises the engine's permission prompt (Allow once / Always / Reject); Always saves the host; the grant is per session; a removed site asks again; auto-accept never answers it | `chrome-approvals.js` (`CHROME_PERMISSION = 'mittrcraft_chrome'`), plugin `context.ask`, `permission-auto-accept/runtime.js`, `GET /api/mittrcraft/chrome/profiles`, `DELETE /api/mittrcraft/chrome/approved-hosts/:host` | local | no; 2.1.1 has permission modes ask/safety/auto | plugin tool (prove `context.ask` on OpenCode 2) + hook 4 (A-30) | Ask Chrome to open example.com: a prompt names example.com; Allow once: opens; new session, same site: asked again; choose Always: Settings lists example.com; remove it there: asked again | 4 / M / `context.ask` on OpenCode 2 |
| A-22 | Chrome settings: enable, Chrome profile picker (lists the person's Chrome profiles), visible window, allowed-sites list with Remove | `MittrCraftToolsSettings.tsx` (`e5333b8ca`, `badde7dac`) | local | no | mittr-ui settings page or built-in extension settings page | Change the profile, restart the app: still chosen; remove a site: gone from settings and `settings.json` `mittr.agentChromeApprovedHosts` | 4 / S |
| A-23 | `computer.list_apps` (running and installed apps) | `computer-control.js` (cua-driver), `9c7c500d2` | local | no | plugin tool `mittrcraft_computer` + mittr-server backend | Ask "which apps are running?": list includes Finder and MittrCraft Dev | 4 / S |
| A-24 | `computer.open_app` (macOS `open -a`, no OS grant needed) | `service.js` (`c424dbc1a`) | local | no | as A-23 | Ask "open Calculator": Calculator launches | 4 / S |
| A-25 | `computer.bring_to_front` | `computer-control.js` | local | no | as A-23 | With Calculator behind: ask "bring Calculator to the front": it is frontmost | 4 / S / needs the Accessibility grant on CuaDriver.app |
| A-26 | `computer.screenshot` saved and seen by the model | `computer-control.js`, `agent-tool/runtime.js` | local | no | as A-23 + A-13 | Ask "take a screenshot of my desktop and say what is open": PNG saved as `desktop-*.png`, answer correct. Without the Screen Recording grant: a clear error naming the missing grant | 4 / S / TCC grants |
| A-27 | Bundled drivers: `agent-browser` 0.38.1 (Apache-2.0) and `cua-driver` 0.28.2 (MIT, shipped as `CuaDriver.app`, so macOS asks for Accessibility/Screen Recording under "CuaDriver"); third-party notices | `electron/scripts/prepare-agent-browser.mjs`, `prepare-cua-driver.mjs`, `resources/{agent-browser,cua-driver}`, `THIRD_PARTY_NOTICES.md`, `scripts/generate-third-party-notices.mjs`; env `MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR`, `MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR` | GitHub release downloads at build time | no | our build script (`scripts/mittr/build-desktop.mjs`) + `brand/electron-builder.*.json` `extraResources`; licences on the licences screen | `ls "MittrCraft Dev.app/Contents/Resources"` shows both drivers; `--version` of each prints the pinned version; the licences screen lists both | 4 / S / brand-leak allowlist for "CuaDriver" in the OS prompt |
| A-28 | `jira.get_issue` by key, through the person's saved Jira connection | `mittr-work/service.js` (`readLive`), `actions.js`, `9c7c500d2` | `GET /desktop/jira/issues/:key` (main and develop) | no | plugin action on `mittrcraft` (or a separate `mittr` tool) + mittr-server | Ask "read MRKB-<n>": answer quotes its summary and status | 4 / S |
| A-29 | `plane.get_issue` by link or key (a Plane link is a sign-in page to a plain fetch, so this reads it properly) | `mittr-work/service.js`, `7da646ae4` | `GET /desktop/plane/issues?ref=` (main and develop) | no | as A-28 | Paste a Plane work-item URL and ask "what does this card ask for?": answer quotes its name and state | 4 / S / multi-workspace lookup on prod (Q3) |
| A-30 | Never auto-accept: the Chrome sign-in question is always left for the person, whatever the session's permission mode | `permission-auto-accept/runtime.js` (`5d7e6df53`) | local | no list; 2.1.1 `auto` mode also tells clients to hide the request (`isPermissionAutoAnswered`) and `safety` asks a classifier | hook 4 (new upstream file) covering **both** `replyOnce` and `isPermissionAutoAnswered`, and the `safety` path | Set the session to Auto, ask for Chrome on a new site: the prompt still shows and waits; same in Safety mode | 4 / S / two code paths |
| A-31 | One action contract shared by CLI, agent tools and voice; HTTP `POST /api/mittrcraft/control` | `mittrcraft-control/routes.js`, `actions.js`, `bin/lib/cli-control.js` | local | **yes** at `POST /api/openchamber/control` with the 2.1.1 action set | upstream; our Chrome/computer/Jira/Plane/voice actions are registered by mittr-server next to it, not inside upstream's file | `curl -X POST :57133/api/openchamber/control -d '{"action":"session.list","input":{}}'` (with the UI auth header) lists sessions | 4 / S / no registration API for extra actions: may need a hook or a parallel route |
| A-32 | `mittrcraft` CLI: `serve`, `session`, `schedule`, `models`, `projects`, `control`, `tunnel`, `connect-url`, `logs`, `startup`, `status`; used for hosted web | `packages/web/bin/*` (rename only) | local | **yes** as `openchamber` | upstream CLI; command name is Q4 | `node packages/web/bin/cli.js session list --port 57133` lists the Dev app's sessions | 5 / S / naming |
| A-33 | Agent never types passwords; stops and names the site when a sign-in page appears | tool description in `agent-tool/runtime.js` | local | n/a | plugin tool description | Ask Chrome to log in to a site not signed in: the agent stops and names the site | 4 / S |

Not in 1.22, so not to be tested: clicking or typing into other desktop apps (`computer.*` is read, launch and activate only), and any Chrome extension or native-messaging bridge (Chrome is driven by the bundled `agent-browser` CLI). 2.1.1 adds `openchamber_memory`, `openchamber_notify`, `file.open`, `session.link` and browser-provider extensions; whether to offer them is Q5.

---

## 6. Phase 5: goal mode, UX extras, VS Code, mobile, `.mittr` notice, polish

### P5-01 Goal mode
- **Sees/does**: a goal keeps a session working until the objective is verifiably done; 1.22 judged each criterion from the tool record with a Mittr model and showed the criteria and what was still missing.
- **1.22 code**: `web/server/lib/session-goal/{checks,contract,evidence,judge,structured}.js`, `runtime.js` (349 changed lines), `mittr-goal-judge/service.js`; UI `chat/SessionGoalCriteria.tsx`, `SessionGoalDialog.tsx`, `lib/sessionGoalIntro.ts`, `sessionGoalMetadata.ts`, `sync/session-ui-store.ts`.
- **Platform**: `POST /desktop/goal/judge` (main and develop).
- **Upstream 2.1.1**: **yes**, its own goal loop with a progress check by its classifier or the small model (`SessionGoalCheckerField`).
- **Target**: decision 1: adopt upstream's, point its check at a Mittr model, measure with the 4-goal set used for platform PR #204 (criteria judged with another criterion's reason; whether a thin deliverable is sent back). Port ours as a server-plugin only if upstream's is worse.
- **Accept**: run the 4-goal set on the Dev build and on 1.22 Dev; record both counts in a note; the owner reads the comparison.
- **Phase**: 5 / M (L if ours must be ported) / upstream's check may not accept a Mittr model.

### P5-02 Activity timeline and readable Raw Messages
- **Sees/does**: the context sidebar shows the session's work as a timeline with subagents nested under the step that started them; Raw Messages shows each message's shape instead of grey bars.
- **1.22 code**: `layout/ActivityTimeline.tsx`, `ContextSidebarTab.tsx` (206 changed lines), `rawMessagePreview.ts`.
- **Upstream 2.1.1**: has a Work Status panel and extension `statusSection`; no timeline.
- **Target**: decision 4: a built-in Work Status section extension if it can read the session's parts; else hook 22 (`ContextSidebarTab.tsx`, new file). Raw Messages lives in the same file.
- **Accept**: run a session that spawns a subagent: the timeline shows the parent step with the subagent's steps indented under it, in order; open Raw Messages: each message shows role, parts and sizes.
- **Phase**: 5 / M / extension sandbox may not see message parts.

### P5-03 Sidebar on either edge
- **Sees/does**: Settings → Appearance → Sidebar: left or right. On the right, the session list, its resize handle and borders mirror; the window controls stay in the top-left corner and the toggle icon mirrors; works on desktop, VS Code and the iPad layout. Settings search finds it.
- **1.22 code**: `useUIStore.ts` (`sidebarSide`), `MittrCraftVisualSettings.tsx`, `layout/{MainLayout,Sidebar,SidebarTopBar,TitlebarLeftControls,Header,VSCodeLayout}.tsx`, `apps/MobileApp.tsx`, `lib/settings/search.ts` (`3ae5c8fef`).
- **Upstream 2.1.1**: no.
- **Target**: decision 4: hooks 19 (`MainLayout.tsx`) and 20 (`useUIStore.ts`). **1.22 edits five more files** for borders, resize direction, titlebar reservation, VS Code and iPad; a one-call-site hook in MainLayout alone will not mirror them. See Q1.
- **Accept**: choose Right: list on the right, drag its handle left widens it, traffic lights untouched and clickable, header title not under the controls; collapse/expand works; VS Code panel and the iPad web layout (1024 px) mirror too.
- **Phase**: 5 / L / up to 7 upstream files.

### P5-04 Markdown list continuation
- **Sees/does**: in the composer, Shift+Enter (or Enter on mobile) after a list item starts the next item (`- `, `1.` → `2.`, `- [ ]`); on an empty item it ends the list.
- **1.22 code**: `chat/composer/listContinuation.ts`, `ChatInput.tsx`.
- **Upstream 2.1.1**: no.
- **Target**: hook 21 (`ChatInput.tsx` keydown extension point, one call site).
- **Accept**: type `1. a`, Shift+Enter: `2. ` with the caret after it; Shift+Enter on the empty `2. `: the marker is removed; with an autocomplete popup open, nothing is inserted.
- **Phase**: 5 / S / hottest upstream file.

### P5-05 MittrCraft themes as default
- **Sees/does**: default light and dark themes use the MITTR Studio palette.
- **1.22 code**: `lib/theme/themes/mittrcraft-{dark,light}.json` (`21dac0918`, `bb469fc0c`).
- **Upstream 2.1.1**: theme JSON in `<dataDir>/themes/` and a theme catalog.
- **Target**: theme JSON shipped by mittr-ui/mittr-server into `themes/`; default chosen in settings.
- **Accept**: fresh install: Appearance shows the MittrCraft theme selected; colours match 1.22 side by side.
- **Phase**: 5 / S / none.

### P5-06 IBM Plex as the default fonts
- **Sees/does**: UI in IBM Plex Sans and code in IBM Plex Mono by default, matching MITTR Studio; both offered in the font pickers.
- **1.22 code**: `lib/fontOptions.ts`, `@fontsource/ibm-plex-*`.
- **Upstream 2.1.1**: no IBM Plex option; default "system".
- **Target**: mittr-ui overlay CSS and font files; adding picker entries needs `fontOptions.ts` (new file) unless the theme can set the font.
- **Accept**: fresh install: computed `font-family` of chat text starts with "IBM Plex Sans", code blocks "IBM Plex Mono".
- **Phase**: 5 / S / picker entries may cost a hook.

### P5-07 Design-system shape
- **Sees/does**: buttons with a light sheen and elevation, rounder radii, dialogs with a shadow, adjusted type scale.
- **1.22 code**: `styles/design-system.css`, `typography.css`, `lib/theme/cssGenerator.ts`, `lib/typography.ts`, `types/theme.ts`, `components/ui/{button,dialog}.tsx`.
- **Upstream 2.1.1**: no.
- **Target**: theme tokens + mittr-ui overlay CSS (spec: no CSS patches).
- **Accept**: side-by-side screenshots of a dialog and primary button against 1.22.
- **Phase**: 5 / M / Tailwind class overrides from outside.

### P5-08 Readable small text (contrast)
- **Sees/does**: muted text is no longer faded with opacity tiers, so light theme meets AA.
- **1.22 code**: `615fa13be`, `00b09bce1`: opacity classes removed in about 30 upstream components (ToolPart, toolRenderers, QuestionCard, Header, settings pages, dialogs).
- **Upstream 2.1.1**: still uses opacity tiers.
- **Target**: overlay CSS mapping the faded `text-muted-foreground/NN` classes to full muted colour, or theme tokens. No source patches.
- **Accept**: light theme, run an automated contrast check (axe) on chat with a tool call, Settings → Tunnel and a session dialog: no AA failures on small text.
- **Phase**: 5 / S / selector coverage after each upstream update.

### P5-09 `.mittr` folder copy notice
- **Sees/does**: opening a project that has a `.mittr/` folder shows a one-time notice offering to copy it to `.opencode/` (agents, commands, skills, plans). Nothing is moved or deleted.
- **1.22 code**: engine patch (reads `.mittr` first, `mittr.json`/`mittr.jsonc`).
- **Upstream 2.1.1**: `.opencode` only.
- **Target**: decision 2: mittr-ui notice + mittr-server copy route. Also copy `mittr.json(c)` → `opencode.json(c)` (the 1.22 engine read these too).
- **Accept**: project with `.mittr/agents/x.md`: notice once; Copy: `.opencode/agents/x.md` exists, `.mittr/` untouched; reopen: no notice; the agent `x` is usable.
- **Phase**: 5 / S / none.

### P5-10 VS Code extension, branded
- **Sees/does**: the VS Code extension is "MittrCraft", uses MittrCraft's own engine home (not the developer's personal OpenCode), and has no engine-upgrade action.
- **1.22 code**: `packages/vscode/package.json`, `src/engine-home.ts` (re-exports `web/server/lib/opencode/home.js`), `quotaProviders.ts`, `skillsCatalog.ts`, `opencodeAuth.ts`, `opencodeConfig.ts`, `bridge-*.ts`, `webview/main.tsx`, `webviewHtml.ts` (logo).
- **Upstream 2.1.1**: unbranded; `quotaProviders.ts` reads `~/.local/share/opencode`.
- **Target**: spec §6: package-time rewrite of `package.json` fields and icon; engine home via env in the extension host; anything needing a source edit counts toward the hook cap.
- **Accept**: build the VSIX, install in a clean VS Code profile: the activity bar and panel say MittrCraft; open a project, chat: `~/.local/share/opencode` mtime unchanged; no "upgrade engine" command in the palette.
- **Phase**: 5 / M / engine home in the extension host. Note: 1.22's VS Code extension has no Mittr sign-in or Mittr models of its own (checked).

### P5-11 Mobile app, branded
- **Sees/does**: the iOS/Android app is MittrCraft (`com.mittrcraft.app`, `MittrCraftWidget`, `MittrCraftNotificationService`), with Mittr icons and splash; pairing and every Mittr feature come from the desktop it connects to; sidebar side applies on iPad.
- **1.22 code**: renamed `packages/mobile/**`; icons and splash **only on `origin/feat/brand`** (`034a5829e`, `52ef62f00`: Android mipmaps and splashes, iOS `AppIcon-512@2x.png`, `Splash.imageset`, `MobileConnectionWelcome.tsx` logo).
- **Upstream 2.1.1**: unbranded; the loading screen shows upstream's cube (gate §5).
- **Target**: package-time rewrite of `capacitor.config.ts`, native ids and assets into the build output (spec §6).
- **Accept**: build the iOS simulator app: name, icon and splash are MittrCraft; pair with the Dev desktop by QR: sessions list and a chat with a Mittr agent work; no "OpenChamber" on any screen.
- **Phase**: 5 / M / native project renames at package time.

### P5-12 DMG background
- **Sees/does**: the installer window has the Mittr background.
- **1.22 code**: only on `origin/feat/brand` (`packages/electron/resources/dmg-background.png`, `28c5b1f8e`).
- **Target**: `brand/electron-builder.*.json` `dmg.background`.
- **Accept**: open the built dmg: background shown, app and Applications icons placed on it.
- **Phase**: 5 / S / none.

### P5-13 No engine-update setting or lookup
- **Sees/does**: no "Show engine update notifications" setting, and the app does not look up new engine versions.
- **1.22 code**: `41d42f18b`.
- **Upstream 2.1.1**: setting present; `/api/opencode/upgrade-status` calls npm (gate U1).
- **Target**: hide the setting through settings-registry visibility or the visible-strings step; switch the lookup off by env if upstream has one, else a hook.
- **Accept**: Settings → General → Engine CLI shows no update setting; `lsof -i` over the first 2 minutes shows no `registry.npmjs.org` connection.
- **Phase**: 5 / S / may need a hook.

---

## 7. Cross-cutting things that are easy to forget

| ID | Item | 1.22 | 2.1.1 / where it goes | Check |
|---|---|---|---|---|
| C-01 | Settings pages 1.22 added or changed | Usage (Mittr first, P2-10), MittrCraft → Tools (A-01, A-22), Voice (P4-V4), Integrations → Work tracking (P3-05/06), Providers switch (P2-08), Appearance → Sidebar (P5-03), About sign-out (P2-04), settings search entries | each row above | Phase 5 walk opens every page |
| C-02 | Strings and i18n | Mittr strings in `quota`, `voice`, `mittr-accounts`, `plane-workspaces` i18n files: English, other 10 locales fall back to English; no Thai locale | `brand/strings` overlay (hook 14) or mittr-ui's own dictionaries | Switch UI to Japanese: Mittr strings show in English, nothing shows a raw key |
| C-03 | Brand-name in logs and engine label | "MittrCraft Engine" in server logs and engine labels | visible-strings step | leak scan |
| C-04 | Deep links | `mittrcraft://auth/callback` (sign-in), `mittrcraft://connect` (pairing) and the Dev scheme | hook 6 registry + phase 1 scheme | P2-01, and pair a phone with a `mittrcraft-dev://connect` link |
| C-05 | Mini Chat | gated by Mittr sign-in, same audit note | hook 10 (done) | P2-01 |
| C-06 | Tray, notifications | tray glyph from the "m" of the mark; notification titles say MittrCraft | phase 1 brand | phase 5 walk |
| C-07 | Scheduled tasks and loops | no Mittr change besides being reachable from tools and voice | upstream | A-04; a scheduled run must use a Mittr model under P2-16 |
| C-08 | Env flags | `MITTRCRAFT_BROKER_URL` (build time), `MITTRCRAFT_UPSTREAM_URL` (unpackaged only), `MITTRCRAFT_APP_FLAVOR`, `MITTRCRAFT_ENGINE_HOME`, `MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR`, `MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR`, `MITTR_AD_*` (9 variables, P2-17/18); renamed upstream ones `MITTRCRAFT_*` | product files carry flavor values; upstream names for upstream flags (`OPENCHAMBER_*`); hosted-web docs must list the AD/Entra names | release notes list them |
| C-09 | Engine-home isolation in server helpers | 1.22 pointed quota auth reading, skills install, skill listing, `auth.json` at the engine home | 2.1.1 `quota/utils/auth.js` and VS Code `quotaProviders.ts` still read `~/.local/share/opencode` (the developer's personal OpenCode) | With a personal `~/.local/share/opencode/auth.json` present, Settings → Usage shows no personal provider; decide hook or env |
| C-10 | Screenshot folder in projects | `.mittrcraft/screenshots/` | `.openchamber/screenshots/` (and `.openchamber/plans`, `.openchamber/project.json`) appear in repos | Q6 |
| C-11 | Settings keys | `agentChrome*`, `agentComputerToolEnabled`, `voiceStepCap`, `voiceReplyMaxChars` moved under `mittr` in phase 1 | every mittr reader must read `settings.mittr.*` | A-22, P4-V4 restart checks |
| C-12 | `fix/engine-single-instance` | not merged in 1.22 | P2-21 | P2-21 |
| C-13 | Plugin context | 1.22 wired Mittr into `server/index.js` directly | hook 1 context must grow: settings read/persist, event hub, control service, OpenCode URL + auth headers, engine refresh, shutdown callback, secret store | contract tests per item |
| C-14 | Release-only checks | prod build talks to `api.mittr.asia`; real prod-flavor launch (gate R31); `2.1.1+mittr.1` | phase 5 | spec §9 |
| C-15 | Hosted web | AD/Entra, noindex, `--ui-password`, CLI `serve` | upstream CLI + our server plugin loaded by env | Q4 |
| C-16 | Answered-by and quota retry | see P2-11 to P2-13 | | |
| C-17 | First-run start on the first Mittr agent | see P2-07 | | |
| C-18 | Dictation shortcut, upstream dictation | unchanged by 1.22 apart from the Mittr provider and quota block | upstream | P4-V1 |

---

## 8. Totals

Counted rows: P2-xx, P3-xx, P4-Vx, A-xx, P5-xx. Phase 1 rows (5) are done and not counted. A-14 and A-32 count in phase 5.

| Phase | S | M | L | Total |
|---|---|---|---|---|
| 2 (sign-in, accounts, models, quota, AD/Entra, audit) | 11 | 9 | 1 | 21 |
| 3 (My work, Jira/Plane, integrations, catalog) | 6 | 3 | 0 | 9 |
| 4 voice | 4 | 3 | 2 | 9 |
| 4 agent tools | 27 | 4 | 0 | 31 |
| 5 (goal, UX, VS Code, mobile, notice, polish) | 9 | 5 | 1 | 15 |
| **All** | **57** | **24** | **4** | **85** |

Phase 4 together: 40 rows, of which 12 agent-tool rows only need verifying because upstream 2.1.1 already has the capability (A-02 to A-12 and A-31, counted as S).

---

## 9. Already covered by upstream 2.1.1 (configure or verify, do not port)

- Session, project, model and schedule control for agents and the CLI (A-02, A-03, A-04, A-31, A-32).
- The in-app browser agent: `browser.open/snapshot/click/type/scroll/back/forward/inspect/resize/capture`, device sizes, tabs, comment-to-chat, dev-server preview (A-05 to A-12, A-14). Only "the model sees the capture" (A-13) is ours.
- Goal mode (P5-01, decision 1).
- Dictation and read-aloud plumbing through an OpenAI-compatible provider (P4-V1, P4-V3), pointed at the shim.
- Usage page and quota-provider registries (P2-10) once registration is hooked.
- Themes from JSON in the data dir (P5-05).
- Engine pinning through the bundled CLI (P1-05).
- Updater switched off by product config (P1-04).
- Scheduled tasks, notifications, tunnels, relay pairing, Mini Chat, message queue (used by P4-V8), permission modes (used by A-30).

---

## 10. Owner questions

- **Q1. Hook cap.** 20 of 24 upstream files are already touched. A straight port needs about 18 more (largest: sidebar side, 7 files; picker quota marks, 2; quota registries, 2; AD/Entra, 2–3). Raise the cap (to about 40), or accept reduced versions (for example sidebar side via MainLayout only, sign-out only in the account menu)?
- **Q2. Other providers.** 1.22 has a "show models from other providers" switch; the spec locks the engine to Mittr by policy. Keep the switch or drop it?
- **Q3. Plane workspaces on prod.** Several Plane workspaces need platform commit `3da0045f7`, which is on platform develop only. Release it to platform prod before the first 2.x dmg?
- **Q4. Hosted web and the CLI.** Is a hosted-web MittrCraft (AD/Entra login, `serve`) in use, and should the CLI be called `mittrcraft` (a package-time rename) or stay upstream's `openchamber`?
- **Q5. New upstream agent tools.** Offer 2.1.1's `openchamber_memory`, `openchamber_notify`, `file.open`, `session.link`, and its Linear/GitHub/GitLab issue links, or switch them off by default?
- **Q6. `.openchamber/` in repos.** 2.1.1 writes screenshots, plans and `project.json` under `<repo>/.openchamber/`. Accept the visible upstream folder name, or carry a hook to keep `.mittrcraft/`?

---

## 11. Cross-check: every file 1.22 added under `packages/*` (tests excluded)

| Added file(s) | Row |
|---|---|
| `electron/THIRD_PARTY_NOTICES.md` | A-27 |
| `electron/app-flavor.mjs`, `app-flavor-env.mjs`, `deep-link-protocol.mjs` | P1-02 |
| `electron/auth-deep-link.mjs` | P2-01 |
| `electron/secret-store.mjs` | P2-02 |
| `electron/resources/agent-browser/.gitkeep`, `scripts/prepare-agent-browser.mjs` | A-27 |
| `electron/resources/cua-driver/.gitkeep`, `scripts/prepare-cua-driver.mjs` | A-27 |
| `electron/resources/icons/splash-icon.png` | P1-01 |
| `ui/components/chat/SessionGoalCriteria.tsx`, `ui/lib/sessionGoalIntro.ts` | P5-01 |
| `ui/components/chat/composer/listContinuation.ts` | P5-04 |
| `ui/components/chat/message/AnsweredByNotice.tsx` | P2-13 |
| `ui/components/chat/message/AssistantErrorNotice.tsx`, `QuotaRetryButton.tsx` | P2-11 |
| `ui/components/layout/ActivityTimeline.tsx` | P5-02 |
| `ui/components/mittr/AuditNotice.tsx`, `MittrSignInGate.tsx`, `mittrSignInGateState.ts` | P2-01 |
| `ui/components/model-picker/mittrAgentStatus.ts` | P2-09 |
| `ui/components/sections/integrations/WorkTrackingIntegrationsSection.tsx` | P3-05, P3-06 |
| `ui/components/sections/mittrcraft/MittrCraftToolsSettings.tsx` | A-01, A-22 |
| `ui/components/sections/mittrcraft/MittrVoiceProviderNote.tsx` | P4-V4 |
| `ui/components/sections/usage/MittrUsagePage.tsx`, `mittrUsage.ts` | P2-10 |
| `ui/components/session/MyWorkDialog.tsx`, `myWorkGrouping.ts` | P3-01 to P3-04 |
| `ui/components/session/sidebar/MittrAccountMenu.tsx` | P2-03, P2-04 |
| `ui/components/session/sidebar/sidebarUserProfile.ts` | P2-17, P2-18 |
| `ui/components/ui/MittrCraftLogo.tsx`, `mittrMark.ts` | P1-01 |
| `ui/components/update/pwaInstallDedup.ts` | P1-05 (helper kept when the engine-update toast was removed) |
| `ui/components/voice-assistant/TalkButton.tsx`, `VoiceBar.tsx`, `VoiceQuotaText.tsx` | P4-V5, P4-V9 |
| `ui/hooks/useMittrVoiceReadiness.ts`, `ui/lib/voice/mittrVoice.ts` | P4-V1, P4-V3, P4-V4 |
| `ui/lib/chromeProfilesApi.ts` | A-21, A-22 |
| `ui/lib/i18n/messages/mittr-accounts.i18n.ts` | P2-03 |
| `ui/lib/i18n/messages/plane-workspaces.i18n.ts` | P3-06 |
| `ui/lib/i18n/messages/quota.i18n.ts` | P2-09 to P2-11 |
| `ui/lib/i18n/messages/voice.i18n.ts` | P4-V4, P4-V5 |
| `ui/lib/mittr-quota/answered-by*.ts` | P2-13 |
| `ui/lib/mittr-quota/{exhausted,format,resend,retry,week}.ts` | P2-11 |
| `ui/lib/mittr-quota/quota-me*.ts` | P2-09, P2-10 |
| `ui/lib/mittr-quota/speech-quota-store.ts` | P4-V2, P4-V9 |
| `ui/lib/mittrAccountsApi.ts` | P2-03, P2-04 |
| `ui/lib/mittrIntegrationsApi.ts` | P3-05, P3-06 |
| `ui/lib/mittrWorkApi.ts` | P3-01 |
| `ui/lib/theme/themes/mittrcraft-{dark,light}.json` | P5-05, P5-07 |
| `ui/lib/voice-assistant/*.ts` (9 files) | P4-V5, P4-V6, P4-V8 |
| `ui/stores/useMittrCatalogStore.ts` | P2-06, P2-08 |
| `vscode/src/engine-home.ts` | P5-10 |
| `web/public/app-icon-512.png` | P1-01 |
| `web/server/lib/dictation/mittr-session.js` | P4-V1 |
| `web/server/lib/mittr-browser-step/*` | A-20 |
| `web/server/lib/mittr-goal-judge/*` | P5-01 |
| `web/server/lib/mittr-integrations/*` | P3-05, P3-06 |
| `web/server/lib/mittr-quota/{answered-by,routes}.js` | P2-13, P2-10 |
| `web/server/lib/mittr-quota/{exhausted,service}.js` | P2-09 to P2-12, P4-V9 |
| `web/server/lib/mittr-speech/client.js` | P4-V1, P4-V3 |
| `web/server/lib/mittr-work/*` | P3-01, A-28, A-29 |
| `web/server/lib/mittr/account-store.js` | P2-03 |
| `web/server/lib/mittr/audit-{record,routes,serializer}.js`, `repository-identity.js` | P2-19 |
| `web/server/lib/mittr/auth-routes.js`, `session.js`, `sign-in-transaction.js`, `deep-link-scheme.js` | P2-01, P2-02 |
| `web/server/lib/mittr/broker-target.js`, `upstream-config.js`, `local-token.js`, `loopback-guard.js`, `shim-routes.js`, `index.js` | P2-05 |
| `web/server/lib/mittr/catalog{,-cache,-routes}.js` | P2-06, P3-09 |
| `web/server/lib/mittr/local-enablement.js`, `mcp-reconciler.js` | P3-08 |
| `web/server/lib/mittr/skill-reconciler.js` | P3-07 |
| `web/server/lib/mittr/model-refusal.js`, `response-markup.js` | P2-14 |
| `web/server/lib/mittrcraft-control/actions.js`, `service.js` (upstream's, edited past rename detection) | A-01 to A-31 |
| `web/server/lib/mittrcraft-control/chrome-approvals.js`, `chrome-control.js` | A-15 to A-22, A-30 |
| `web/server/lib/mittrcraft-control/computer-control.js` | A-23 to A-26 |
| `web/server/lib/opencode/home.js`, `home.d.ts` | P1-03, P2-03 |
| `web/server/lib/session-goal/{checks,contract,evidence,judge,structured}.js` | P5-01 |
| `web/server/lib/ui-auth/ad-auth.js` | P2-17 |
| `web/server/lib/ui-auth/entra-auth.js` | P2-18 |
| `web/server/lib/voice-assistant/*` | P4-V6 to P4-V8 |
| `web/server/lib/voice-speech/*` | P4-V1 |

Outside `packages/`: `engine/*` and `scripts/build-engine.mjs` (engine fork, retired by decision 2: P2-15, P5-09); `scripts/copy-vad-assets.mjs` (P4-V5); `scripts/generate-third-party-notices.mjs`, `THIRD-PARTY-NOTICES.md` (A-27, licences screen).

Upstream files with real 1.22 edits that are not a feature of their own: about 40 UI files whose only change is removed opacity tiers (P5-08), `package-manager.js`/`updater-feed.mjs` (P1-04, retired), engine-name log strings (C-03), `bun.lock` and `package.json` (dependencies: `ldapjs`, `@fontsource/ibm-plex-*`, VAD/ONNX).
