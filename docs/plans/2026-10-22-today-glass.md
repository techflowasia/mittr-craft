# MittrCraft Today home and glass look Implementation Plan

**Goal:** Give MittrCraft a glass look across the main and mini-chat windows, a full-screen "Today" status-and-follow-up home page, and widgets v1 that Mittr creates and the person turns on.

**Architecture:**
- One neutral upstream hook (a `main-surface` slot in `MainLayout.tsx`, plus `data-` region and bubble attributes) lets mittr-ui render Today inside the main area, inside every upstream provider.
- Glass is a plain CSS file imported by mittr-ui, scoped under an html class that is set only on MittrCraft's default themes.
- Widgets are a fourth Mittr tool in the 4A action registry. They have a local-only, per-account store and a runner in mittr-server. "Turn on" is an http route that agents and voice can never reach.

**Tech Stack:** React 19 + zustand stores from packages/ui, plain CSS, Node (express) in mittr-server, `node --test` and `bun test`.

**Spec:** `docs/plans/2026-10-22-today-glass-design.md` (owner-approved 22 Oct 2026).

## Global Constraints

- Branch `feat/today-glass` in `/Users/techflow/Documents/mittr-craft/.worktrees/today-glass`. BASE `4b9ad7e4e`.
- Upstream touch count goes from 36/40 to exactly 37/40. The only new counted file is `packages/ui/src/components/layout/MainLayout.tsx`.
  - `ChatMessage.tsx` and `product-plugins.ts` may also be edited, because neither costs a count.
  - Every commit that touches an upstream file uses a `hook(main-surface): …` subject, an entry in `brand/upstream-hooks.json`, items in `packages/mittr-server/src/upstream-contract.{js,test.js}`, and a neutral test (no "mittr" or brand words; `node scripts/mittr/neutral-hook-tests.mjs` reports 0).
  - Run the touch check only as `node scripts/mittr/check-upstream-touch.mjs --no-write`.
- Tailwind does not scan `packages/mittr-ui`.
  - New mittr-ui styling is plain CSS (`packages/mittr-ui/src/today/today.css`, `packages/mittr-ui/src/glass/glass.css`) or inline styles.
  - A className may use only utilities that already appear in the built CSS.
- No network fetches at build or run time for fonts. Headings use the stack `ui-serif, "New York", "Noto Serif Thai", Thonburi, serif` through a new `--mittr-font-display` variable. A bundled Thai serif is a later owner decision.
- "Turn on" is a person's act, enforced on the server:
  - the route is local-only (`isLocalRequest`) and is never registered on the agent or voice surfaces;
  - any change to a widget's source sets `enabled:false` on the server.
- Widgets are local-only, like voice. A hosted runtime registers no widget routes, and its Today page shows no widget panel.
- Widgets are stored per Mittr account. After an account switch, the other account's widgets stop refreshing.
- Command widgets:
  - run in the chosen project folder;
  - have a 20 s timeout and output capped at 64 KB;
  - get an env of `PATH`, `HOME`, `LANG` only, with no tokens;
  - refresh no more often than every 5 minutes.
- URL widgets: fetched by mittr-server with no cookies, through the same host fence as the Chrome tool (`chrome-service.js`). Private, loopback and own-port hosts are refused.
- Glass applies only while the active theme ids are MittrCraft's defaults: `openchamber-light` / `openchamber-dark`, the upstream defaults, which MittrCraft does not change. Solid fallbacks apply under `prefers-reduced-transparency` and when `@supports not (backdrop-filter: blur(1px))`.
- Nothing that works today may disappear: sidebar, header, every upstream page, settings, My work, voice, Chrome and schedules all stay reachable.
- Every number or row on Today comes from an existing store or route. A row whose data isn't backed is left out.
- Testing:
  - Tests use the F9 isolation prefix with HOME/XDG in a temp dir and `MITTR*` unset.
  - `node --test` always takes `--test-timeout=60000`.
  - Never contact port 57133, the installed apps, or the real HOME data.
- No code comments. Repo text is in English; UI text goes through `packages/mittr-ui/src/strings/mittr.en.ts`.
- Owner rule (R165/R172): each task commits with targeted tests only. There is ONE whole-branch review at the end, then one fix pass. No review per task.

## Review Focus

1. **App start restores the last session underneath Today.** Expected: Today is on top. Clicking the restored session's row in the sidebar closes Today and shows that session.
2. **Mittr creates a command widget, then updates its command after the person turned it on.** Expected: the widget is off again on the server, and nothing runs until the person presses Turn on again. Pinned in Task 4.
3. **The person picks a non-default theme.** Expected: no glass, no sky, no white bubbles, and the app exactly as upstream draws it. Pinned in Task 2.
4. **`prefers-reduced-transparency`.** Expected: solid panels and readable text everywhere. Pinned in Task 2.
5. **Today's chat box with no project or no model.** Expected: the composer's own refusal reason, and the text kept in an opened draft, never lost. Pinned in Task 3.

---

### Task 1: Hook: `main-surface` slot, region attributes and the assistant bubble attribute

**Files:**
- Modify: `packages/ui/src/lib/product-plugins.ts` (add `'main-surface': Record<string, never>` to the slot props).
- Modify: `packages/ui/src/components/layout/MainLayout.tsx`, which becomes the new counted file:
  - render `<ProductSlot name="main-surface" />` inside `<main>` after the existing absolute page siblings (the pattern at `:151-155`);
  - add `data-product-region="shell"` on the root (`:112`), `"column"` on the right column wrapper, `"main"` on `<main>` (`:144`), `"sidebar"` on the Sidebar wrapper and `"header"` on the header wrapper, where the element is in this file. Don't add attributes in files outside this list.
- Modify: `packages/ui/src/components/chat/ChatMessage.tsx`: add `data-assistant-bubble` on the assistant message body container (`:890-928`), in the same commit.
- Create: `packages/ui/src/components/layout/MainLayout.product.test.tsx` (neutral).
- Modify: `brand/upstream-hooks.json` and `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- Produces: slot name `main-surface` with no props, rendered inside `<main>`; attributes `[data-product-region=shell|column|main|sidebar|header]`; `[data-assistant-bubble]`.

- [ ] **Step 1: Write the failing test.** `MainLayout.product.test.tsx` registers a neutral plugin with `slots: { 'main-surface': () => <div data-testid="surface-probe" /> }`. It asserts that the probe renders inside the `main` element, and that `[data-product-region="main"]` and `[data-product-region="shell"]` exist. A second test renders an assistant message and asserts `[data-assistant-bubble]` is present for the assistant and absent for the user.
- [ ] **Step 2: Run it and see it fail:** `cd packages/ui && bun test src/components/layout/MainLayout.product.test.tsx`.
- [ ] **Step 3: Implement the edits above.**
- [ ] **Step 4: Run the test (PASS), then the checks.** `node scripts/mittr/check-upstream-touch.mjs --no-write` must say 37 of 40, passed. `node scripts/mittr/neutral-hook-tests.mjs` must report 0 findings. Then run the contract test.
- [ ] **Step 5: Commit** `hook(main-surface): a product surface inside the main area, named layout regions and an assistant bubble marker`.

### Task 2: Glass look and the sky

**Files:**
- Create in `packages/mittr-ui/src/glass/`:
  - `glass.css`
  - `GlassSky.tsx`
  - `useGlassTheme.ts`, with `useGlassTheme.test.ts` and `glass.test.ts`
- Modify: `packages/mittr-ui/src/product-ui-plugin.tsx` (mount `GlassSky` and `useGlassTheme` in `MittrRoot`, both surfaces), `product-ui-plugin.test.ts`.

**Interfaces:**
- Consumes: Task 1's region attributes and `[data-assistant-bubble]`.
- Produces:
  - `useGlassTheme(): boolean`, true only when the active light/dark theme id is `openchamber-light`/`openchamber-dark`, read the same way upstream's theme context exposes it;
  - while true it sets `html.mittr-glass`, plus `mittr-glass-dark` in dark mode, and removes them otherwise;
  - CSS variable `--mittr-font-display`.

- [ ] **Step 1: Write the failing tests.**
  - `useGlassTheme.test.ts`:
    - default theme ids give the class `mittr-glass`;
    - a non-default id gives no class;
    - switching back re-adds it;
    - unmount removes it.
  - `glass.test.ts` reads `glass.css` as text and asserts:
    - every rule is scoped under `html.mittr-glass`;
    - a `@media (prefers-reduced-transparency: reduce)` block and a `@supports not (backdrop-filter` block exist and set opaque backgrounds for each `data-product-region`;
    - `--mittr-font-display` is defined;
    - there is no `url(http` anywhere.
- [ ] **Step 2: Run them and see them fail:** `cd packages/mittr-ui && bun test src/glass`.
- [ ] **Step 3: Implement `glass.css`:**
  - the sky: a fixed layer behind `#root`, with gradients like the approved draft; dark mode is a deep navy night sky;
  - retint the `--oc-glass-*` vars;
  - frosted regions via `[data-product-region]`;
  - larger radii on those regions and on the composer;
  - `[data-assistant-bubble]` as a white (dark mode: `#1f2430`) rounded bubble with padding;
  - out-specify the `!important` theme vars only where needed (the `html.mittr-glass:root` pattern);
  - text contrast AA on the brightest sky point, with the colour pairs listed in the test file as constants and checked by a contrast function.
- [ ] **Step 4: Run the tests (PASS) and `bun run type-check`.**
- [ ] **Step 5: Commit** `feat(mittr-ui): the glass look and the sky on MittrCraft's own themes, solid where transparency is reduced`.

### Task 3: The Today page

**Files:**
- Create in `packages/mittr-ui/src/today/`, each with a test:
  - `todayStore.ts`: open or closed; opened at start; closed by session or draft selection and by any upstream page flag;
  - `todayData.ts`: pure selectors over the upstream stores;
  - `TodayPage.tsx`;
  - `TodayLauncher.tsx`: the chat box;
  - `TodayButton.tsx`: the sidebar footer entry;
  - `today.css`.
- Modify:
  - `packages/mittr-ui/src/product-ui-plugin.tsx` (the `main-surface` slot gets `TodayPage`);
  - `packages/mittr-ui/src/sidebarFooter.ts` (add `TodayButton` first);
  - `packages/mittr-ui/src/strings/mittr.en.ts`.

**Interfaces:**
- Consumes:
  - `useGlobalSessionsStore`, `useGlobalSessionStatusStore`, `useGlobalBlockingRequestsStore`, `useNotificationStore`, `getSessionGoal`, `useSessionUIStore` (`setCurrentSession`, `openNewSessionDraft`) and `useUIStore` page flags, from packages/ui;
  - `quotaMeStore` and `fetchMyWork`/`goWork` from mittr-ui;
  - the scheduled-task status route only if it reports a running state. Check `packages/web/server/lib/scheduled-tasks` routes; if it doesn't, leave the row out and say so in the report.
- Produces:
  - `useToday(): { open: boolean; show(): void; hide(): void }`;
  - `todayData` selectors `waiting(state)`, `running(state)`, `alerts(state)`, each returning arrays of `{ id, kind, title, detail, open(): void }`;
  - a `TodayPage` prop-free component that renders a `widgets` section only when `widgetsSection` is registered through `registerTodaySection('widgets', Component)`. Task 5 fills it.

- [ ] **Step 1: Write the failing tests.**
  - `todayStore.test.ts`:
    - open after start;
    - closes on `setCurrentSession` to a different id after start, and on `openNewSessionDraft` called by the user;
    - closes when `isUsageStatsPageOpen` or `isArchivePageOpen` becomes true;
    - `show()` reopens.
  - `todayData.test.ts`, with store fixtures:
    - a permission waiting gives a `waiting` row of kind `approval`;
    - an unseen finished session gives kind `review`;
    - a goal `blocked` gives kind `goal`;
    - a busy session gives a `running` row;
    - quota `near` gives an alert;
    - an error unseen gives an alert;
    - empty stores give empty arrays (no made-up rows).
  - `TodayLauncher.test.tsx` (Review Focus 5):
    - with no project, Enter shows the composer's refusal text and opens a draft that contains the text;
    - with a project, Enter calls the new-session path with the text.
  - `TodayPage.test.tsx`:
    - the greeting counts `waiting`;
    - each row's click calls its `open`;
    - the work panel shows a connect link when not configured;
    - there is no widgets section when none is registered.
- [ ] **Step 2: Run them and see them fail:** `cd packages/mittr-ui && bun test src/today`.
- [ ] **Step 3: Implement.** Follow layout B from the approved draft: the date in `--mittr-font-display`, the greeting, the alert strip only when it has rows, then three glass panels and the launcher at the bottom. `TodayPage` positions itself `absolute inset-0` inside `<main>` through `today.css`, not utilities.
- [ ] **Step 4: Run the tests (PASS), `bun run type-check`, and `bun run lint` for @mittrcraft/ui-plugin.**
- [ ] **Step 5: Commit** `feat(mittr-ui): Today, the home that shows what waits for you, what runs, your work and alerts`.

### Task 4: Widgets on the server

**Files:**
- Create in `packages/mittr-server/src/mittr/widgets/`, each with a test:
  - `widget-store.js`: per account, saved to `<dataDir>/widgets/<accountKey>.json` through `private-file.js`;
  - `widget-sources.js`: url and command runners with their limits, and an extract by JSON path or regex;
  - `widget-runner.js`: refresh scheduling, stopping on account switch or tool switch off, and alert crossing;
  - `widget-actions.js`: the `widget.create`, `widget.update`, `widget.remove` and `widget.list` registry actions;
  - `widget-routes.js`;
  - `index.js` (`setupMittrWidgets`).
- Modify:
  - `packages/mittr-server/src/mittr/tools/registry.js` (`MITTR_TOOLS.widgets = 'mittrcraft_widgets'`, this-machine-only);
  - `packages/mittr-server/src/mittr/mittr-settings.js` (a `tools.widgets` boolean, default true);
  - `packages/mittr-server/src/mittr/index.js` (wire it, and call `accountChanged` beside `voice.accountChanged`);
  - `packages/mittr-server/src/mittr/tools/plugin-source.js`, if the agent tool list is generated there;
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`, if the upstream notify path is used.

**Interfaces:**
- Widget shape:
  ```
  {
    id, title,
    display: 'number' | 'status' | 'list',
    source: { type: 'url', url, extract } | { type: 'command', command, cwd, extract },
    refreshMinutes (>= 5),
    alert?: { op: 'above' | 'below' | 'equals', value },
    enabled: boolean,
    last?: { at, value, error }
  }
  ```
- Routes, all local-only (`isLocalRequest`) and absent on hosted:
  - `GET /api/mittr/widgets` gives `{ widgets, canChange }`;
  - `POST /api/mittr/widgets/:id/enable` and `/disable`;
  - `DELETE /api/mittr/widgets/:id`;
  - `POST /api/mittr/widgets/:id/refresh`.
- Registry actions on surfaces `agent` and `http` only, never `voice`. There is no enable action on any surface.
- Alert: when a value crosses, emit once through upstream's desktop notification path (`packages/web/server/lib/notifications`). Re-arm when it crosses back. Expose `alerting: true` in the GET.

- [ ] **Step 1: Write the failing tests.**
  - store: per-account isolation.
  - Review Focus 2: `update` that changes the source sets `enabled:false`; `update` that changes only the title keeps `enabled`.
  - There is no registry action named `*.enable` on any surface.
  - The enable route answers 403 for a non-local request.
  - The runner never runs a disabled widget, stops all of an account's widgets after `accountChanged`, and stops all after `tools.widgets=false`.
  - command source:
    - timeout at 20 s;
    - output capped at 64 KB;
    - env only `PATH`, `HOME`, `LANG`;
    - runs in `cwd`.
  - url source:
    - refuses loopback, private and own-port hosts;
    - sends no cookie header.
  - extract: JSON path, regex group, and a missing match giving `error`.
  - alert: notifies once on crossing, not again while still across, and again after crossing back.
  - hosted: no widget route is registered (404).
- [ ] **Step 2: Run them and see them fail:** `cd packages/mittr-server && node --test --test-timeout=60000 'src/mittr/widgets/*.test.js'`.
- [ ] **Step 3: Implement.** Reuse `isLocalRequest`, the account guard, the Chrome host fence and `private-file.js`. Don't write new versions of these.
- [ ] **Step 4: Run the tests (PASS), then the full mittr-server suite once with F9 isolation.**
- [ ] **Step 5: Commit** `feat(mittr-server): widgets Mittr makes and the person turns on, local and per account`.

### Task 5: Widgets on Today and the tools switch

**Files:**
- Create in `packages/mittr-ui/src/widgets/`, each with a test: `widgetsApi.ts`, `WidgetsSection.tsx`, `WidgetCard.tsx`.
- Modify:
  - `packages/mittr-ui/src/today/` (register the section);
  - `packages/mittr-ui/src/tools/MittrToolsSection.tsx`, `toolsApi.ts`, `toolsController.ts` (a widgets switch);
  - `packages/mittr-ui/src/strings/mittr.en.ts`.

**Interfaces:**
- Consumes: Task 4's routes and shape, and Task 3's `registerTodaySection`.
- Produces: none.

- [ ] **Step 1: Write the failing tests.**
  - A switched-off card shows the exact URL or command and a "Turn on" button.
  - Turn on calls the enable route.
  - A card shows its value, when it last updated and its error.
  - An alerting card is marked.
  - Remove asks for confirmation, then calls DELETE.
  - An empty list shows a one-line hint on asking Mittr.
  - On hosted (`GET` answers 404), the section is not registered.
  - The tools section shows the widgets switch and saves it.
- [ ] **Step 2: Run them and see them fail:** `cd packages/mittr-ui && bun test src/widgets src/tools`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests (PASS), `bun run type-check`, and `bun run lint` for @mittrcraft/ui-plugin.**
- [ ] **Step 5: Commit** `feat(mittr-ui): your widgets on Today, turned on only by you, and their switch in Mittr tools`.

### Task 6: Integration, one review, one fix pass, gate

- [ ] **Step 1: Run every check on the branch once**, each exiting 0:
  - mittr-server suite;
  - mittr-ui suite;
  - `scripts/mittr` tests;
  - `bun run lint`;
  - `bun run type-check`;
  - the touch check (37/40);
  - neutral hooks;
  - one network-denied `--flavor dev --gate` build with its leak scan.
- [ ] **Step 2: One whole-branch review of `4b9ad7e4e..HEAD`** against the spec and this plan.
- [ ] **Step 3: One fix pass**, then rerun Step 1.
- [ ] **Step 4: Gate walk with the owner** on the gate build:
  - Today on start;
  - every row opens the right thing;
  - every upstream page is still reachable;
  - glass in light and dark, and off on another theme;
  - reduced transparency;
  - Mittr creates a widget, the owner turns it on, it refreshes, then an update turns it off;
  - write the results to `docs/plans/2026-10-22-today-glass-gate.md`.
