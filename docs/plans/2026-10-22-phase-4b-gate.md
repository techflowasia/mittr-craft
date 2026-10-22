# Phase 4B gate: voice on the Dev build (Part A)

Branch `rebase/upstream-2.1.1`. This note records **Part A** of the phase 4B gate: the headless half, on a loopback stub platform, with fake media, a throwaway Chrome and no owner. **Part B** (the owner, a real microphone, the dev platform) has not run; its checklist is at the end.

| Run | When (22 Oct, +07) | Build HEAD | Platform | Who |
|---|---|---|---|---|
| Part A | 14:34–15:12 (L1, L1b; L2–L4 for X1 under R174) | `9e52b939d` (product code as `51d521290`; the commit adds gate stubs only). App built 14:40–14:44 | loopback stub (`scripts/mittr/stub-platform.mjs`), account SA | headless, no owner |

`9e52b939d` adds the gate helpers: speech readiness, transcribe, synthesize and scripted voice steps in the stub platform, and `scripts/mittr/voice-fixtures.mjs`, which makes fixture audio locally (`say` and `afconvert`, 16 kHz mono, 25 s of silence after the speech). None of them is in the app. The evidence (logs, JSON, screenshots, `ps`, `lsof` and TCC samples) is kept outside the repository. It holds no key, token, audio or transcript.

## Verdict

**Part A stopped at its binding stop condition (R169) after the first dictation.** The shortcut started a dictation in the gate window, and macOS raised a microphone permission request with a prompt (not a preflight). The prompt was answered "allow" 3.2 s later. R174 then allowed launches with no media call; three such launches (L2–L4) traced X1 and made no microphone, camera or prompting TCC request. The owner then chose to walk voice himself, so every row not run is marked **owner walk**.

| Group | PASS / FAIL / Part B / owner walk | Notes |
|---|---|---|
| Hygiene (build and static checks) | 9 / 1 / 0 / 0 | The mittr-ui suite failed 2 tests at the gate (finding 3); fixed in `20ef2c822`. |
| Dictation | 1 / 1 / 1 / 2 | The fake-device precheck passed; the dictation raised the microphone prompt (finding 1). |
| Read-aloud | 0 / 0 / 0 / 2 | |
| Settings | 0 / 0 / 0 / 1 | |
| Talk | 0 / 0 / 1 / 0 | Needs a microphone stream; Part B. |
| Turn loop | 0 / 0 / 0 / 3 | |
| Voice-only actions | 0 / 0 / 0 / 4 | |
| Guards and queued sends | 0 / 0 / 0 / 3 | |
| Quota | 0 / 0 / 0 / 2 | |
| Voice browser and desktop (F35) | 0 / 0 / 0 / 2 | |
| Chrome seams | 0 / 0 / 0 / 3 | |
| Accounts | 0 / 0 / 0 / 2 | |
| Remote and hosted | 0 / 0 / 0 / 3 | |
| Secrets | 3 / 0 / 0 / 1 | Over L1 and L1b. |
| C-02 | 0 / 0 / 0 / 1 | |
| Egress | 1 / 0 / 0 / 0 | `gitlab.com` is the unnamed v6 peer of phase 3 and 4A, traced (finding 4). |
| Isolation | 5 / 4 / 0 / 0 | TCC prompt (finding 1); real Chrome folder and keychain mtimes moved, unattributed; installed prod app cache. |
| **Total** | **19 / 6 / 2 / 29** | 56 rows |

## Method

- **Build.** `node scripts/mittr/build-desktop.mjs --flavor dev --gate`, once, under `sandbox-exec` with outbound traffic limited to loopback and unix sockets, with `MITTR_API_KEY`, `LITELLM_API_KEY`, the messaging token, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCHAMBER_DATA_DIR` and every `MITTR*` / `MITTRCRAFT_*` variable unset. Gate binary sha256 prefix `595462c74dad21cb`.
- **Launches.** Two launches of `packages/electron/dist/mac-arm64/MittrCraft Gate.app/Contents/MacOS/MittrCraft Gate`, started directly and quit with `kill -TERM <pid>` after checking the binary path:
  - L1 on a fresh HOME `/tmp/p4.OtnX`, L1b a relaunch on the same HOME;
  - `env -i`, every `XDG_*` and `TMPDIR` inside the temp HOME, `CFFIXED_USER_HOME`, `OPENCHAMBER_DESKTOP_USER_DATA_DIR`, `--use-mock-keychain`, a seeded `desktopLocalPort` 57761, `MITTRCRAFT_BROKER_URL` at the loopback stub (57711);
  - `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<HOME>/fixtures/sessions-en.wav --mute-audio --autoplay-policy=no-user-gesture-required`;
  - the 4A driver set-up: the stub `cua-driver`, the packed `agent-browser` behind a wrapper (which also records, then removes, `--headed` and `--init-script`), a seeded throwaway Chrome profile, the refusing proxy on 57731, `chromeHeaded` false.
  - L1b added `--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess` (gate tooling only), because the sandboxed audio service could not read the fixture (finding 2).
- **Window.** Read and driven through its DevTools port (57701). A hook recorded `getUserMedia` streams, `AudioBufferSourceNode.start` timestamps and voice fetches; it reads state only.
- **Sign-in.** SA, through the app's API, with `curl` taking the stub's redirect.
- **Transcripts.** The stub answers a fixture's sha256 with its transcript. Audio captured through the window is not the fixture's bytes, so window rows take the transcript from a queue set on the stub before the utterance; the stub records which way it answered (`fixture:<name>`, `queued`, `default`, `none`).
- **Guard.** Every call to the app, its DevTools port and the stub first checked that the listener was the test PID or its descendant (R46): 28 guarded calls, 0 refused. Port 57133 was free before both launches and at the end.
- **TCC.** `/usr/bin/log show --predicate 'subsystem == "com.apple.TCC"'` from 14:30, before the first launch, to 14:59. Lines naming `dev.mittrcraft.desktop.dev.gate` were joined to their full request by `msgID`. (zsh has a `log` builtin; the first two samples taken through it were empty and were redone with `/usr/bin/log`.)

## Part A results

### Hygiene (Step 1)

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| H1 | Gate build, leak scan, drivers, VAD files and notices | `node scripts/mittr/build-desktop.mjs --flavor dev --gate` (network-denied) | exit 0, 14:40:36–14:44:34. `1408 files: 255 translation keys, 4126 translated, 129 allowlisted, 0 unexplained, 0 unused allowlist entries`; agent-browser 0.38.1, cua-driver 0.28.2 (team YCK386LBJ7) and the notices packed; "4 VAD files are packed under Contents/Resources/web-dist/vad with their pinned sha256 values"; 1 ONNX Runtime chunk with the pinned version; "mittr-ui Tailwind utilities: all shipped (checked against 3 built stylesheets)". Step 5 listed upstream visible strings, reported only | PASS |
| H2 | Upstream touch | `node scripts/mittr/check-upstream-touch.mjs --no-write` | "upstream files touched: 36 of 40", "upstream touch check passed". T3 and T10 added no upstream file, so 36 + 0 + 0 | PASS |
| H3 | Type-check | `bun run type-check` | exit 0 | PASS |
| H4 | Lint | `bun run lint` | exit 0 | PASS |
| H5 | Test baseline | `node scripts/mittr/test-baseline.mjs` | exit 0, "no test failure outside the baseline" (scripts 1, sdk 1, ui 4, vscode 4 known; one entry stayed green: `server/lib/spaces/websocket.test.js`) | PASS |
| H6 | mittr-server | `iso bun run --cwd packages/mittr-server test` | 1554 of 1554 | PASS |
| H7 | mittr-ui | `iso bun run --cwd packages/mittr-ui test` | **68 of 69 files**: `registerMittrUsage.test.tsx` "settings search finds usage for quota and weekly" and "the model quotas heading names the week" fail (`Model Quotas` instead of `Weekly model quotas`). After `20ef2c822`: 69 of 69 | FAIL at the gate (finding 3); passes after |
| H8 | mittr-opencode | `iso bun run --cwd packages/mittr-opencode test` | exit 0, 0 failures | PASS |
| H9 | Neutral hook fixtures | `node scripts/mittr/neutral-hook-tests.mjs` | 0 findings | PASS |
| H10 | Gate stubs | `iso node --test scripts/mittr/stub-platform.test.mjs scripts/mittr/voice-fixtures.test.mjs scripts/mittr/stub-pages.test.mjs scripts/mittr/stub-cua-driver.test.mjs` | 36 of 36. RED first: 10 new stub-platform tests failing and the fixtures module missing; GREEN after. The real `say` / `afconvert` test ran (not skipped) | PASS |

### Dictation

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| V0 | Fake-device precheck (F3, M12) before any `getUserMedia` | `navigator.mediaDevices.enumerateDevices()` in L1 and L1b | 3 inputs, every label fake: "Fake Default Audio Input", "Fake Audio Input 1", "Fake Audio Input 2"; `permissions.query({name:'microphone'})` = `granted`. M12's worry (empty labels) did not happen. But this call itself made macOS microphone **preflight** checks (TCC 14:56:04 and 14:57:38, finding 1) | PASS |
| P4-V1a | With Mittr voice input on, the dictation shortcut on "what sessions are running" puts the text in the composer | Mittr dictation on (first run chose it: `/api/mittr/speech` `installed.stt: true`); stub queue "what sessions are running"; composer focused; ⌘⌥V, wait 7 s, ⌘⌥V | The overlay showed "Listening…" and a timer; one `getUserMedia` stream ("Fake Default Audio Input", `ended` after confirm). The audio service could not read the fixture (finding 2). At the first ⌘⌥V macOS logged a **microphone request with a prompt** (finding 1). After confirm the composer was empty; the stub saw **no** `/desktop/speech/transcribe`; no voice fetch left the window | FAIL (stop condition) |
| P4-V1b | Settings → Voice shows OpenAI-compatible, the loopback URL and model `mittr` (decision 3) | — | Not run: launches stopped. The server's own answer, read once: `/api/mittr/speech` = `offered: true`, `baseUrl http://127.0.0.1:57761/mittr-speech/v1`, `model mittr`, `voice mittr` | owner walk |
| P4-V1c | Readiness `not_configured`: microphone disabled with the admin line, no transcribe request | — | Launches stopped, then owner walk | owner walk |
| P4-V2 | stt quota: dictation shows `Voice input is out of quota until <when>`, microphone disabled, Retry recorded; clearing lifts the block | — | Needs a dictation through the microphone, which raised the prompt headless (finding 1). Part B step 8 | Part B |

### Read-aloud, settings, Talk

| # | Check | Result |
|---|---|---|
| P4-V3a | A 6000-character answer read aloud: ≥ 2 synthesize calls, every chunk plays, largest gap (the stub has `write a long answer` for this) | owner walk |
| P4-V3b | tts `not_configured`: a visible message | owner walk |
| P4-V4 | Both limits kept in `mittr-settings.json` across a restart; Preview sends one synthesize call | owner walk |
| P4-V5 | Talk: Listening → Thinking → Speaking, the reply shown; Escape closes, every track `ended`, `/api/mittr/voice/end` seen | Part B: Talk opens a microphone stream through MicVAD, the same `getUserMedia` that raised the prompt |

### Turn loop, voice-only actions, guards, quota

All owner walk. Each could run headless without a microphone through the app's own routes (`/api/mittr/voice/start`, `/transcribe` with a fixture WAV, `/turn`), which the stub scripts.

| # | Check | Result |
|---|---|---|
| P4-V6a | "send 'add a README' to the newest session": that session gets the prompt | owner walk |
| P4-V6b | "what did it answer": its latest reply, cut at the setting | owner walk |
| P4-V6c | "open …/form in Chrome and tell me the heading": headed session asked for (A-15), heading in the reply | owner walk |
| P4-V7a | "stop the newest session" asks first; "yes" stops it (`/interrupt`) | owner walk |
| P4-V7b | Two Chrome pages on one site: one question, one yes | owner walk |
| P4-V7c | "end the conversation", then a new Talk: asked again | owner walk |
| P4-V7d | "bye": the goodbye plays and the conversation ends | owner walk |
| P4-V8a | Step cap 2 with the Thai fixture: Thai closing sentence naming 2 steps | owner walk |
| P4-V8b | Send to a busy session: the composer queue shows it, delivered after | owner walk |
| P4-V8c | Rule-breaking mode: `refused_after_read`, the session gets nothing | owner walk |
| P4-V9a | Voice-step quota: Talk ends with the reset time, the last answer stays as text | owner walk |
| P4-V9b | stt quota: Talk disabled with the reset time | owner walk |

### Voice browser and desktop (F35), Chrome seams, accounts, remote and hosted, C-02

| # | Check | Result |
|---|---|---|
| F35a | Voice `browser.open` then `browser.snapshot` on a stub page | owner walk |
| F35b | Voice `computer.list_apps` against the stub daemon (never `open_app`) | owner walk |
| CS1 | A voice `chrome.open` on a new site raises no engine card | owner walk |
| CS2 | Removing the site in Settings mid-conversation: the next voice Chrome call asks again | owner walk |
| CS3 | An always-allowed site opens with no question | owner walk |
| AC1 | Switch to SB during a slow step: `account_changed`, no further step, conversation and Chrome allow end | owner walk |
| AC2 | SB's next dictation uses SB | owner walk |
| RH1 | Voice routes with `X-Forwarded-For: 203.0.113.9`: 403, readiness `here: false` | owner walk |
| RH2 | Speech endpoint with a relay header or the shim key: 401 | owner walk |
| RH3 | Packed `mittrcraft serve`: no Talk, no Mittr speech switch, `here: false` | owner walk |
| C-02 | Japanese: English Mittr strings, no raw key | owner walk |

### Secrets (over L1 and L1b)

| # | Check | Command | Observed | Result |
|---|---|---|---|---|
| S1 | The speech key is written nowhere else | key read from `voice-keys.json` into a shell variable inside one command, then `grep -r -F -l` over the app log, the engine folder, `userData`, the evidence and the stub log; counts only | key length 74 (`mc_speech_` + 64 hex); 0 files, 0 stub-log lines; never printed | PASS |
| S2 | `voice-keys.json` mode 600 | `stat -f %Lp` | `600` | PASS |
| S3 | `ps eww <engine>` holds no speech key | — | The engine had exited with L1b before the check | owner walk |
| S4 | No transcript text in any log | `grep -r -F -l` of the fixture transcripts over the app log, the engine folder and the stub log | 0. The stub records sha256, WAV facts and how it answered, never the text (stub test) | PASS |

### Egress

| # | Check | Observed | Result |
|---|---|---|---|
| X1 | Loopback only, apart from phase 3's known upstream peers | `lsof` every 0.3 s over the app tree and every process naming the temp HOME (405 samples). App main: GitHub API `20.205.243.168` (known), Cloudflare `104.16.9.34` (the npm registry, known), and `172.65.251.78` (`gitlab.com`) in both launches. `gitlab.com`'s IPv6 address is `2606:4700:90:0:f22e:fbec:5bed:a9b9`, the "Cloudflare v6 host" phase 3 and 4A recorded without a name, so it is a known peer, now named and traced (finding 4). No agent Chrome ran; the refusing proxy logged nothing | PASS (finding 4) |

### Isolation (Step 4)

| # | Check | Observed | Result |
|---|---|---|---|
| I1 | Real dirs diff (`stat` of the 15 MittrCraft, OpenChamber and OpenCode dirs, before 14:34 and after 14:59) | Not empty, and not from the gate: only the installed prod 1.22's `Application Support/MittrCraft/Cache` entries changed (as 4A I1). `~/.config/mittrcraft-gate`, `Application Support/MittrCraft Gate`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.config/openchamber` unchanged | FAIL (as 4A finding 11) |
| I2 | The real Chrome folder's top level (`stat -f %m`) | moved once, at **14:56:12, during L1**. No agent Chrome ran in Part A (the driver got only `close --all`). The owner's Chrome was running; unattributed | FAIL (unattributed) |
| I3 | No TCC entry or prompt in Part A | 51 gate-attributed TCC requests 14:55:52–14:57:38: `kTCCServiceListenEvent` 27 and `kTCCServiceScreenCapture` 12 preflights at start-up (R169: recorded), `kTCCServiceMicrophone` 14 lines over 6 requests, and **one non-preflight microphone request with `AUTHREQ_PROMPTING` at 14:56:37, result `authValue=2, authReason=2` at 14:56:41**. The 30 min before the first launch held none. The dialog watcher saw no new dialog process (the prompt came through an existing one) | FAIL (finding 1) |
| I4 | No upstream default dirs in the temp HOME | none of `.config/opencode`, `.local/share/opencode`, `.config/openchamber`, `.opencode`, `Application Support/OpenChamber` | PASS |
| I5 | Installed apps untouched | prod 23490 (helpers 23491, 23492, 24164; engine 24162): same PIDs and start times before and after; never contacted | PASS |
| I6 | Port 57133 and the guard | free before L1, before L1b and at the end; 28 guarded calls, 0 refused | PASS |
| I7 | R9 | `mittrcraft-dev` handler = the gate app before and after (expected, R164); LaunchServices plist sha1 unchanged; "MittrCraft Gate Safe Storage" lookup exit status 44 before and after | PASS |
| I8 | The owner's Chrome | main PID 67180 (since 09:10:33) before and after; 27 processes; one helper replaced by the owner's own browsing | PASS |
| I9 | The real login keychain file | mtime moved at 14:58:09, during L1b, with the mock keychain in use and no keychain prompt; unattributed (as 4A I4) | FAIL (as 4A finding 12) |

## Findings

1. **The fake media flags do not keep macOS's microphone check away in the packed gate app.** With `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, and every input labelled "Fake":
   - `enumerateDevices()` made `kTCCServiceMicrophone` preflight checks through `coreaudiod` for the gate's helper (14:56:04 and 14:57:38);
   - the dictation's `getUserMedia` made a non-preflight microphone request with a prompt at 14:56:37. It was answered allow 3.2 s later (`authReason=2`, a person's consent);
   - TCC charged both to the process that launched the gate (the controller's tool host), not to `dev.mittrcraft.desktop.dev.gate`. So the grant may now sit on that parent app in System Settings → Privacy & Security → Microphone, and the owner should look there.
   - Whether the real microphone delivered audio is not known: the fake capture could not read its file at that moment (finding 2), nothing reached the stub, and no voice request left the window.
   - Consequence: no Part A row that opens a microphone stream (dictation, Talk) can run headless on this build. Those rows are Part B or owner walk, and the same applies to the brief's whole fake-media premise (S5 had already seen preflights, F3). Rows that need no media call can run through the app's routes if launches resume.
2. **The fixture never reached the fake capture.** Chromium's audio service is sandboxed and logged "Failed to read /tmp/p4.OtnX/fixtures/sessions-en.wav as input to the fake device". L1b relaunched with the audio service in-process and unsandboxed (`--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess`); the precheck there again made microphone preflights. Gate tooling only.
3. **The mittr-ui suite was red at HEAD** (2 tests in `registerMittrUsage.test.tsx`). `0d7ded3ab` (I4) changed the test's import from `../product-ui-plugin` to `../MittrRoot`, so the plugin's dictionary overlay was never registered in that test. Product code is unaffected (the entry still registers it). Fixed in `20ef2c822` by importing the entry for its registration; 69 of 69 after. The fix pass reported 716/716; that run must have predated the change.
4. **X1 traced: what connects to `gitlab.com` at start-up.**
   - **Process:** the gate's Electron main process, where the upstream server runs in-process. Traced in L4 with a connect and fetch logger injected through the main process inspector (`--inspect`, gate tooling only), which refused every non-loopback connection.
   - **Trigger:** once the window is signed in and connected, `packages/ui/src/App.tsx:266` calls `refreshSourceControlAuth(apis.sourceControl, { force: true })` (`useSourceControlAuthStore.refreshAll`). It reads `GET /api/source-control/instances`, which always lists `https://gitlab.com` (`packages/web/server/lib/source-control/routes.js:175`), then `GET /api/source-control/gitlab/auth/status?instance=https://gitlab.com` for it.
   - **Server path:** `packages/web/server/lib/gitlab/routes.js:462` → `buildStatus` (`:157`). With no saved GitLab account and no `glab` login it calls `probeGitLabAuth` (`:187-189`), which sends `GET https://gitlab.com/api/v4/version` (`packages/web/server/lib/gitlab/device-flow.js:48-51`) through the `fetch` the routes captured at start (`routes.js:104`).
   - **Data sent:** one unauthenticated GET with `Accept: application/json` and Node's default headers. No token, no repository URL, no account or directory. It tells gitlab.com that this Mac runs the app, from its IP address, on every window connect (twice in L4, 4 s apart).
   - **1.22 does not do it:** `origin/develop` has no `packages/web/server/lib/gitlab/`; the only `gitlab.com` mention there is a skills-catalog doc line. The peer is 2.1.1's new GitLab source-control integration.
   - **Already seen, unnamed:** `gitlab.com`'s IPv6 address `2606:4700:90:0:f22e:fbec:5bed:a9b9` is the "Cloudflare v6 host" in the phase 3 and 4A egress tables. Owner note: whether to keep upstream's GitLab probe (a hook to drop the default instance would count toward the cap).
   - Related: in L1 and L2 the stub saw a sign-in start 5–6 s after each window opened that the controller did not make, as in phase 3 I7. Each such press sends the authorize link to the default browser.
5. **Unattributed moves of the real Chrome folder's top level (14:56:12) and the login keychain (14:58:09)** during the two launches, with no agent Chrome and the mock keychain. The same class as 4A findings 11–12.

## Touch count

`node scripts/mittr/check-upstream-touch.mjs --no-write`: **36 of 40**, passed (36 + T3 0 + T10 0). Task 11 adds no upstream file:

| File | Owned | Why |
|---|---|---|
| `scripts/mittr/stub-platform.mjs` (+ test) | yes | speech readiness, transcribe, synthesize and voice-step routes and modes for the gate |
| `scripts/mittr/voice-fixtures.mjs` (+ test) | yes | fixture audio made locally, sha256 map, refused inside the repository |
| `packages/mittr-ui/src/quota/registerMittrUsage.test.tsx` | yes | finding 3 |

## Needs the owner

- **Finding 1, before anything else:** check System Settings → Privacy & Security → Microphone for an entry granted at 14:56 on 22 Oct to the app that launched the gate, and decide whether to remove it.
- **The owner walk:** every row marked "owner walk" (owner's choice after R174, since voice is ported from 1.22). Launches with no media call proved clean of microphone and prompt TCC requests (L2–L4), so these rows could still run headless if wanted.
- **Dictation and Talk rows (P4-V1a, P4-V2, P4-V5, and the window half of P4-V6–V9):** Part B only, with the real microphone, since headless fake media raises the same prompt.
- Finding 4 (the `gitlab.com` probe on every window connect) and finding 5 (unattributed mtimes and window sign-ins).
- Carried from the plan: decisions 1–15, R155, I3, I5, the Silero licence wording.

## Platform follow-ups

- Whether the dev platform has `voice.end` on its fast decision list (Part B step 5 tells).
- A vision flag in the catalog (4A).

## Part B checklist (for the owner)

One sitting, with you at the keyboard. Say yes before each numbered step. You type every password and answer every macOS dialog; I only read results.

0. **Before we start.** Look at System Settings → Privacy & Security → Microphone and tell me what is listed (finding 1). Launch the gate app yourself from Finder (`packages/electron/dist/mac-arm64/MittrCraft Gate.app`), so macOS charges the microphone to "MittrCraft Gate" and not to the tool I run in.
1. **Sign in.** Sign in as account A on a fresh HOME, on the dev platform. I record the microphone list before.
2. **Microphone.** Press Talk. macOS asks about the microphone: answer it as you like, and tell me which app name the dialog shows.
3. **Dictation (P4-V1).** Put the cursor in the composer, press ⌘⌥V, say one Thai sentence, press ⌘⌥V again. The text should appear in the composer.
4. **Read aloud (P4-V3).** Turn on "Read aloud through Mittr" in Settings → Integrations → MittrCraft voice. Ask a session for a long answer and press read aloud on it. Listen to the end and tell me if any gap felt too long.
5. **Talk (P4-V5, P4-V6).** Press Talk and say, one at a time: "what sessions are running?", "send 'add a README' to the newest session", "what did it answer?". Then press Escape: the bar should close.
6. **Chrome by voice (P4-V7).** Press Talk and say "open example.com in Chrome and tell me the heading". Chrome opens visibly on your own profile; it asks once; say "yes"; it should say the heading. Then ask for a second page on the same site: it should not ask again. Say "end the conversation", press Talk again, and ask for a page: it should ask again.
7. **Step limit (P4-V8).** In Settings set "Most actions per spoken request" to 2. Press Talk and ask in Thai for something that needs several steps. It should stop with a Thai sentence that says it did 2 steps. Put the setting back.
8. **Quota (P4-V9, P4-V2).** Only if you set account Q's speech quota low on dev first. Otherwise we skip it and it stays NOT RUN.
9. **Clean-up.** End Talk, close the voice Chrome, restore Settings, and decide whether to remove the microphone grant. I record everything after.
