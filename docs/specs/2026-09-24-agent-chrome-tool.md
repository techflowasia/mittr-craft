# Agent tool: sites the user is signed in to in Chrome (`mittrcraft_chrome`)

Status: design approved in conversation; awaiting spec review
Date: 2026-09-24

## 1. Context

MittrCraft already gives agents a browser: `mittrcraft_web` drives the page in
MittrCraft's own browser panel. It is the right tool for looking at the app a
developer is building, but it is the wrong one for work on internal sites:

- It runs in the panel's own session (`persist:mittrcraft-browser`). A site is
  signed in there only if the user signed in there, and people are already
  signed in to Plane, Jira and the rest in Chrome. Signing in again somewhere
  else is the friction this design removes.
- It acts by injecting JavaScript into the page. There is no select, key press,
  wait or upload, and some React forms do not accept synthetic events.
- It needs the panel open and serves one page at a time.

[agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0, a
native Rust CLI with a daemon per session) drives Chrome through CDP with real
input, stable accessibility refs (`@e1`), markdown `read`, and can start from a
copy of an existing Chrome profile.

### What was proven on the owner's Mac (agent-browser 0.38.1, Chrome 153)

- `--profile <name>` with `AGENT_BROWSER_EXECUTABLE_PATH` pointing at the
  installed Google Chrome works while Chrome itself is running. Cookies decrypt;
  the copied `Default` profile opened `workspace.mittr.asia/engine/agents`
  signed in, `read` returned the page as markdown, `snapshot -i` returned refs.
- Cold start with a 1.2 GB profile: ~3 s. Next command in the session: ~1 s.
- The copy is a snapshot: nothing the agent does is written back to Chrome, and
  the copy is removed when the session closes.
- **`--profile` must be passed on every command of a session.** A command
  without it launches a fresh browser with no sign-in.
- Not tried: `--auto-connect` (attaching to the running Chrome) and agent-browser's
  own Chrome for Testing download. Neither is used by this design.

## 2. Goals

- An agent can read and act on a site the user is signed in to in Chrome,
  without the user signing in again anywhere.
- The user decides, once per site, whether an agent may use their sign-in there.
- The tool is separate from `mittrcraft_web`, and each tool's description says
  which one to use.

## 3. Non-goals

- Replacing `mittrcraft_web`.
- Arbitrary JavaScript (`eval`), file upload/download, network interception,
  agent-browser's `auth` vault, `chat`, or its MCP server.
- Downloading a browser. The user's installed Google Chrome is used or the tool
  reports that it is missing.
- Platforms other than macOS in the first version (mirrors `cua-driver`).
- Signing in on the user's behalf. A sign-in page is reported, never filled.

## 4. Tool surface

A third managed tool beside `mittrcraft` and `mittrcraft_web`, declared in
`packages/web/server/lib/mittrcraft-control/actions.js` as
`MITTRCRAFT_CHROME_ACTION_DEFINITIONS` and added to `MITTRCRAFT_ALL_ACTIONS`.

| Action | Inputs | Maps to |
|---|---|---|
| `chrome.open` | `url` | `open <url>` |
| `chrome.snapshot` | `selector?` | `snapshot -i`, scoped to `selector` when given |
| `chrome.read` | — | `read` |
| `chrome.click` | `ref` | `click <ref>` |
| `chrome.fill` | `ref`, `value` | `fill <ref> <value>` |
| `chrome.type` | `ref`, `value` | `type <ref> <value>` |
| `chrome.press` | `key` | `press <key>` |
| `chrome.select` | `ref`, `value` | `select <ref> <value>` |
| `chrome.wait` | `text?` or `ref?` | `wait --text <text>` / `wait <ref>` |
| `chrome.screenshot` | `label?` | `screenshot <project path>` — image attached to the result, as `browser.capture` does |
| `chrome.close` | — | `close` |

Tool description (agent-facing), in substance: use this for sites the user is
signed in to in Chrome and for work that should not take over the browser panel;
use `mittrcraft_web` to look at the app being built. Snapshot first and act on
the refs it returns. If a page asks you to sign in, stop and tell the user —
never type a password.

## 5. Architecture

```
OpenCode ──plugin──▶ POST /api/mittrcraft/agent-tool (loopback, per-child token)
                         │
                         ▼
               chrome-control.js  ──spawn──▶ agent-browser --session <id>
               (allowlist, domain              --profile <chosen>
                check, envelope)               --json <command…>
                                                   │
                                                   ▼
                                     Google Chrome (copied profile, headless)
```

- **`packages/web/server/lib/mittrcraft-control/chrome-control.js`** (new),
  modelled on `computer-control.js`: resolves the bundled binary
  (`process.resourcesPath/agent-browser`, then the dev resources dir), builds
  argv from the fixed action table only, runs it with `execFile` (no shell),
  parses `--json`, and returns the standard envelope. Every command carries
  `--session`, `--profile` and the Chrome executable path — callers cannot
  forget them (§1).
- **Session:** one agent-browser session per OpenCode session
  (`mc-<sessionID>`), so parallel sessions never share a tab. Closed on
  `chrome.close`, when the OpenCode session ends, and for all sessions when
  MittrCraft quits (`close --all`). No idle timer: an open session costs one
  headless Chrome, and the session's own end is the signal.
- **Headed switch:** off by default (headless). A setting shows the window so
  the user can watch.
- **Output bound:** `--max-output` keeps a page from flooding the context.
- **Packaging:** `packages/electron/scripts/prepare-agent-browser.mjs` vendors a
  pinned agent-browser release (starting at 0.38.1) into
  `resources/agent-browser`, wired into `package` and `extraResources` exactly
  like `prepare-cua-driver.mjs`.

## 6. Signing in: profile, per-site approval, domain fence

### Profile

Settings → the tools section lists Chrome profiles (from `agent-browser
profiles`, shown by display name, e.g. "chaiwat.tan@techflow.asia"). The user
picks one. Until they do, `chrome.open` refuses with a message telling the agent
to ask the user to choose a profile in Settings.

### Per-site approval (owner decision: ask the first time per site)

1. Before `chrome.open`, the plugin asks the server whether the URL's host is on
   the approved list.
2. If not, the plugin calls OpenCode's
   `context.ask({ permission: 'mittrcraft_chrome', patterns: [host], always: [host], metadata: { profile, url } })`
   (available in `@opencode-ai/plugin` 1.18.25). MittrCraft's existing
   permission prompt shows it: the agent wants to use your Chrome sign-in
   (profile X) on `host`.
3. Allowed → the server adds `host` to the persisted approved list and the call
   proceeds. Denied → `ask` throws and the tool returns "the user did not allow
   this site".
4. The list lives in MittrCraft's desktop settings next to
   `agentWebToolEnabled`, is shown in Settings, and each host can be removed.

### Domain fence

agent-browser's documentation says `--allowed-domains` refuses `--profile`
(verify during implementation; if they do combine, pass it as well). Either way
MittrCraft fences domains itself: after every action the server reads the current URL; if a click
or redirect has moved to a host that is not approved, the result reports it and
the next call on that host goes through the same approval as step 2.

## 7. Settings

In `MittrCraftToolsSettings.tsx`, persisted through the existing desktop
settings path (`persistence.ts`, `settings-helpers.js`):

- `agentChromeToolEnabled` — default on, like the other tools; the tool is not
  injected when it is `false`.
- `agentChromeProfile` — the chosen profile directory name; empty until chosen.
- `agentChromeApprovedHosts` — string list, removable one by one.
- `agentChromeHeaded` — default off.

## 8. Errors

Every failure is an `ok: false` envelope with a sentence the agent can act on.
Whether a page is a sign-in page is the agent's judgement from the snapshot,
guided by the tool description (§4) — the server does not guess it from words
on the page.

| Situation | Message to the agent |
|---|---|
| No Google Chrome installed | Chrome is not installed; the user must install it |
| No profile chosen | Ask the user to choose a Chrome profile in Settings |
| User denied the site | The user did not allow this site |
| Navigated to an unapproved host | The page moved to `host`; open it again to ask the user |
| agent-browser hangs or exits | The session was closed; open the page again |
| Tool call aborted | The agent-browser command is killed and the session closed |

## 9. Testing

- Unit (`chrome-control.test.js`, fake binary): action → argv for every action,
  `--session/--profile/executable` present on every command, rejection of any
  action or parameter outside the table, host approval and fence logic, every
  row of §8.
- Plugin (`runtime.test.js`): the chrome tool appears only when enabled, and
  `context.ask` is called for an unapproved host and not for an approved one.
- Walk in the dev app, with the owner's go-ahead because it borrows his Chrome
  profile: agent opens a signed-in internal site → approval prompt → allow →
  snapshot/read works → second call does not ask → a new host asks again →
  deny is refused → on a site the profile is not signed in to, the agent
  reports it instead of filling the form.
- Packaged build: the binary is present in `Contents/Resources/agent-browser`
  and the tool works from the installed app.

## 10. Open risks

- A user's profile may hold sessions to personal sites; the per-site approval
  and fence are what keep an agent to the sites the user named.
- agent-browser is young (0.x) and its flags may change; the version is pinned
  and upgraded deliberately.
- A 1.2 GB profile takes ~3 s to copy per session start; acceptable now,
  measured again if profiles grow.
