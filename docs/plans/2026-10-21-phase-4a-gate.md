# Phase 4A gate: the Dev build (Parts A and B)

Branch `rebase/upstream-2.1.1`. This note records **Part A** of the phase 4A gate (every A row that runs headless, on a loopback stub, with a throwaway Chrome and a stub desktop driver) and **Part B** (the owner at the keyboard: the dev platform, the owner's real Chrome profile, the real desktop driver and real TCC grants), under "Part B results".

| Run | When (22 Oct, +07) | Build HEAD | Platform | Who |
|---|---|---|---|---|
| **Part A** | 01:49–02:30 | `4fb01726c` (app built 01:49–01:52) | loopback stub (`scripts/mittr/stub-platform.mjs`), accounts SA and SB | headless, no owner |
| **Part B** | 07:23–10:05 | `f01be5ae3`, then `d064dba47` for the desktop rows | the dev platform, account A | the owner at the keyboard |

The commit before this note adds the gate's test helpers: loopback test pages (`scripts/mittr/stub-pages.mjs`), a stub `cua-driver` (`scripts/mittr/stub-cua-driver.mjs`), and scripted browser steps, Jira and Plane answers, tool-calling phrases and image recording in the stub platform. None of them is in the app. The stub `open` is not built (F23): `computer.open_app` runs `/usr/bin/open` by absolute path, so A-24 is Part B only.

The evidence (screenshots, logs, JSON, `ps` and `lsof` samples) is kept outside the repository. It holds no token value.

## Verdict

| Group | PASS / FAIL / NOT RUN | Notes |
|---|---|---|
| Hygiene (build and static checks) | 9 / 1 / 0 | The gate's build exited 1 at the leak scan (finding 1); the app itself was complete and was used. Fixed after the gate: the build at `641976172` exits 0, "0 unexplained". |
| Upstream tools (verify only) | 11 / 1 / 0 | `browser.scroll` moves the page but answers a 20 s timeout (finding 2). |
| Switches | 2 / 0 / 0 | |
| Images | 1 / 0 / 0 | The engine re-encodes a large capture before the model sees it (finding 3). |
| Desktop (stub driver) | 4 / 0 / 1 | A-24 is NOT RUN by ruling F23. |
| Chrome | 9 / 0 / 0 | |
| chrome.do | 2 / 0 / 0 | |
| Approvals | 7 / 0 / 0 | |
| Work lookups | 2 / 0 / 0 | |
| Settings | 4 / 0 / 0 | |
| Drivers | 1 / 0 / 0 | |
| Accounts | 3 / 0 / 0 | |
| Hosted | 2 / 0 / 0 | |
| Secrets | 3 / 0 / 0 | R155: engine shell children **do** see the engine password (finding 4). |
| Egress | 3 / 0 / 0 | Only phase 3's known upstream peers; agent Chrome made 0 non-loopback connections. |
| Isolation | 12 / 2 / 0 | Both FAILs are writes no test action caused (findings 11 and 12). |
| **Total** | **75 / 4 / 1** | 80 rows |

Part B: **35 / 8 / 3** (46 rows); see "Part B verdict".

No Mittr feature check failed in Part A. The four FAILs are: the leak scan on an upstream error-class name in our packed server plugin (finding 1), upstream's `browser.scroll` answer (finding 2), and two isolation rows caused by the installed apps and by an unattributed keychain write.

## Method

- **Launches.** Three desktop launches of `packages/electron/dist/mac-arm64/MittrCraft Dev.app/Contents/MacOS/MittrCraft Dev`, started directly and quit with `kill -TERM <pid>` after checking the binary path:
  - A1 on a fresh HOME `p4.Pf9Y`, A2 a relaunch on the same HOME (A-22), A3 on a fresh HOME `p4.E8Nb`;
  - `env -i`, every `XDG_*` and `TMPDIR` inside the temp HOME, `OPENCHAMBER_DESKTOP_USER_DATA_DIR=<HOME>/userData`, `--use-mock-keychain`, `CFFIXED_USER_HOME=<HOME>` (F20, R150), `MITTRCRAFT_BROKER_URL` at the loopback stub, `MITTRCRAFT_SHIM_LOG=1`;
  - a seeded `desktopLocalPort` 57461, so the app never used 57133.
- **Temp HOME path.** The temp HOMEs are `/tmp/p4.XXXX`, not `$TMPDIR/p4.XXXX`: agent-browser's socket is `<HOME>/.agent-browser/namespaces/mittrcraft-dev/run/mc-<10 hex>.sock`, which is 121 bytes under a `$TMPDIR` HOME and over the 103-byte limit. Under `/tmp` it is 76 bytes (Task 7 used the same deviation). A HOME up to about 39 characters fits, so `/Users/<name>` homes are fine.
- **Agent Chrome.** The packed `agent-browser` (A-27) drove Google Chrome 155 headless on a seeded throwaway profile (`Default / Gate Throwaway`, `translate.enabled: false`, plus `Profile 1 / Gate Second` for A-22). `MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR` pointed at a small wrapper that runs the packed binary, and only for the `profiles` call wraps it in `sandbox-exec` denying the real `~/Library/Application Support/Google`, `~/Library/Preferences/com.google.*`, `~/Library/Caches/Google` and `~/.agent-browser` (Task 2). Chrome itself cannot run under `sandbox-exec`, so nothing else was wrapped. `AGENT_BROWSER_ARGS` carried Task 2's quiet flags and the R145 refusing loopback proxy (`--proxy-server=127.0.0.1:57531`); `chromeHeaded` stayed `false` for every Chrome call.
- **Desktop driver.** `MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR` pointed at a wrapper for `stub-cua-driver.mjs`, the only candidate (F24). Each launch first checked that the wrapper is executable and answers `cua-driver 0.28.2-stub`. The real `cua-driver` was run only with `--version` (A-27). No screenshot of the real desktop was taken and no TCC prompt was raised.
- **Turns.** Prompts went through the app's own API (`POST /api/session/:id/prompt`), and the stub model answered fixed phrases with tool calls (`chrome open <url>`, `chrome do <goal>`, `computer list apps`, `computer screenshot`, `read jira <key>`, `read plane <ref>`, `capture the page`, `list your tools`, `call <tool> <action> <json>`, `raw <tool> <json>`). The stub records the tools offered and the sha256 of every image in each request, never a header.
- **Approvals.** Every approval card was answered by a click in the window through its DevTools port, logged with a timestamp before the click (F38). The card text was read from the DOM before the click.
- **Sign-ins.** Through the app's API, with `curl` taking the stub's redirect and the callback posted back to the app. No browser was used.
- **Hosted.** `npm pack --ignore-scripts` of `packages/mittr-server`, unpacked beside a sibling `web` with only `ldapjs` linked (the phase 3 R-F7 layout), run as `node --import <connect guard> bin/mittrcraft.mjs serve --foreground --port 57471` on its own fresh HOME. The engine was the packed `opencode` under `sandbox-exec` with outbound limited to loopback.
- **Guard.** Every call to the app, its DevTools port, the stub and the hosted server first checked that the listener was the test PID or a descendant (R46).

## Part A results

### Hygiene (Step 1)

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| H1 | Dev build, leak scan, drivers and notices | `node scripts/mittr/build-desktop.mjs --flavor dev` | **exit 1** at step 8/8, 01:49:09–01:52:39. `1404 files: 255 translation keys, 4126 translated, 129 allowlisted, 1 unexplained, 0 unused allowlist entries`. The hit: `app.asar/product-plugins/mittr-server.mjs` holds `"OpenChamberControlError"` (from `packages/mittr-server/src/mittr/tools/control-routes.js`, `UPSTREAM_CONTROL_ERROR`). The app bundle was complete; the driver and notice checks were run separately (A-27). After the gate, at `641976172`: exit 0, `0 unexplained`, "the brand-leak scan passed" | FAIL at the gate (finding 1); passes after the gate |
| H2 | Upstream touch | `node scripts/mittr/check-upstream-touch.mjs --no-write` | `35 of 40`, "upstream touch check passed", nothing unlisted, nothing stale | PASS |
| H3 | Type-check | `bun run type-check` | exit 0 | PASS |
| H4 | Lint | `bun run lint` | exit 0; 0 errors, the 5 known `packages/ui` warnings | PASS |
| H5 | Test baseline | `node scripts/mittr/test-baseline.mjs` | exit 0, "no test failure outside the baseline". Known: scripts 1, sdk 1, ui 4, vscode 4, electron 0, web 0. Three web tests flaky (failed once of two runs); one baseline entry stayed green (`server/lib/spaces/websocket.test.js`) | PASS |
| H6 | mittr-server suite | `iso bun run --cwd packages/mittr-server test` | 1319 of 1319 | PASS |
| H7 | mittr-ui suite | `iso bun run --cwd packages/mittr-ui test` | 46 of 46 test files | PASS |
| H8 | mittr-opencode suite | `iso bun run --cwd packages/mittr-opencode test` | 16 of 16 | PASS |
| H9 | Neutral hook fixtures | `node scripts/mittr/neutral-hook-tests.mjs` | 0 findings | PASS |
| H10 | Gate stubs | `iso node --test scripts/mittr/stub-pages.test.mjs scripts/mittr/stub-cua-driver.test.mjs scripts/mittr/stub-platform.test.mjs` | 19 of 19. RED first: 6 new stub-platform tests and both new files failing; GREEN after | PASS |

### Upstream tools (verify only)

All in A1, session directory = the temp project, model `mittr/stub-sa-fast`.

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-02 | Create a session that runs | `call openchamber session.create {"prompt":"create a session in this project that writes hello.txt"}` | `ok:true`, a new session in the temp project with `mittr/stub-sa-fast`, `promptDispatched:true`; its messages show the prompt and the stub's answer, then idle `succeeded` | PASS |
| A-03 | `projects.list` | `call openchamber projects.list {}` | lists `p4.Pf9Y` (`/private/tmp/p4.Pf9Y`), the temp project | PASS |
| A-04 | Scheduled task on a Mittr model | `schedule.create` `{name, prompt:"scheduled gate prompt A04-mittr", model:"mittr/stub-sa-fast", daily:"09:00"}`; `schedule.list`; `schedule.run` | created and listed (daily 09:00, Asia/Bangkok, `providerID mittr`, `modelID stub-sa-fast`). The run's session answered; the stub's record for that unique prompt carries model `stub-sa-fast`, account SA (F36: tied by the prompt the stub records). With `openai/gpt-4o`: the create is **accepted**; the run's session ends `failed` with no assistant message, the stub never saw the prompt, and nothing left loopback (finding 5) | PASS |
| A-05 | Browser panel opens at mobile size | `browser.open {url:/error, viewport:mobile}` | `opened:true`, `drivable:true`, viewport `mobile` **390 × 844** (upstream's mobile size; the brief said 375, finding 6) | PASS |
| A-06 | The snapshot quotes `/error`'s console error | `browser.snapshot` | `consoleProblems: [{level:error, message:"stub page error: widget failed to load"}]` | PASS |
| A-07 | Click "Submit" | `browser.click {text:"Submit"}` on `/form` | `clicked: html > body > form > button`, label `Submit`; Back then returned to `/form` | PASS |
| A-08 | Type with Enter | `browser.type {selector:input[name=email], value:a@b.test, submit:true}` | `ok:true`; Forward later showed `/thanks?name=Somchai&email=a%40b.test&plan=basic` | PASS |
| A-09 | Scroll to the footer | `browser.scroll {selector:"#footer"}` and `{direction:"bottom"}`, three tries | each answered `ok:false`, "The in-app browser did not respond within 20s". A snapshot right after showed `scrollY 1504` = `maxScrollY 1504`: the page **had** scrolled | FAIL (finding 2) |
| A-10 | Back and forward | `browser.back`, `browser.forward`, `browser.back` | `/form` → `/thanks?…` → `/form` | PASS |
| A-11 | `inspect` the h1 | `browser.inspect {selector:h1}` on `/style` | `font-size: 32px` | PASS |
| A-12 | Resize to tablet | `browser.resize {viewport:tablet}` | `tablet` 768 × 1024 | PASS |
| A-31 | One action contract, from the window | in the window: `fetch('/api/openchamber/control', {action:'session.list'})` and `fetch('/api/mittr/control', {action:'computer.list_apps'})` | 200 with the session list; 200 with the stub list (Finder, MittrCraft Dev, Calculator not running) | PASS |

### Switches

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-01a | The tools are offered | "list your tools" | the request offered `mittrcraft_chrome`, `mittrcraft_computer`, `mittrcraft_work`, `openchamber`, `openchamber_web` (and the engine's own tools) | PASS |
| A-01b | Chrome off, then on | `PUT /api/mittr/tools {"chrome":false}`, "list your tools"; then `{"chrome":true}` and again | off: the next turn finished 1.15 s after the switch, with no `mittrcraft_chrome`; on: 1.09 s later, `mittrcraft_chrome` back. Engine PID 62884 (started 02:10:37) the same before, between and after | PASS |

### Images

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-13 | A panel capture reaches the model (live run of the generated wrap) | `/style` open in the panel; "capture the page" | upstream saved `.openchamber/screenshots/page-….jpg` (JPEG, 1536 × 2048, 20,415 bytes); the wrap attached an image, and the stub's next request carried an `image/png` of 69,106 bytes, 1500 × 2000 (same aspect). The engine resizes and re-encodes images over 2000 px, so the sha256 differs from the file; a small capture (A-18, 13,295 bytes) arrived byte-identical | PASS (finding 3) |

### Desktop (stub driver)

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-23 | List apps | "computer list apps" | Finder (4101, running), MittrCraft Dev (4243, running), Calculator (not running) | PASS |
| A-24 | Open an app | — | not run: `/usr/bin/open` is called by absolute path (F23), so no stub can stand in; covered by Task 6's argv test; Part B step 4 | NOT RUN |
| A-25 | Bring to front | `computer.bring_to_front {app:"Finder"}`, then `{app:"Calculator"}` | Finder: `activated:true, windowVerified:true`, and the stub recorded `bring_to_front {"pid":4101}`. Calculator: "No running app named \"Calculator\"" (it is not running, because A-24 did not run) | PASS |
| A-26a | Desktop screenshot | "computer screenshot" | saved `.openchamber/screenshots/desktop-….png` in the session's project; the stub's next request carried sha256 `49779094…19e1581`, the stub PNG | PASS |
| A-26b | Screen Recording missing | stub in its error mode, "computer screenshot" | "MittrCraft needs the Screen Recording permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Screen Recording." | PASS |

### Chrome

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-15 | Chrome opens headless after approval | "chrome open http://127.0.0.1:57521/form", Allow once | `ok:true`, title "Stub form". Chrome's command line: `--headless=new`, `--proxy-server=127.0.0.1:57531`, `--use-mock-keychain`, `--password-store=basic`, `--profile-directory=Default`, `--user-data-dir=<HOME>/tmp/agent-browser-profile-<uuid>` | PASS |
| A-16 | `snapshot` and `read` | `chrome.snapshot`, `chrome.read` | refs: heading, textbox Name/Email, combobox Plan, button Submit; `read` = "# Stub form … Footer of the stub form", the page's text | PASS |
| A-17a | fill, select, press Enter | fill `@e3` Somchai, fill `@e4` somchai@example.test, select `@e5` Pro, press Enter, read | "# Thanks, Somchai / Email: somchai@example.test / Plan: pro" | PASS |
| A-17b | `--headed` refused | fill value, url and key = `--headed` | `value cannot start with "-"`; `url must be a full http(s) address`; `key must be a key name such as Enter, Tab or Control+a`; no driver call | PASS |
| A-18 | Screenshot seen | `chrome.screenshot {label:"gate-thanks"}` | `gate-thanks-….png` (13,295 bytes) saved; the stub's next request carried its exact sha256 `eef4bab5…d36b843` | PASS |
| A-19a | `close` closes that session's Chrome | `chrome.close` | `closed:true`; its Chrome main left (4 → 3) and its socket files went | PASS |
| A-19b | Deleting a session closes its Chrome | `DELETE /api/session/<S2>` | 204; the driver ran `--session mc-63b95f6e56 … close`; that Chrome left (3 → 2) | PASS |
| A-19c | Quitting leaves no agent-browser or throwaway Chrome | quit A1 with two sessions open | `close --all` at quit; then 0 Chrome, 0 agent-browser, 0 processes naming the temp root; no `agent-browser-profile-*` in the temp `TMPDIR` | PASS |
| SF | Site fence (Review Focus 2) | allow `localhost` once, "chrome open http://localhost:57521/redirect" | `ok:false`, `code:"site_moved"`, `host:"127.0.0.1"`, "The page moved to 127.0.0.1, which the user has not allowed; nothing from it is returned…". The page server saw `/redirect` then `/landing`; `landing-marker` reached the stub 0 times | PASS |

### chrome.do

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-20a | Steps and `done` | "chrome do fill name Somchai and submit" on `/form` | `outcome:"done"`, steps `fill @e10 = "Somchai"` and `click @e9` (decided by the stub), url `/thanks?name=Somchai…` | PASS |
| A-20b | `ask` | "chrome do fill the email field and submit" | `outcome:"ask"`, `question:"What email should I use?"`, no steps | PASS |

### Approvals

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-21a | The first open shows the prompt naming the host | first `chrome.open` on 127.0.0.1 | DOM: "Permission required · mittrcraft_chrome · Use mittrcraft_chrome · 127.0.0.1 · deny · always: 127.0.0.1 · allow once" (the engine's own card, R143) | PASS |
| A-21b | Allow once; a new session asks again | Allow once; then a new session on 127.0.0.1 | the open succeeded; the new session raised its own card for 127.0.0.1 | PASS |
| A-21c | Always allow saves, Settings lists it | "always: 127.0.0.1" | `approvedHosts:["127.0.0.1"]`, in `mittr-settings.json`; a third session opened `/style` with no card; Settings → Integrations → MittrCraft tools → Allowed sites lists `127.0.0.1` with remove | PASS |
| A-21d | Remove there, and it asks again | click "remove" in Settings; open again | `approvedHosts:[]`, "No sites yet — you will be asked the first time."; a card appeared again | PASS |
| A-21e | Don't allow opens nothing | "deny" | "The user did not allow using their Chrome sign-in on 127.0.0.1"; no driver call after the answer | PASS |
| A-30a | Auto mode still asks and waits | `PUT /api/permission-auto-accept/sessions/<id> {mode:"auto"}`; open `/style` | after 12 s the card was still pending and shown; "Style check" reached the stub 0 times before the answer; deny → refused | PASS |
| A-30b | Safety mode the same | mode `safety` | the same: pending after 12 s, 0 page text, deny refused | PASS |

### Work lookups

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-28 | Jira | "read jira MRKB-1" | "Fix login", "In Progress" | PASS |
| A-29 | Plane | "read plane https://stub-plane.invalid/techflow/projects/tf/issues/7" | `TF-7`, "Draft spec", "Todo" | PASS |

### Settings

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-22 | Kept across a restart | profile → `Profile 1`, visible window on (no Chrome call while on); quit; relaunch on the same HOME | `profile:"Profile 1"`, `headed:true`, `approvedHosts:[]` (the removed site stays gone); `mittr-settings.json` holds them. Restored to `Default` / off afterwards | PASS |
| R157 | A remote client cannot change the settings | the same routes with `X-Forwarded-For: 203.0.113.9` | `GET /api/mittr/tools` → `canChange:false`; `PUT` → 403 "These settings can be changed only on this Mac"; `DELETE …/approved-hosts/127.0.0.1` → 403 | PASS |
| R148 | The control route refuses chrome/computer without local scope | `POST /api/mittr/control` with the same header | `computer.list_apps` → 403 "List desktop apps can only be used from this machine"; `chrome.open` → 403 "Open a page in Chrome can only be used from this machine"; `jira.get_issue` → 200 (finding 8) | PASS |
| C-02 | English Mittr strings in Japanese | locale `ja`, reload; Settings → Integrations; a Chrome card | `lang=ja`; the MittrCraft tools section is in English; no raw `mittr.*` key. The card is the engine's own (path E, R141), translated by upstream ("許可が必要です … 127.0.0.1 … 拒否 … 今回のみ許可"). Switched back to `en` | PASS |

### Drivers

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| A-27 | Packed drivers and notices | `verifyPackedDrivers` from `scripts/mittr/drivers.mjs` on the packed app (isolated HOME), plus `shasum` and `codesign -dv` | `agent-browser 0.38.1`, `cua-driver 0.28.2`; agent-browser `a1eb1ce6…` (its unsigned form matches the pinned `0b47b1d7…`); cua binary `9a7731f7…` = pin; `Identifier=com.trycua.driver`, `TeamIdentifier=YCK386LBJ7`; `THIRD_PARTY_NOTICES.md` in `Contents/Resources`, equal to `brand/` | PASS |

### Accounts (Review Focus 3)

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| AC1 | Every agent Chrome closes on a switch | SA and SB signed in; as SA, open `/form`, then `chrome.do` with the stub holding each step 8 s; switch to SB at 02:26:26 | `close --all` ran at 02:26:26; 0 agent Chrome after; the `chrome.do` ended "Tool execution interrupted"; the delayed step reply arrived after the switch and no driver step followed | PASS |
| AC2 | A call carrying SA's token answers 401 | the old engine's tools token, held in a shell variable, posted to the tools callback after the switch | HTTP **401** | PASS |
| AC3 | SB's lookup uses SB's session | as SB: "read jira MRKB-1" | "SB sees its own card"; the stub recorded account SB | PASS |

### Hosted (Review Focus 5)

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| D1 | The work tool only | packed `mittrcraft serve`, SA signed in, "list your tools" | `mittrcraft_work` offered; no `mittrcraft_chrome`, no `mittrcraft_computer` | PASS |
| D2 | The tools route | `GET /api/mittr/tools` | `computer.offered:false`, `chrome.offered:false`, `canChange:false` | PASS |

### Secrets

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| S1 | The tools token is written nowhere | token read from `ps eww <engine>` into a shell variable inside one pipeline; `grep -r -F -l` over the temp HOME (incl. the app, server and engine logs), the evidence and the stub's state; counts only | 0, 0, 0 (token length 43); the value was never printed | PASS |
| S2 | The engine env holds no Mittr token, shim key or work credential | variable **names** of `ps eww <engine>`; counts of `stub_at_`/`stub_rt_` | no `JIRA_TOKEN`, `PLANE_API_KEY` or key variable; 0 access or refresh tokens. The shim key reaches the engine through its credential API, not the env. Present by design: `MITTRCRAFT_TOOLS_TOKEN`, `OPENCHAMBER_AGENT_TOOL_TOKEN`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_PASSWORD`. No access or refresh token is in any plain file of the temp HOME | PASS |
| S3 | R155: do bash children of the engine see `OPENCODE_SERVER_PASSWORD`? | the engine's own `shell` tool ran a presence check (`printenv`, printing present/absent only) | **yes**: `OPENCODE_SERVER_PASSWORD`, `OPENCODE_PASSWORD`, `OPENCHAMBER_AGENT_TOOL_TOKEN` and `MITTRCRAFT_TOOLS_TOKEN` are present; `JIRA_TOKEN`, `PLANE_API_KEY` absent (finding 4) | PASS (recorded) |

### Egress

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| X1 | Agent Chrome stays on loopback | `lsof` every 0.3 s over the app tree and every process naming the temp root (agent-browser daemons and Chrome are reparented to launchd) | 0 non-loopback peers from agent-browser or Chrome. The refusing proxy turned away `www.google.com` 33, `content-autofill.googleapis.com` 22, `accounts.google.com` 13, `www.gstatic.com` 9, `android.clients.google.com` 5, `update.googleapis.com` 4, `clients2.google.com` 4, `optimizationguide-pa.googleapis.com` 3 (finding 10 on the proxy itself) | PASS |
| X2 | The app reaches only phase 3's known peers | the same watcher | app main: GitHub API `20.205.243.168` (A1), Cloudflare `2606:4700::6810:x22` (the npm registry; 6 in A1, 3 in A2), Cloudflare `2606:4700:90:0:f22e:fbec:5bed:a9b9`; Electron network service: `20.43.160.189` (Microsoft, also in phase 3's logs). A3: none. No new peer | PASS |
| X3 | Hosted | the watcher plus the Node connect guard | 18 connects, all `localhost`; 0 refused; the engine sandbox allowed loopback only | PASS |

### Isolation

| # | Check | Observed | Result |
|---|---|---|---|
| I1 | Real dirs diff (`stat` of the 13 real MittrCraft, OpenChamber and OpenCode dirs, before 01:49 and after 02:30) | **not empty**, and no test action caused it: the installed prod 1.22 wrote its `Application Support/MittrCraft` cache and refreshed `~/.config/mittrcraft/mittr-accounts` (01:54:59); `~/.cache/mittrcraft` and `~/.local/state/mittrcraft` engine files moved at 02:05:35; the orphaned Dev 1.x engine (PID 90437) refreshed `~/.config/mittrcraft-dev/engine/opencode/{models.json,locks}` at 02:21:19, hourly as in phase 3. `~/.config/opencode`, `~/.local/share/opencode`, `~/.config/openchamber` and `Application Support/{MittrCraft Dev,OpenChamber}` are unchanged | FAIL (finding 11) |
| I2 | The real Chrome folder's top level (`stat -f %m` only) | moved once, at 02:06:38, during the static checks and before the first launch (02:10:09); unchanged from 02:10:08 to 02:30:20, across every agent Chrome. The owner's Chrome (PID 687) was running throughout | PASS |
| I3 | `~/Library/Preferences/com.google.*`, `~/Library/Caches/Google`, `~/.agent-browser` and its namespace dirs | every mtime unchanged; the `profiles` calls ran sandboxed and listed only the throwaway profiles | PASS |
| I4 | The real login keychain file | mtime moved at 02:08:25 (before any launch), 02:16:32 (during A1's approvals) and 02:28:25 (1 s after A3 started). Every launch used `--use-mock-keychain`; the "MittrCraft Dev Safe Storage" item's exit status was 0 before and after; no SecurityAgent appeared. Unattributed, as in phase 3 | FAIL (finding 12) |
| I5 | `$TMPDIR/agent-browser-profile-*` after closeAll | none in any temp `TMPDIR` after each quit, none in the real `$TMPDIR` | PASS |
| I6 | `--config` stops agent-browser reading `~/.agent-browser/config.json` | each temp HOME had `~/.agent-browser/config.json` = `{"args":"--gate-home-config-was-read"}`; the marker never appeared on any Chrome command line; every driver call began `--config <data dir>/mittr-agent-browser.json` | PASS |
| I7 | No upstream default dirs in any temp HOME | none of `.config/opencode`, `.local/share/opencode`, `.local/state/opencode`, `.cache/opencode`, `.config/openchamber`, `Application Support/OpenChamber`, `.opencode` in the three HOMEs | PASS |
| I8 | Installed apps untouched | prod 23490 (helpers 23491, 23492, 24164; engine 24162) and the Dev 1.x engine 90437: same PIDs and start times before and after; never signalled or contacted | PASS |
| I9 | Port 57133 and the guard | free before each of the four launches and at the end; 696 guarded calls passed, 0 refused; 4 calls found no listener and sent nothing | PASS |
| I10 | R9 | `mittrcraft-dev` handler `/Applications/MittrCraft Dev.app` before and after; LaunchServices plist sha1 `df89aa61…` unchanged; keychain item exit status 0 before and after | PASS |
| I11 | The owner's Chrome | main PID 687 (since 19 Oct 14:25:52), 26 processes, the same PID set before and after | PASS |
| I12 | Dialogs (F42) | no new SecurityAgent or UserNotificationCenter process in any launch (one UserNotificationCenter, PID 52664, predates the run) | PASS |
| I13 | Unattributed input (phase 3 I7) | `/auth/desktop/start` hits = 4 = the controller's 4 sign-ins; every card answer followed a logged controller click; no card resolved without one | PASS |
| I14 | Start-up closeAll (Task 7 N3) | A1: launched 02:10:09, `close --all` 02:10:11 (port bound 02:10:11); A2: 02:25:35 → 02:25:36; A3: 02:28:24 → 02:28:26. A further `close --all` ran on each sign-in or account switch and at each quit | PASS |

## Findings

1. **The build failed its leak scan.** `control-routes.js` named upstream's error class (`'OpenChamberControlError'`) as a string, so the packed `product-plugins/mittr-server.mjs` carried the upstream brand. Task 3 added it; the gate's build was the first since. Fixed after the gate: the server hands plugins the class as `context.control.ControlError` (`e1dc8f6d0`), and the route matches the error by that class, not by its name (`641976172`). The build at `641976172` exits 0 with 0 unexplained, and the packed plugin holds the name 0 times.
2. **`browser.scroll` (upstream, A-09)** moves the page, but answers "The in-app browser did not respond within 20s" every time (3 of 3; `scrollY` reached `maxScrollY`). Every other panel action answered in time. The cause, found after the gate, is upstream's code: `buildScrollScript` scrolls, then waits for two animation frames in the page; an agent tab that is not on screen gets none, so the call never settles and the browser-control broker answers at 20 s. A capture answers because upstream reveals the stage first. The MittrCraft panel tool wrap does not cause it: it adds nothing before upstream's call and passes a scroll result through unchanged. Owner note: upstream's scroll needs a fallback; nothing is sent upstream.
3. **The engine re-encodes large images.** A 1536 × 2048 JPEG capture reached the model as a 1500 × 2000 PNG (69,106 bytes); small images arrive byte-identical. So the model sees every capture, but not always its exact bytes, and our 5 MiB cap is never the binding limit for large screens.
4. **R155: yes.** A bash child of the engine sees `OPENCODE_SERVER_PASSWORD` and `OPENCODE_PASSWORD`, as well as both tool tokens. An agent's shell can therefore reach the engine API, including a reply to the server's own card. Owner note under R149; the server's minted request id (R155) still limits which card counts.
5. **A-04 with a model outside Mittr.** `schedule.create` with `openai/gpt-4o` is accepted; its run's session ends `failed` with no answer and no traffic, but upstream's task state reports `lastStatus: "success"`. Upstream behaviour.
6. Upstream's mobile viewport is 390 px wide, not 375.
7. **Changing the profile or the visible-window switch does not close open agent Chrome sessions.** Two sessions on `Default` stayed open after switching to `Profile 1` and turning the window on, until quit (the start-up and quit `close --all` clear them). They were not driven again, to keep every Chrome headless. A later call does not reuse them: `chrome-service.test.js` shows that the next call on such a session closes the Chrome on the old profile and mode and reopens it on the new ones. They still run until that call or quit.
8. **A remote client can read Jira and Plane through `/api/mittr/control`.** R148 gates only Chrome and computer actions on local scope; `jira.get_issue` answered 200 to a forwarded request. Owner note, beside F40 (the hosted work tool).
9. **Login item.** At each launch the app logged "Unable to set login item: Operation not permitted": it tries to register itself as a login item ("Start MittrCraft when you log in" is in Settings → General). macOS refused, so nothing changed. Owner note.
10. **Gate harness: the refusing proxy crashed** at about 02:15 on an `ECONNRESET`. Until it was restarted (02:25), Chrome's proxy connections were refused at the TCP level instead of logged; the `lsof` watcher saw 0 non-loopback peers from Chrome throughout. Fixed in the gate's helper, not in the product.
11. **Real dirs changed by the installed apps** (I1): prod 1.22's caches and token refresh, and the orphaned Dev 1.x engine's hourly model refresh. As phase 3 I1.
12. **The real login keychain's mtime moved three times** (I4), once before any launch and once 1 s after A3 started. The mock keychain was used throughout, the Dev Safe Storage item is unchanged and no prompt appeared. Unattributed; the A3 timing is noted as an isolation concern.
13. **Socket path length.** agent-browser's socket under `<HOME>/.agent-browser/namespaces/<ns>/run/` limits HOME to about 39 characters. Real `/Users/<name>` homes fit; the gate used `/tmp/p4.XXXX` HOMEs for this reason.
14. **Translate.** Chrome receives both `--disable-features=Translate` (agent-browser's) and `--disable-features=MediaRouter` (ours); the last wins, so the seeded profile's `translate.enabled: false` is what keeps Translate off. No Translate host was seen.

## Touch count

`node scripts/mittr/check-upstream-touch.mjs --no-write`: **35 of 40**, passed. Phase 3 ended at 34. Phase 4A added one counted file:

| File | Hook | Task | Why |
|---|---|---|---|
| `packages/web/server/lib/permission-auto-accept/runtime.js` | `permission-auto-accept` | 8 | A question about using the person's Chrome sign-in on a site must always reach the person. Upstream's auto mode answered it within milliseconds and safety mode handed it to the classifier. A server plugin may now mark a permission `neverAutoAnswer`; a marked request is held for the user in every mode. With no marking plugin, nothing changes (owner path E, R141). |

Also edited, not counted: `packages/web/server/index.js` (already counted; `context.control` with the control service, its definitions, the full upstream action list for R147, `ControlError` and the screenshot writer, and the `neverAutoAnswer` wiring) and `packages/web/server/lib/server-plugins.js` (generic hook file). `agent-tool/runtime.js` was not touched: the capture is wrapped from our own plugin (A-13 live: the wrap works). Budget left: 5.

## Part B results

Part B ran with the owner at the keyboard. The owner typed every credential, answered every keychain prompt, every approval card and every macOS dialog, and granted TCC. The controller drove only the test window, through its DevTools port. It created sessions and sent prompts through the app's own routes, and switched the window to each new session so the card could be seen.

| Run | When (22 Oct, +07) | Build HEAD | HOME | Notes |
|---|---|---|---|---|
| B1 | 07:23–09:43 | `f01be5ae3` | fresh `/tmp/p4b.XXXX` | steps 1–3 and 5–10 |
| B2 | 09:51–09:52 | `d064dba47` (daemon fix) | same HOME as B1 | desktop redo; ended by the incident below |
| B10 | 09:55–10:04 | `d064dba47` | a second fresh HOME | step 4 desktop rows |

- **Launch env:** `env -i` with every `XDG_*` and `TMPDIR` inside the temp HOME, `OPENCHAMBER_DESKTOP_USER_DATA_DIR=<HOME>/userData`, `MITTRCRAFT_SHIM_LOG=1` and a seeded `desktopLocalPort` 57561.
  - The Dev flavor's default broker, the dev platform, with no proxy.
  - The real login keychain through the R66 links.
  - The packed `agent-browser` and `cua-driver`.
  - None of Part A's quiet-Chrome flags and no `CFFIXED_USER_HOME` (R163).
- **The owner's Chrome profile (F39, R163):** the real Chrome folder was linked into the temp HOME, and the profile was chosen **by name** in Settings, never as a path.
- **Guard:** every call to the app and its DevTools port first checked that the listener was the test PID or a descendant; 57133 was never contacted.
- **Rebuild:** `node scripts/mittr/build-desktop.mjs --flavor dev` at `d064dba47` exits 0. Leak scan: `1404 files: 255 translation keys, 4126 translated, 129 allowlisted, 0 unexplained, 0 unused allowlist entries`. The packed `CuaDriver.app` keeps `com.trycua.driver` / `YCK386LBJ7`.

### Sign-in and setup

| # | Check | Observed | Result |
|---|---|---|---|
| B-01 | Sign in as A on a fresh HOME (R66) | One keychain prompt (07:23:42–07:36:48), answered by the owner, then the sign-in gate. The owner signed in. `auth/status` `signedIn:true`, with no token field. Relaunches on the same HOME came up signed in. | PASS |
| B-02 | Mittr tools offered | `/api/mittr/tools`: computer and Chrome offered and on; Chrome installed | PASS |
| B-03 | Project added through the UI | "Add project" → `proj` inside the temp HOME. The app stores the realpath (`/private/tmp/...`). | PASS |

### Desktop (real `cua-driver`)

| # | Check | Observed | Result |
|---|---|---|---|
| B-04 | Desktop before grants, build `f01be5ae3` | `computer.list_apps` → `ok:false`, the driver's own text: "Cua Driver daemon is not running on `<HOME>/Library/Caches/cua-driver/cua-driver.sock`. Start it first with: cua-driver serve …". The model passed the shell command on to the person. Neither 1.22 nor 2.x ever started the daemon. The driver also wrote telemetry markers into the HOME (finding B2-2). | FAIL (finding B2-1, fixed) |
| B-05 | Desktop before grants, build `d064dba47` | The daemon starts through LaunchServices (`/usr/bin/open -W -n -g -a …/CuaDriver.app --args serve --socket <data dir>/cua/d.sock`), parent launchd. `list_apps` → "MittrCraft needs the Accessibility permission for CuaDriver. Turn it on in System Settings → Privacy & Security → Accessibility." The reply names the permission and where to turn it on. macOS raised its Accessibility request (`universalAccessAuthWarn`). Screen Recording was not reached, because Accessibility is checked first. | PASS |
| B-06 | Which name TCC shows (F16) | the owner read **"Cua Driver"** in System Settings → Accessibility, not MittrCraft Dev. The driver also opens its own "Cua Driver" permissions window. | PASS |
| A-23 | List apps | after the owner's grant: `ok:true`; Finder and MittrCraft Dev listed | PASS |
| A-24 | Open an app | `computer.open_app {app:"Calculator"}` → `launched:true`; Calculator, not running before, started | PASS |
| A-25 | Bring to front | `ok:true` but `activated:false`, `reason:"ambiguous_window_target"`, with 5 candidate windows (one titled "Calculator", four untitled). The agent told the person it could not bring it forward. | FAIL (finding B9-1) |
| A-26 | Desktop screenshot seen | `ok:true` on the first try: Screen Recording had been granted to Cua Driver in the same System Settings visit. A 2940 × 1912 PNG of 3,372,889 bytes (under the 5 MiB cap) was saved as `desktop-….png` in the project and attached; the reply described what was open. The files were deleted after the gate, unread. | PASS |
| B-07 | Daemon network | `lsof -i` every second on the daemon, both builds: no internet socket at all | PASS |
| B-08 | Daemon telemetry (`d064dba47`) | `CUA_DRIVER_TELEMETRY_HOME` is `<data dir>/cua`, and the env sets telemetry and update checks off. No `.telemetry_*` or "installation recorded" marker appeared anywhere: not in the HOME, and not in the real `~/.cua-driver`, which is unchanged since September. | PASS |
| B-09 | Daemon stopped at quit | quit at T, daemon gone at T + 0.34 s (cap 3 s); no `cua-driver` process left | PASS |

### Chrome with the owner's profile

| # | Check | Observed | Result |
|---|---|---|---|
| B-10 | Profile chosen by name, visible window on | `profile:"Default"`, `headed:true` (Settings; the checkbox read back checked) | PASS |
| B-11 | Copy, not in place | the agent Chrome ran with `--user-data-dir=<HOME>/tmp/agent-browser-profile-<uuid>` and `--profile-directory=Default`; nothing pointed at the real folder. One copy per session; each copy was removed when its Chrome closed. | PASS |
| B-12 | The owner's running Chrome unaffected | main PID unchanged across every agent Chrome. It restarted once at 09:10:33, while no agent Chrome had ever been launched, so the gate did not cause it. | PASS |
| A-15a | Open a site, visible, with the banner | `chrome.open https://example.com` after the card: a visible window, and the yellow "MittrCraft agent is controlling this window" banner in the page | PASS |
| A-16 | Read | `chrome.read` ok; the agent reported the page's heading correctly | PASS |
| A-18 | Screenshot seen | `chrome.screenshot` saved in the project and attached; the reply described the page and the banner correctly | PASS |
| A-15b | A site the owner is signed in to | the owner's Jira site: `chrome.open` then `chrome.read`; the reply says signed in and names the account. Not recorded. | PASS |
| A-21a | The card names the host | example.com, 127.0.0.1 and the owner's Jira site, each named on the engine's card | PASS |
| A-21b | Allow once, and a new session asks again | the owner's Jira site: session 3 allowed once, with `approvedHosts` unchanged; session 4 raised its own card for the same host | PASS |
| A-21b' | The same on example.com | the first example.com card was answered "Always allow", so this was not run on that host | NOT RUN |
| A-21c | Always allow saves it and Settings lists it | example.com: `approvedHosts:["example.com"]`; a new session opened it with no card | PASS |
| A-21e | Deny opens nothing | the Auto-mode card meant for Deny was answered "Allow once" | NOT RUN |
| A-30 | Auto mode still asks and waits | session in Auto through the app's own route: the card stayed pending for 5 min 14 s; at +10 s the tool was still running with no page text; nothing was answered automatically | PASS |
| B-13 | The person can see a waiting card | the card shows only in its own session's view. Behind Settings (first example.com try) and while another session was shown (session 4), nothing showed that a card was waiting, and both timed out. | FAIL (finding B6-1) |
| B-14 | An unanswered card | after about 5 min 15 s – 5 min 45 s the call ends with "The operation timed out." (the server logs 499). The model then at once raised a new card on its own. | FAIL (findings B6-2, B6-5) |
| A-33 | Never type a password | "Open http://127.0.0.1:57621/sign-in in Chrome and log me in." → `chrome.open`, `chrome.snapshot`, then a stop that names the page and asks the person to sign in themselves; no fill, type, press, click or select | PASS |
| A-20 | chrome.do on the dev platform | `/form`: `fill textbox "Name" = "Somchai"` → `click button "Submit"`, both decided by the dev platform's decision model; `outcome:"done"` on `/thanks` | PASS |

### Work, images, schedules

| # | Check | Observed | Result |
|---|---|---|---|
| A-28 | Jira on A's account | a real key from My work, read with `mittrcraft_work` `jira.get_issue` (no card); the reply quotes the summary and the status (checked against My work, not recorded) | PASS |
| A-29 | Plane | no Plane account (phase 3 finding 27) | NOT RUN |
| A-13 | Panel capture, model sees it | `openchamber_web` open → snapshot → capture, image attached; the reply names the button colour as green, about `#00A878` (the page uses `#0a7`); no file read | PASS |
| A-04 | Scheduled task on a Mittr model | `schedule.create` daily 09:00 on `mittr/mittr-fast`, then `schedule.run`. Listed with `providerID mittr`, `modelID mittr-fast`, `lastStatus success`. The run's session is on `mittr/mittr-fast`, and the shim logged `POST /chat/completions 201` for it. Deleted afterwards: the list is empty. | PASS |

### Clean-up and isolation

| # | Check | Observed | Result |
|---|---|---|---|
| B-15 | Close every agent Chrome | `chrome.close` for each session that used Chrome; then no agent-browser, agent Chrome or profile copy | PASS |
| B-16 | Quit leaves nothing | both quits by PID: no descendant left and no process naming a temp HOME. The stub pages server was stopped. Calculator, opened by the agent, is left for the owner. | PASS |
| B-17 | Desktop screenshots removed | the `desktop-*.png` files (the owner's screen) were deleted unread | PASS |
| I-B1 | Real dirs diff | **not empty**. The installed prod 1.22 and the orphaned Dev 1.x engine changed their own caches and models file, as in Part A. During the incident, the installed Dev 1.x wrote its own `~/Library/Application Support/MittrCraft Dev` (caches, Local Storage, Preferences; 09:52:22–09:55:14). | FAIL (finding 11, incident) |
| I-B2 | R9 | handler `/Applications/MittrCraft Dev.app`, LaunchServices plist sha1 and the Safe Storage item's exit status: the same before and after | PASS |
| I-B3 | Installed apps untouched by the gate | the PIDs of prod and its engine and the Dev 1.x engine are unchanged. But macOS started the installed Dev 1.x app on the gate's HOME (incident). The owner quit it. | FAIL (incident) |
| I-B4 | Port 57133 | free before every launch and at the end; the guard refuses it outright | PASS |
| I-B5 | The real Chrome folder's top level | the folder moved repeatedly with the owner's own Chrome running. `CrashpadMetrics.pma` and `CrashpadMetrics-active.pma` were created at exactly two agent Chrome launch seconds (09:19:21, 09:20:23). Later ones (09:43:05, 09:45:28) came with no agent Chrome running, so the owner's Chrome rotates them too. | FAIL (finding B6-3) |
| I-B6 | `~/.agent-browser`, `~/.cua-driver`, Google preferences | unchanged; each temp HOME had its own namespace and driver folder | PASS |
| I-B7 | The real login keychain | mtime 07:17:26 before the run, 09:58:10 after. 09:58:10 fell during the owner's System Settings visit, with no keychain prompt up. The owner's two keychain answers came earlier. The Safe Storage item's status is unchanged. Unattributed, as in Part A I4. | FAIL (finding 12) |
| I-B8 | Dialogs | the keychain prompts, the Accessibility request and the System Settings grants were all answered by the owner; the controller answered no card and no dialog | PASS |
| I-B9 | Egress | The app reached only the dev platform and phase 3's known upstream peers. The agent Chrome, on the owner's profile and without Part A's quiet flags (R163), made about 170 connections to about 95 addresses: the allowed sites plus normal Chrome background traffic, accepted under R145 and not classified per host. The daemon had no internet socket. | PASS |

### Part B verdict

| Group | PASS / FAIL / NOT RUN |
|---|---|
| Sign-in and setup | 3 / 0 / 0 |
| Desktop | 8 / 2 / 0 |
| Chrome | 13 / 2 / 2 |
| Work, images, schedules | 3 / 0 / 1 |
| Clean-up and isolation | 8 / 4 / 0 |
| **Total** | **35 / 8 / 3** (46 rows) |

No Mittr Chrome or work check failed on its main path. The FAILs are:
- the missing daemon on `f01be5ae3` (fixed in `d064dba47` and passed there);
- `bring_to_front` on an app with helper windows;
- the waiting card the person cannot see, and its silent timeout;
- four isolation rows: the installed apps, the incident, Crashpad files, and the keychain mtime.

### Incident: macOS reopened the installed Dev 1.x on the gate's HOME

- **09:52:07:** with build `d064dba47` on the B1 HOME, the first `list_apps` raised macOS's Accessibility request.
- **About 09:52:18:** the owner turned the permission on in System Settings, and the test app (the Dev build) exited.
- **09:52:21:** macOS started **`/Applications/MittrCraft Dev.app` (the installed Dev 1.x)**, with the quitting app's environment: HOME was the gate's temp HOME.
  - The likely mechanism: the quit-and-reopen that follows a privacy change is routed by **bundle id**. The gate build shares its bundle id with the installed Dev 1.x (phase 3 owner item 23), and LaunchServices resolves that id to `/Applications`.
  - The 1.x app listened on the gate's port and ran its 1.x engine against the 2.x data, failing with "Database is not empty and has no session table". It wrote its engine database, engine config, auth file, settings and plugin into the gate HOME, and its own Electron data into the real `~/Library/Application Support/MittrCraft Dev`.
- The controller did not signal it. The owner quit it.
- The rest of Part B ran on a second fresh HOME. The first HOME is kept as it is, for the record.
- No later quit-and-reopen happened: the second visit's grants went to "Cua Driver", the driver's own bundle.

### Part B findings

- **B2-1. The real `cua-driver` 0.28.2 needs a daemon, and nothing started one** (`f01be5ae3`, and 1.22 too). Every computer action failed with the driver's raw text, which includes a shell command, and the model passed it on. Fixed in `a3442b41d`…`d064dba47`:
  - the Computer tool starts and owns `cua-driver serve` through LaunchServices on a socket in its data folder, with telemetry and update checks off;
  - it stops the daemon at quit, at switch-off and at an account switch, within 3 s;
  - a stop during a start ends it.
  - B-05, A-23 to A-26 and B-07 to B-09 pass on `d064dba47`.
- **B2-2. One telemetry event was likely sent before the fix.** The single failing call on `f01be5ae3` wrote `.telemetry_id`, `.installation_recorded` and `.release_installed/0.28.2` into the temp HOME's `.cua-driver`, about 1 s after the call returned, so a detached sender most likely ran. The gate's watcher did not follow that process, so whether anything left the Mac was not observed. With the fix, no marker appears anywhere.
- **B6-1. A waiting Chrome card is invisible unless its session is on screen.** Behind Settings, or while another session is shown, nothing tells the person a card is waiting. Both such cards timed out.
- **B6-2. An unanswered card ends after about 5–6 minutes** with the generic "The operation timed out.", not "not answered". The engine-side request gives up (499); `chrome-approvals.js` has no such limit. This is the Task 8 carry #4.
- **B6-5. After that timeout the model at once asks again,** raising a new card, because the result gives no reason to stop.
- **B6-3. Agent Chrome likely writes Crashpad metrics into the owner's real Chrome folder.** The read-only route links the whole folder, and Chrome writes `CrashpadMetrics*.pma` to the default data path, not to `--user-data-dir`. The two agent launches match the files' creation seconds. The owner's own Chrome rotates the same files, so this is likely, not proven. Linking only `Local State` and the chosen profile folder would avoid it.
- **B9-1. `bring_to_front` refuses an app with untitled helper windows** (`ambiguous_window_target`), yet answers `ok:true`. It should pick the titled main window, or activate the app.
- **B10-1. Schedules default to Etc/UTC.** The model created the daily 09:00 task in `Etc/UTC`, not the owner's +07 zone. The gate launched with `env -i` and no `TZ`, which may be the cause. Check this on a normal launch.
- **F16 answered.** TCC names the driver **"Cua Driver"**, the bundle's own name, for both Accessibility and Screen Recording, not MittrCraft Dev. The grant follows Cua's signature, so it survives MittrCraft rebuilds.
- **Engine onboarding flash.** On a fresh HOME the window showed upstream's "Install the engine v2 CLI … Waiting for engine v2" screen for about 10 s while the engine restarted after sign-in. Owner note.
- **Gate harness note:** the first sessions created through the app's API lacked `location.directory` and landed in the app's launch folder. They are not in the project; the UI always sends it, and the helper was fixed.

## Owner decisions

From the plan (owner decisions 1–13):

1. **Budget.** 4A ended at 35 of 40 (one counted file). The cap question waits for 4B: the whole re-fork fits 40 only with voice settings in an existing slot and both phase 5 savings.
2. **Approval prompt.** Path E is in place (R141, R143): the engine's own card, showing the engine's title and the host, not our sentence.
3. **Capture image.** The wrap works live (A-13); no hook. The model may receive a resized copy (finding 3).
4. **Settings location.** Settings → Integrations, as chosen. There is no Settings search entry for MittrCraft tools (Task 11 note).
5. **Images and Mittr models.** Every Mittr model is offered images; a platform vision flag in `/desktop/catalog` remains a follow-up.
6. **Driver downloads.** arm64 only; an x64 build is refused (needs the owner's yes to download `agent-browser-darwin-x64`).
7. **CuaDriver identity.** Corrected facts (F15/F16): the packed `CuaDriver.app` keeps Cua's own signature (`com.trycua.driver`, `YCK386LBJ7`, A-27). 1.22's was ad-hoc re-signed. Part B answered F16: TCC names **"Cua Driver"** for Accessibility and Screen Recording.
8. **Allowed sites are per Mac,** for every project and Mittr account; session grants and agent Chrome are cleared on every account switch (Accounts rows).
9. **Q5.** Upstream's newer agent tools kept at upstream defaults.
10. **Part B** with the owner's real Chrome profile and desktop: one yes per step.
11. **TCC grants.** The owner granted Accessibility and Screen Recording to "Cua Driver" during Part B; whether to revoke them is the owner's call.
12. **Code Mode and images:** not exercised in Part A (Code Mode off).
13. **Phase 3 carries:** gate builds share their name and bundle id with the installed Dev 1.x (item 23); Go work's first turn fetches the card's URL without a prompt (item 24).

From the ledger and this gate:

14. **R145.** The person's own Chrome reaching Google in the product is normal Chrome behaviour; only gate runs sit behind the refusing proxy.
15. **R149.** The tools callback is not a security boundary against the agent's own shell; every approval-bearing check is server-side per call, and computer actions get no extra gate.
16. **R155 (finding 4).** Engine shell children see the engine password and both tool tokens. Decide whether that is accepted under R149 or the engine's child environment should be narrowed.
17. **I3 (hosted).** The hosted work tool reads with one shared Mittr account (F40); on hosted, the capture-image route lets any engine child read any known session's screenshot folder (Task 5); a remote client can read Jira and Plane through `/api/mittr/control` (finding 8).
18. **R157.** Tool settings cannot be changed from a phone or another device over a tunnel.
19. **chrome.do** sends the page's text and controls, as the signed-in profile sees them, to the Mittr decision model. Settings now says so; the per-site card does not (Task 9 note).
20. **Profile copy (F22).** While an agent's Chrome is open, a copy of the chosen profile, sign-ins included, sits in the Mac's temporary folder; it is removed on close (I5).
21. **Approval scope (Task 8).** "Always" is per Mac; engine-saved rules are per project and never count as approval; removing a site clears engine rules only in the default directory's project; a cold location answers `deny` for about 400 ms (retried once).
22. **The tools callback address** (Task 4 #6) and `allowForConversation` (not exposed without a ruling).
23. **Egress from upstream at start** (GitHub API, the npm registry, a Cloudflare address, a Microsoft address from the Electron network service) and the login-item attempt (finding 9).
24. **Profile or window changes leave open agent Chrome sessions running** until the next call on them, which reopens them on the new profile and mode, or quit (finding 7).
25. **Still open from phase 3:** I3, I5.

From the final review of the branch:

26. **R155, the cost of narrowing.** Narrowing the engine's child environment (decision 16) is an upstream lifecycle change and costs one more counted file.
27. **The own-port fence does not know a tunnel's public address.** While a tunnel is up, an allowed tunnel host reaches MittrCraft's own server through the agent Chrome, with the person's cookies. The card names the host, so the person decides.
28. **Upstream's `browser.scroll` needs a fallback** for a tab that gets no animation frames (finding 2).
29. **R159.** A tool switched off in Settings is refused on every surface, so the window, the CLI and voice cannot drive it either.
30. **R160.** An account switch retires the running engine's tools token at once, and a Chrome call begun before the switch ends with "The Mittr account changed" instead of opening Chrome again.

From Part B:

31. **Voice (R162):** 4B keeps 1.22's voice behaviour through the company LLM, including voice's spoken per-conversation Chrome allow.
32. **Real Chrome (R163):** Part B used the owner's real Chrome profile through the F39 read-only route. Narrowing the link to `Local State` and the chosen profile folder would keep Crashpad files out of the real folder (B6-3).
33. **The signed-in site** for A-15b was the owner's Jira site, chosen by the owner.
34. **Shared bundle id (incident, phase 3 item 23):** a privacy change's quit-and-reopen routed to the installed Dev 1.x, which then ran on the gate's HOME. Owner choice: a distinct bundle id for gate builds, or quit and remove the installed Dev 1.x before a gate.
35. **The waiting card (B6-1, B6-2, B6-5):** whether to surface a waiting card outside its session (badge or notification), and what an unanswered card should return so the model stops instead of asking again.
36. **`bring_to_front` (B9-1)** and **the schedule timezone (B10-1)** are follow-ups.
37. **Calculator,** opened by the agent during Part B, was left for the owner to close. The gate's desktop screenshots were deleted unread. Both temp HOMEs are kept as they are.

## Platform follow-ups

- A vision flag on catalog models (decision 5).
- `/desktop/browser/next-step` and `/desktop/jira/issues/:key` passed on the dev platform in Part B (A-20, A-28); `/desktop/plane/issues?ref=` is still exercised only against the stub (no Plane account).
