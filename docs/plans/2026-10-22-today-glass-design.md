# MittrCraft "Today" home and glass look — design

Status: draft for owner approval (22 Oct 2026). Not built.

## Intent

The owner looked at hark.com/chat and wants MittrCraft to feel like it: calm, light, an assistant that keeps track of things for you. Two parts:

1. **Glass look across the app**: a soft blurred-sky background, frosted see-through panels, very rounded pill buttons, and white bubbles for AI replies.
2. **A "Today" home page**: the first thing you see. It is a centre for your status and follow-ups: what is waiting for you, what is running, what you have to do, widgets you asked Mittr to build, and important alerts.

Success: the owner opens MittrCraft in the morning and knows from one screen what needs them, without opening rooms one by one.

## Goals

- Layout **B** (owner's pick from the draft). A full "Today" surface with:
  - a large date, plus a greeting that counts what is waiting;
  - an alert strip;
  - three glass panels:
    - waiting for you + in progress;
    - to do (Jira/Plane);
    - my widgets;
  - the chat box at the bottom.
- Glass styling on the main window and the mini-chat window, in light and dark.
- Widgets v1 as the owner accepted: you ask Mittr in chat, Mittr makes a card that pulls data, you pick how often it refreshes, and the card shows a number, a status or a short list.

## Non-goals

- Mobile and VS Code layouts (owner: not needed now).
- Theme picker changes, or user-made themes.
- Widgets made by dragging things around, or a widget store.
- Studio (web). The owner said MittrCraft first.

## Anti-goals (a failure even if it "works")

- **Anything that works today disappears or becomes hard to reach.** Owner: "ของต้องครบ ที่ทำได้ต้องไม่หาย". The sidebar, sessions, settings, My work, voice, Chrome, schedules, usage, archive and every other page stay exactly as reachable as now.
- **A button, number or promise on screen that the backend does not really back.** Standing owner rule.
- **Unreadable text on glass.** Contrast must pass WCAG AA on the busiest part of the sky.
- **Breaking the re-fork rules**: more than one new counted upstream file, Mittr words in upstream files, or a CDN font call.

## Constraints

- Upstream touch cap: 36/40 used. This design uses **one** new counted file, giving 37/40.
- Mittr code stays in `packages/mittr-ui` and `packages/mittr-server`. Upstream gets only a neutral hook (`hook(main-surface)`, a manifest entry, contract items and a neutral test).
- Tailwind does not scan `packages/mittr-ui`. All new styling is a plain CSS file imported by mittr-ui, plus inline styles. Use no utility classes that `packages/ui` does not already use.
- Fonts are bundled locally. No CDN.
- No code comments. Repo text is in English; UI strings go through the Mittr dictionary.

## How it is built (decided)

### Where Today lives: a `main-surface` slot (1 counted file)

- Add a slot named `main-surface` to `packages/ui/src/lib/product-plugins.ts`. This file is new, so it is free.
- Render `<ProductSlot name="main-surface" />` inside `<main>` in `packages/ui/src/components/layout/MainLayout.tsx`, the same way UsageStatsView is rendered (`:151-155`). This is the one new counted file.
- The same edit adds neutral `data-product-region` attributes on the shell, the main area and the column, so the glass CSS can target them.
- Today then renders inside the main area, inside every upstream provider. The sidebar, header and right rail stay visible and usable, so nothing is hidden or lost.

### When Today shows (my call)

- **On every app start**, Today shows over the main area, even when the last session was restored underneath.
- **It closes** when you open any session or draft, any upstream page (archive, usage, schedules, worktrees, spaces and so on), or type and send in its chat box. That last one opens a new room with the message.
- **"Today" button**: a new button in the sidebar footer, through the existing `sidebar-footer` slot, plus a shortcut. It brings Today back at any time.
- **Mini-chat window**: shows no Today, only the glass look.

### What each part shows, and where the data comes from

Everything comes from stores and routes that exist today, so nothing on the page is made up.

- **Greeting line.** Date and time, plus "N things are waiting for you" counted from the "waiting" list.
- **Alert strip** (only shows when there is something):
  - Mittr quota near or out, from `quotaMeStore` (`/api/mittr/quota/me`);
  - sessions that ended with an error, from `useNotificationStore` (`unseenHasError`);
  - a widget past its threshold;
  - Jira/Plane items due today or overdue.
- **Waiting for you:**
  - approvals and agent questions waiting (`useGlobalBlockingRequestsStore`, the same merge as `useTraySync.ts:292-407`);
  - finished rooms you have not opened (`useNotificationStore` unseen);
  - goals that are paused, blocked or out of budget (`getSessionGoal`).
- **In progress:**
  - busy sessions (`useGlobalSessionStatusStore`), with goal progress where there is one;
  - scheduled tasks running now.
- **To do:** your Jira/Plane items from `/api/mittr/work` (the My work data), sorted by due date. Clicking one starts a room the same way My work does (`goWork.ts`). When work tracking isn't connected, this panel shows a "connect" link to the existing settings, and nothing made up.
- **My widgets:** see the next section.
- Every row opens the real thing: the room, the approval card, the Jira item or the setting.

### Widgets v1

**How you make one.** You ask Mittr in any room: "keep an eye on the Jenkins dev build" or "watch the price of X and tell me under 11,500". Mittr calls a new tool action, `widget.create`, through the 4A action registry. The card appears on Today **switched off**, showing exactly what it will run. It starts running only after **you** press "Turn on" on Today. Mittr can also update a widget or remove it, and you can remove it from the card.

**What a widget is.** It is stored per account by mittr-server in its data folder. It has:
- a title;
- a display: a number, a status (ok, warn or fail), or a list of up to 5 lines;
- a source;
- an extract rule;
- a refresh interval, at least 5 minutes;
- an optional alert rule (above, below or equals), which also feeds the alert strip and a notification.

**Sources in v1:**
- **URL.** mittr-server fetches it with no cookies, from this Mac. A JSON path or a text pattern extracts the value. Same host fence as the Chrome tool, so no private or loopback addresses.
- **Command.** A shell command run in a chosen project folder, with a 20-second timeout, capped output and a clean environment with no tokens. It runs only after you press "Turn on". It is switched off again whenever its command changes.
- **Not in v1:** "ask the AI on a schedule", which costs quota, and MCP tool sources. The owner will add more later.

The refresh runs on the server while the app is open. Each card shows when it last updated and the last error.

### Glass look

- **Sky:** a fixed layer behind everything in the main window. It is made of CSS gradients, not an image, so it costs nothing and stays sharp. Light mode is the pale blue-grey sky from the draft; dark mode is a deep navy night sky.
- **How the glass is applied:** CSS from mittr-ui, scoped under an html class that the plugin sets.
  - It retints upstream's existing glass variables (`--oc-glass-*`, `design-system.css:21-25`).
  - It makes the sidebar, header and main panels frosted (blurred, see-through), using the `data-product-region` hooks.
  - It rounds panels and buttons more.
  - It turns AI replies into white (dark: deep grey) bubbles through a `data-assistant-bubble` attribute in `ChatMessage.tsx`, which is already counted, so free.
- **Accessibility and fallbacks:** upstream's `prefers-reduced-transparency` and `@supports not` fallbacks give solid panels. Text contrast is checked on the brightest sky spot.
- **Fonts:**
  - Body text stays the system font.
  - Headings on Today use a bundled display serif for Latin (Instrument Serif) and a bundled Noto Serif Thai subset for Thai, through a new `--mittr-font-display` variable.
  - Nothing else's font changes.

## Calls settled after the builder check (my calls)

- **"Turn on" is a person's act, enforced on the server.**
  - It is an http route that is local-only (`isLocalRequest`) and is never registered on the agent or voice surfaces of the action registry.
  - Any change to a widget's source or command, whether through `widget.update`, http or anything else, sets it back to off on the server.
  - The agent can create, update or remove a widget, but can never turn one on.
- **Widgets are a fourth Mittr tool, `widgets`.** They have their own switch in Settings → Integrations → Mittr tools, on by default. Turning it off hides the actions from agents and voice and stops every refresh.
- **Widgets are local-only, like voice.** A hosted or tunnelled runtime registers no widget routes, and its Today page shows no widget panel.
- **Widgets are stored per Mittr account.** After an account switch, the other account's widgets stop refreshing and their commands never run.
- **Today's chat box is a launcher, not a second composer.**
  - It has a project pill that defaults to the last-used project and can be changed.
  - Enter opens a new room in that project with the composer's own default model and agent, then sends the text. The flow is the same as a new draft.
  - When a send can't happen (no project, no model, or a blocked Mittr model), it shows the same reason the composer would and opens the draft with the text kept.
  - The full composer (pickers, attachments, Talk and dictation) is the one in the room.
- **The glass applies only to MittrCraft's own default light and dark themes.** If someone picks another upstream theme, the app looks exactly as upstream draws it.
- **New frosted regions get solid fallbacks.** These cover the sidebar, header and main area, under `prefers-reduced-transparency` and when `backdrop-filter` isn't supported. The CSS wins with attribute selectors on `data-product-region` plus `!important` only where the theme variables are `!important`.
- **"Scheduled tasks running now" shows only if the server reports a running state.** That would be `/api/projects/:id/scheduled-tasks` status. If it doesn't, the row is dropped; we don't fake it.
- **Widget alerts:**
  - They notify once per crossing, through the alert strip and an OS notification via upstream's notify path.
  - They don't notify again until the value goes back across the line.
- `MainLayout.tsx` uses one of the files the plan already set aside for Phase 5, so the touch count goes to 37/40 as planned.

## Left to the builder

- Exact spacing, sizes and colours inside this direction.
- The keyboard shortcut for Today, provided it doesn't clash with an upstream shortcut.
- How the extract rule is written in the widget definition.

## Open questions for the owner

None blocking. The calls marked "my call" above are mine; please check them while reading.
