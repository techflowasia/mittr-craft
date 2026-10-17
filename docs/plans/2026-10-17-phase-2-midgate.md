# Phase 2 mid gate: Dev signs in to the dev platform and answers

Date: 2026-10-17. Branch `rebase/upstream-2.1.1`, tested at `1df67d11c`.

## Verdict

**FAIL, on one check: quit and relaunch.** After the relaunch the keychain access prompt for "MittrCraft Dev Safe Storage" came back, the local server froze behind it, and the window showed the sign-in screen with "MittrCraft could not check whether you are signed in." Step 5 (three relaunches) could not be finished for the same reason. Every other check passed.

| Check | Result |
|---|---|
| Build, leak scan | **PASS** |
| Isolation | **PASS** |
| Sign-in to the dev platform | Done by the owner, the real way (see below) |
| 4.1 `status` reports the user | **PASS** |
| 4.2 `opencode.managed.json`: provider, lock policies, identity plugin | **PASS** |
| 4.3 Open model picker lists only Mittr agents | **PASS** (one finding, P1) |
| 4.4 "say hi" through `@opencode/client`: an answer streams in | **PASS** |
| 4.5 "who are you?" on two agents names MittrCraft only | **PASS**, with a deviation: the account has one Mittr agent (D1) |
| 4.6 Token storage | **PASS** (the refresh-token value sub-check was skipped, D2) |
| 4.7 Quit and relaunch: no sign-in screen, still signed in | **FAIL**: keychain prompt on relaunch (F1) |
| (a) New session starts on the first Mittr agent, no engine restart | **PASS** |
| (b) Shim "Not signed in" error readable in chat | **SKIPPED**: it needs a sign-out, which would undo the owner's sign-in |
| (c) Step 5: one engine 30 s after each of three relaunches | **INCOMPLETE**: relaunch 1 has exactly one engine; relaunches 2 and 3 are blocked by F1 |
| (d) No outbound connection to `*.openchamber.dev` | **PASS** (findings O1, O2) |

## Build under test

```
source ~/.nvm/nvm.sh && nvm use                       # Node v24.16.0, bun 1.3.14
node scripts/mittr/build-desktop.mjs --flavor dev     # exit 0
```

- Scan: 1403 files, 0 unexplained strings, 0 unused allowlist entries; the upstream licence file is packed.
- App: `packages/electron/dist/mac-arm64/MittrCraft Dev.app`, bundle id `dev.mittrcraft.desktop.dev`, version `2.1.1+mittr.1`, ad-hoc signed, not installed anywhere.
- Engine: the bundled opencode 2.0.22.

## How the runs were isolated

- One temp HOME from `mktemp -d "$TMPDIR/p2.XXXX"`, with `userData` under it. `<temp>/Library/Keychains` is a symlink to the login keychain folder and `<temp>/Library/Preferences/com.apple.security.plist` a symlink to the real file (ruling R66), so the shared item "MittrCraft Dev Safe Storage" is used as the brief expects. Nothing was copied into or changed in the keychain.
- Launch, every time: `nohup env HOME=<temp> OPENCHAMBER_DESKTOP_USER_DATA_DIR=<temp>/userData ".../MittrCraft Dev.app/Contents/MacOS/MittrCraft Dev" &` then `disown`. Port 57133 was checked free before each launch, and the test PID bound 57133 each time. Every request went to `127.0.0.1:57133` only.
- Quit: `kill -TERM <pid>`, after `ps` showed the worktree binary for that PID.
- Screenshots: only the test window, `screencapture -l <id>` with the window id taken from `CGWindowListCopyWindowInfo` filtered by the test PID.
- The one click (opening the model picker) went to a point inside the test window, after the test process was made frontmost and the window list showed the test window as the topmost normal window at that point. Escape was posted to the test PID only.
- The installed MittrCraft 1.22 (PID 2848, started Oct 15 14:45:00) was never signalled, opened or driven. Dev 1.x was not running before or after.

### Before and after

| Item | Before (07:59) | After (08:09) |
|---|---|---|
| `mittrcraft-dev` handler | `/Applications/MittrCraft Dev.app` | same |
| LaunchServices secure plist (JSON sha1) | `7a6a6dea5cf3…a145c0` | same |
| Keychain item "MittrCraft Dev Safe Storage" | present (exit 0) | present (exit 0) |
| Prod 1.22 PID 2848 | up 01-17:14:17 | up 01-17:24:40, same start time |
| Dev 1.x | not running | not running |

`stat` listings (depth 3) of the 11 real dirs: no difference in `~/.config/mittrcraft`, `~/.config/mittrcraft-dev`, `~/.local/share/mittrcraft`, `~/.config/openchamber`, `~/.local/share/opencode`, `~/.config/opencode`, `Application Support/MittrCraft Dev` and `Application Support/OpenChamber` (missing before and after). The differences that remain all belong to the running prod 1.22:

- `Application Support/MittrCraft`: 68 lines, all browser caches (`Cache/Cache_Data`, `GPUCache`, `Dawn*Cache`, `DIPS-wal`, `Partitions/mittrcraft-browser`).
- `~/.cache/mittrcraft/engine/opencode/models.json` and `~/.local/state/mittrcraft/engine/opencode/locks` (mtime 08:02:45). Only prod's engines 3624 and 3635 have these paths as `XDG_CACHE_HOME`/`XDG_STATE_HOME`. The test engine's XDG dirs were all inside the temp HOME. Prod's engine log shows its hourly tick at 08:02:32 local.

## How sign-in happened

The keychain access prompt from part A2 was answered by the owner with **Allow** (not Always Allow) at about 07:57:13. The owner then signed in to the dev platform (`api-dev.mittr.asia`) in a real browser, and the browser handed the `mittrcraft-dev://auth/callback` link to the test instance. At 07:57:26 the app wrote the user config default and gave the engine its Mittr key. `GET /api/mittr/auth/status` then reported signed in as the owner's account.

## Step 4 checks

### 4.1 status: PASS

`GET /api/mittr/auth/status` returned `signedIn: true` with the owner's account (user id and display name present).

### 4.2 managed config: PASS

`<temp>/.config/mittrcraft-dev/opencode.managed.json`:

- `providers.mittr`: name `Mittr`, package `aisdk:@ai-sdk/openai-compatible`, `baseURL` `http://127.0.0.1:57133/mittr-shim/v1`, models `{ "mittr-fast": "MITTR Fast" }`. That matches the account's catalog, which lists exactly one alias, `mittr-fast`.
- `experimental.policies`: `[{provider.use, *, deny}, {provider.use, mittr, allow}]`.
- `plugins` includes `<temp>/.config/mittrcraft-dev/engine-plugins/mittrcraft-identity`.

Through the app's proxy, `GET /api/provider` lists only `mittr` and `GET /api/model` lists only `mittr/mittr-fast`.

### 4.3 model picker: PASS

The open picker shows one group, MITTR, with one row, "MITTR Fast 200K", ticked. No other provider and no other model is listed.

- **P1 (finding):** the picker's first row is "Add new provider", although the switch is OFF. It is upstream's row. Whether it should be hidden while the lock is on is for the owner.
- The sidebar also shows "chats: Could not initialize workspace. try again". It is not part of a check here and is recorded for follow-up.

### 4.4 "say hi": PASS

`@opencode/client` 2.0.22 (`OpenCode.make({ baseUrl: 'http://127.0.0.1:57133' })`, no extra headers, as the desktop UI sends none): `session.create` with only a location, then `session.prompt({ text: 'say hi' })`. Events for the session: `session.text.started`, 2 × `session.text.delta`, `session.text.ended`, `session.execution.succeeded`. The answer was "Hi there! 👋 How can I help you today?", from agent `build` on `mittr/mittr-fast`.

### 4.5 "who are you?": PASS, with deviation D1

- Agent `build` on `mittr/mittr-fast` answered "I'm MittrCraft, an AI coding agent. …".
- Agent `plan` on `mittr/mittr-fast` answered "I'm **MittrCraft**, an AI coding agent. …".
- Neither names OpenCode or OpenChamber. Both streamed (4 deltas each).
- **D1:** the owner's account has only one Mittr agent (`mittr-fast`), so two *different Mittr agents* could not be compared. The two runs used two engine agents on the one Mittr agent. A second alias on the account would complete this check.

### 4.6 token storage: PASS, with D2

- `mittr-accounts/<id>.session` (259 bytes, mode 600) starts with `v`, not `{`.
- `grep -a -e refreshToken -e accessToken` over the whole `mittr-accounts/` folder finds nothing.
- `index.json` holds only `displayName`, `home`, `signedIn`, `userId` per account.
- **D2:** the refresh-token value from the exchange was not available to the checker, because the owner's browser handed the link to the app directly. The `grep -a -F <value>` sub-check was skipped.

### 4.7 quit and relaunch: FAIL (F1)

- 08:03:06: `kill -TERM` to the test PID. It exited in about 2 s, and its engine went with it. Port 57133 was free.
- 08:03:16: relaunched with the same env and binary. Port 57133 bound within 1 s, and the engine started.
- 08:03:18: a SecurityAgent prompt appeared again (an on-screen window of 434×186 at layer 1000). A `sample` of the app shows the main thread in `SecItemCopyMatching`, waiting, under an HTTP request handler. It is the same read-access prompt as in part A2. It was not touched and not screenshotted.
- From then on `/health` and `/api/mittr/auth/status` give no answer, and the test window shows "Sign in to MittrCraft" with "MittrCraft could not check whether you are signed in."
- Nobody answered the prompt during a 5-minute wait.
- **Why:** the owner's answer was "Allow", which covers one run. The ad-hoc-signed 2.x binary is not on the item's access list, so every launch asks again. A signed-in user reads the keychain on the first status request, so the relaunch hits the prompt at once. While it is up, the whole local server is frozen, because `safeStorage` is called synchronously on the Electron main thread that also runs the server.

## Extra checks

### (a) default model: PASS

At sign-in the app wrote `{"model": "mittr/mittr-fast"}` to the engine's user config (`engine/opencode/opencode.json`, 07:57:26, "new sessions start on a Mittr agent"). The engine (started 07:42:50) was not restarted. The "say hi" session was created without a model and answered on `mittr/mittr-fast`.

### (b) shim "Not signed in…" in chat: SKIPPED

It needs a signed-out app with a Mittr model selected. Signing out would undo the owner's sign-in, so it was not done.

### (c) engine count: INCOMPLETE

- Before the relaunch: `pgrep -P <app> -f opencode` showed one engine.
- Relaunch 1: one engine at 24 s and still one at 6 min.
- Relaunches 2 and 3 were not done, because relaunch 1 is held by F1.

### (d) outbound connections: PASS (findings O1, O2)

`lsof -i` was sampled every 2 s for the test app, its helpers and its engine from 08:02:07 to 08:09:10 (202 samples). None of the remote addresses is one that `api.openchamber.dev`, `docs.openchamber.dev`, `relay.openchamber.dev` or `openchamber.dev` resolve to, and neither log names `openchamber.dev`. The remote peers seen:

| Remote | Resolves from | Process |
|---|---|---|
| `127.0.0.1` | loopback | all |
| `52.77.138.120` | `api-dev.mittr.asia` | app main process |
| `172.67.69.147`, `104.26.9.108` | `models.dev` | app network helper, app main process |
| `172.66.173.149`, `104.20.32.17` | `api.opencode.ai` | engine |

- **O1 (finding):** the engine connects to `api.opencode.ai`, and the app connects to `models.dev`, while the lock is on. Both are third parties under R30/R39. This is not part of check (d), but needs a ruling.
- **O2 (finding):** the app log shows two calls of upstream's GitHub summary (`GET /user/emails`, answered 404) at 07:57:27 and 07:57:30. The temp HOME has no GitHub sign-in of its own, so the credential most likely came from the inherited shell environment or the shared login keychain.

## Findings for follow-up

1. **F1:** a signed-in Dev 2.x asks for keychain access on every launch until the user chooses Always Allow, or until the build is signed so that it is on the item's access list. While the prompt is up the server is frozen, and the UI shows the sign-in screen with an error. Options: move the keychain read off the main thread; show a "waiting for keychain permission" state; sign the Dev build; or have the owner choose Always Allow for the test binary and re-run 4.7 and step 5.
2. **D1:** add a second alias to the test account and re-run 4.5 on two different Mittr agents.
3. **P1:** the "Add new provider" row in the locked picker.
4. **O1, O2:** third-party connections from the engine and the app.
5. The sidebar's "Could not initialize workspace" message.
