# Phase 4B: how 2.1.1 carries Mittr speech, the voice reads and the microphone

Date: 2026-10-22. Branch `rebase/upstream-2.1.1`, base `321c6c5a4`. Scripts:

- `node scripts/mittr/probe-voice.mjs --json <out>` for S1 and S2;
- `bun test packages/mittr-ui/src/voice/readAloudTiming.test.ts` for S3, kept as Task 10's regression test;
- S4 is read from the code;
- `node scripts/mittr/probe-voice-window.mjs --json <out> --app <MittrCraft Gate.app> --fixture <speech.wav>` for S5;
- `node scripts/mittr/probe-engine-v2.mjs --only voice --json <out>` for S6 (P19 to P24).

Every run used a fresh temporary HOME with the `p4t` prefix, every `MITTR*`, `OPENCODE*` and `OPENCHAMBER*` variable unset, and loopback stubs only. The evidence JSON is kept outside the repository. It holds no key, bearer, audio or transcript: the stubs record names, sha256 values, WAV headers and the values of `model`, `voice`, `response_format` and `speed` only.

## The short answer

- **Speech goes through 2.1.1 as it is.** Dictation (S1) and read-aloud (S2) reach `/mittr-speech/v1` with the stored `stt` and `openaiCompatible` keys, and the audio passes through unchanged. Task 3 needs no fallback hook.
- **Refusals keep our text, with upstream's prefix.** Dictation shows `429 <our text>` with a Retry button (owner decision 5). Read-aloud's route answers 500 `Failed to generate speech: 429 <our text>`. There is one HTTP attempt each time.
- **Read-aloud timing is fine, but one chunk can be huge.** There is no gap with 2 s synthesis. A 4200-character Thai sentence goes out as one request, so Task 3's endpoint splits it.
- **The shortcut ignores `disabled`, and the composer has no product slot** (S4, decision 5 as F6 ruled).
- **S5 stopped at its binding stop condition.** The one gate launch wrote macOS TCC log entries naming the gate's bundle id. They were preflight checks for Input Monitoring and Screen Recording, made when the window opened, with no prompt and no microphone entry. Each names the launching parent process as the responsible app. By the brief, every launch stops here. getUserMedia was never called, so the microphone, the live CSP and the VAD load in the window are NOT RUN.
- **The engine reads work** (P19 to P24). There is no todo route. A send to a busy session is steered into the running turn, so voice queues (F9). The queue's `sendConfig` comes from the session record plus the latest assistant message.
- Nothing tried to leave the machine in S1, S2 and S6. S5's egress was not recorded.

## Results

| Scenario | Verdict | Key fact |
|---|---|---|
| S1 dictation through upstream's OpenAI-compatible STT | PASS | The stub got one `POST /mittr-speech/v1/audio/transcriptions` carrying the `stt` key, a 16 kHz mono 16-bit `audio/wav`, `model: mittr`, and `response_format: json`. The client got `final` with the marker text. A 429 or 503 refusal comes back as one `error` with our text behind the status code, `retryable: true` and no `reasonCode`. There was one HTTP attempt each time. |
| S2 read-aloud through `/api/tts/speak` | PASS | The stub got one `POST /mittr-speech/v1/audio/speech` carrying the `openaiCompatible` key. The route answered 200 `audio/wav`, with the stub's bytes unchanged. A 429 or 503 refusal becomes a route 500 whose `error` keeps our text behind `Failed to generate speech: <status>`. There was one HTTP attempt each time. |
| S3 chunked read-aloud timing | PASS (recorded) | 27 chunks. The longest is 4200 characters (> 4000). The first audio plays at 2.0 s, the largest gap is 0 s, and every next chunk is fetched while the one before it plays. |
| S4 the composer footer | read | The shortcut starts a dictation whatever `disabled` says. Desktop passes no `disabled`, and mobile passes `dictationActive`. No product slot renders in the composer. |
| S5 microphone, VAD and ONNX in the 2.1.1 window | STOPPED (stop condition) | The launch wrote TCC entries naming `dev.mittrcraft.desktop.dev.gate`: preflight-only `kTCCServiceListenEvent`, plus WindowServer `ListenEvent` and `ScreenCapture` checks, with no microphone service and no prompt. By the brief, every launch stops. The getUserMedia, live CSP and VAD rows are NOT RUN. Read from the files: `NSMicrophoneUsageDescription` is present, the four VAD files are packed under `Contents/Resources/web-dist/vad` with the pinned sha256 values, and no CSP covers the packaged UI. |
| P19 sessions per directory with status | PASS | `session.list { withStatus: true }` scoped by the context directory lists only that directory's sessions, each with `id`, `title` and `status.type` (`busy` for the hanging one, `idle` for the others). |
| P20 the latest assistant text | PASS | In a 60-message session, `session.messages { role: 'assistant', last: true }` made one page call (`limit=100&order=desc`), and that page already held the newest reply. |
| P21 todo and pending permission routes | PASS (no todo route) | `GET /api/session/:id/todo` and `/todos` answer 404, and v2 has no todo tool. Pending permissions: `GET /api/session/:id/permission` and `GET /api/permission/request`, both scoped by `x-opencode-directory`. |
| P22 interrupt while a turn hangs | PASS | `POST /api/session/:id/interrupt` answered 200 `{ interrupted: true }`. The stub's request closed 32 ms later and `session.execution.interrupted` came at 58 ms. A single global event stream carries events for both directories. |
| P23 a send to a busy session | PASS (recorded: steered) | The engine took the send as an inbox item with `delivery: steer`, then delivered it into the running execution once the hanging step ended, with no idle in between. `GET /api/session/:id` holds `model { providerID, id, variant }` but no `agent`. |
| P24 2.1.1's `addToQueue` | PASS | `sendConfig` is required on the server-owned queue (`throws "A queued message needs a provider and model to be delivered later."`, with no request made). With it, the store posts `POST /api/message-queue/sessions/:id/items` `{ directory, item: { content, text, attachments, context, sendConfig } }`. |

## S1: dictation through upstream's OpenAI-compatible STT

Set-up:

- A loopback express app runs upstream's `registerTtsRoutes` and `createDictationRuntime`. That runtime is upstream's WebSocket `/api/dictation/ws`, its `DictationStreamManager`, and `createDictationService`'s openai-compatible `OpenAICompatibleTranscriptionSession`.
- `OPENCHAMBER_DATA_DIR` is inside the temp HOME. Its `voice-keys.json` (mode 600) holds a marker key for `stt` and another for `openaiCompatible`, and upstream's `describeVoiceKeys()` read both as set.
- OpenAI SDK 7.18.0.

The client is a plain WebSocket that sends what 2.1.1's `useDictation` sends:

- `start` with `format: audio/pcm;rate=16000;bits=16` and `options { provider: 'openai-compatible', openaiCompatible: { baseUrl: <stub>/mittr-speech/v1, model: 'mittr' } }`, with no key;
- three 1 s chunks of a tone made in code;
- `finish` with `finalSeq: 2`.

**What reached our endpoint (one request):**

- `POST /mittr-speech/v1/audio/transcriptions`.
- `authorization` is `Bearer <the stt marker>`: the server added the stored `stt` key (`service.js`, `apiKey: config.apiKey || readVoiceKey('stt')`).
- Multipart fields, in order:
  - `file`, with filename `audio.wav` and type `audio/wav`, a 96 044-byte WAV whose header reads 16 000 Hz, 1 channel, 16 bits;
  - `model`, `mittr`;
  - `response_format`, `json`.
- `language` is not sent when the person has set no STT language, because `useDictation` adds it only when `sttLanguage` is set.
- The header names are `accept`, `accept-encoding`, `accept-language`, `authorization`, `connection`, `content-length`, `content-type`, `host`, `sec-fetch-mode`, `user-agent` and the SDK's `x-stainless-*` headers (`arch`, `lang`, `os`, `package-version`, `retry-count`, `runtime`, `runtime-version`).

**What the client got:** `ready`, `ack -1`, `ack 0`, `ack 1`, `ack 2`, `finish_accepted { timeoutMs: 25000 }`, `partial` and `final`, both carrying `probe heard you`.

**Refusals.** Each refusal used the same procedure. The stub answered with `x-should-retry: false`.

| Stub answer | HTTP attempts | Client `error` payload |
|---|---|---|
| 429 `{ error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', message: 'Voice input is out of quota until Tue 27 Oct, 00:00', resets_at } }` | 1 | `error: "429 Voice input is out of quota until Tue 27 Oct, 00:00"`, `retryable: true`, no `reasonCode` |
| 503 `{ error: { code: 'not_configured', message: 'Your Mittr admin has not set up speech models yet' } }` | 1 | `error: "503 Your Mittr admin has not set up speech models yet"`, `retryable: true`, no `reasonCode` |

- **Our text survives**, but the SDK puts the HTTP status in front of it (`APIError` message `<status> <message>`).
- **It is retryable.** `stream-manager.js` marks every STT session error `retryable: true`. In 2.1.1's `ComposerDictation.tsx`, the failed overlay always shows Retry (the `retry` button, lines 572-579), and shows the error text in the status colour (lines 473-477). So the person sees `429 Voice input is out of quota until …` and a Retry button.
- `x-should-retry: false` was honoured: no second attempt.

## S2: read-aloud through `/api/tts/speak`

The POST was what 2.1.1's `useServerTTS` sends for an OpenAI-compatible server: `{ text: 'สวัสดี hello', baseURL: <stub>/mittr-speech/v1, model: 'mittr', voice: 'mittr' }`, with no key.

**What reached our endpoint (one request):**

- `POST /mittr-speech/v1/audio/speech`, `content-type: application/json`.
- The bearer is the `openaiCompatible` marker. The route reads `readVoiceKey('openaiCompatible')` when a `baseURL` is set.
- Body keys: `input`, `model`, `response_format`, `speed`, `voice`.
  - `model: mittr` and `voice: mittr`.
  - `response_format: mp3`. Upstream always asks for mp3 from a custom server (`service.js`).
  - `speed: 0.9`, the route's default.
  - `input` is the posted text, 12 characters, unchanged.
  - `instructions` is not sent to a custom server.

**What came back:** the stub answered `audio/wav`, a 24 kHz mono 16-bit WAV of 0.5 s (24 044 bytes). The route answered 200 with `content-type: audio/wav`, and its bytes equal the stub's. Upstream passes the endpoint's `content-type` through, so our endpoint may answer WAV even though mp3 was asked for.

**Refusals:**

| Stub answer | Route status | Route JSON | HTTP attempts |
|---|---|---|---|
| 429 quota (as S1) | 500 | `{ error: "Failed to generate speech: 429 Voice input is out of quota until Tue 27 Oct, 00:00", detail: { model, voice, hasBaseURL: true } }` | 1 |
| 503 not configured (as S1) | 500 | `{ error: "Failed to generate speech: 503 Your Mittr admin has not set up speech models yet", detail: { … } }` | 1 |

- 2.1.1's `fetchTTSAudioChunk` throws `errorData.error`, so the reset text reaches the UI's message with that prefix.
- In chunked mode, `runChunkedTTSPlayback` skips a failed chunk and logs a warning, and the person hears nothing (`all-failed`).
- The route logs the SDK error object (status, response headers, the error body). It does not log the request's key.

## S3: chunked read-aloud timing

The test builds a 6000-character answer of Thai and English sentences, in three paragraphs. The middle paragraph is one Thai sentence of 4200 characters with no full stop. It runs upstream's `splitSentencesForTTS` and `runChunkedTTSPlayback` under bun's fake timers. `fetchChunk` resolves 2.0 s after it is called. A chunk plays for `characters / 14` seconds on a virtual clock.

| Fact | Value |
|---|---|
| Chunks | 27 (lengths 62 to 79, plus one of 4200) |
| Longest chunk | 4200 characters, the whole Thai sentence as one request |
| Time to first audio | 2.0 s |
| Largest gap between one chunk's end and the next one's start | 0 s |
| Is chunk N+1 fetched while N plays? | yes, for every N; fetches run one at a time, each starting when the previous one is scheduled |
| Total playback | 428.6 s |

- **A gap can only come from a chunk shorter than the synthesis time.** At 14 characters a second, 2 s of synthesis covers 28 characters. The splitter's minimum chunk is 40 characters (except a short text on the fast path), so there is no gap with these settings. The test's second case shows the gap that a 13-character chunk leaves (about 1.07 s).
- **The 2 s gap stop condition does not fire.** Read-aloud keeps upstream's player.
- **The 4000-character stop condition fires:** Task 3's speech endpoint splits an input over 4000 characters, as specified there.

## S4: the composer footer (read from the code)

| Where | Call site | `disabled` it passes | Where a slot call fits |
|---|---|---|---|
| Desktop | `ComposerFooter.tsx:279-291`, `{!isBtw ? <MemoComposerDictation … /> : null}` in the right-hand row (`:277`) | none: the prop is not passed. The trigger is `disabled={disabled \|\| isActive}` inside `ComposerDictation.tsx:406`, with its `title`/`aria-label` computed there (`:407-408`) | after `:291`, before `ComposerActionButtons`, inside the same `!isBtw` guard |
| Mobile | `ComposerFooter.tsx:198-216`, `{!isBtw && showDictation ? <button … onClick={onStartDictation} disabled={dictationActive} title={t('chat.dictation.start')} …>` | `dictationActive` | in the `flex items-center gap-x-1 flex-shrink-0` group (`:197`), beside the mic button and before `ComposerActionButtons` (`:218`) |

- **The engines.** Mobile's recording engine is a separate `MemoComposerDictation` with `renderTrigger={false}` (`ChatInput.tsx:4250-4265`). The mobile comment composer mounts a third one (`MobileCommentComposer.tsx:125`) that no footer controls.
- **The shortcut ignores `disabled`.** `ComposerDictation.tsx:207-220` listens for `openchamber:dictation-toggle` and calls `startDictation()` whenever the status is `idle`. `disabled` is read only by the trigger button (`:406`). The dispatchers send the event without checking anything about dictation:
  - `useKeyboardShortcuts.ts:304-316`, action `toggle_dictation`, checks only for a side-question composer and open dialogs;
  - the mini window's `useMiniChatKeyboardShortcuts.ts:96-100`.

  This is owner decision 5, ruled by F6: accept by default, so a blocked shortcut starts a dictation that fails with the reset text. The alternative is +1 for `ComposerDictation.tsx`.
- **No product slot renders inside the composer.** The slot names are `sidebar-footer`, `about-dialog`, `about-settings`, `providers-page`, `integrations-page`, `session-auth-methods` and `assistant-message-footer` (`lib/product-plugins.ts:26-34`). Their call sites are in `AboutDialog`, `ProviderGrid`, `AboutSettings`, `IntegrationsPage`, `SessionAuthGate`, `SidebarFooter` and `ChatMessage`. None is under `components/chat/composer`.

## S5: microphone, VAD and ONNX in the 2.1.1 window

**The build.** S5 used the `--gate` build only (F2), and no second build was started.

- At 11:27 Task 6's own `node scripts/mittr/build-desktop.mjs --flavor dev --gate` ran in this worktree and exited 0 (leak scan `0 unexplained`). It staged the four pinned VAD files into `resources/web-dist/vad` after the UI build (F4's shipped path) and verified them in the packed app.
- Task 6 committed that tree a minute later as `fbe46fb43`, which is the HEAD this note builds on.
- That build packed `MittrCraft Gate.app` (`dev.mittrcraft.desktop.dev.gate`, 2.1.1+mittr.1). It was copied with APFS clone to a temp folder `/tmp/p4t.app.*`, so a later build could not change it under the launch, and `codesign --verify --deep --strict` passed on the copy.
- Nothing was written under `packages/web/public`.

**The fixture** was made locally. `say -v Samantha` spoke one English sentence, `afconvert` turned it into 16 kHz mono PCM16, the speech was cut to 2.0 s, and 20 s of digital silence were appended. It lived in temp folders only and was deleted after the run.

**The launch (one).** The probe started `MittrCraft Gate` directly, with:

- the environment cleared down to `PATH`, `HOME` and `CFFIXED_USER_HOME` (both `/tmp/p4t.*`), `TMPDIR`, the four `XDG_*` folders inside the HOME, `OPENCHAMBER_DESKTOP_USER_DATA_DIR`, `MITTRCRAFT_BROKER_URL` at the loopback stub platform, `USER` and `LANG`;
- a seeded free `desktopLocalPort`;
- `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<fixture> --mute-audio --autoplay-policy=no-user-gesture-required --use-mock-keychain --remote-debugging-address=127.0.0.1 --remote-debugging-port=<free port>`.

The app logged `app starting` with exactly those arguments, and DevTools listened on the chosen loopback port.

**What stopped it.** At the launch second, macOS's TCC log recorded:

| Requesting process | Service | Kind | Result |
|---|---|---|---|
| `dev.mittrcraft.desktop.dev.gate` (the app) | `kTCCServiceListenEvent` | `TCCAccessRequest`, `preflight=yes` | `authValue=2` |
| `dev.mittrcraft.desktop.dev.gate.helper.Renderer` | `kTCCServiceListenEvent` | preflight | `authValue=2` |
| WindowServer, for the app's window | `kTCCServiceListenEvent` (×3), `kTCCServiceScreenCapture` (×1) | preflight | `authValue=2` |

- Every entry names the process that launched the app as its "responsible" app, not the gate.
- No prompt appeared. No microphone (`kTCCServiceMicrophone`) entry appeared.
- The real `~/.config/mittrcraft-gate`, `~/Library/Application Support/MittrCraft Gate` and `~/Library/Logs/MittrCraft Gate` do not exist.

The brief's stop condition reads "a TCC log entry or prompt appears: stop every launch and report", so the run stopped there. The probe did not reach the fake-device precheck (F3), and so never reached getUserMedia.

**The run did not end cleanly.**

- After start-up the app wrote nothing more to its log and exited. The probe waited without a timeout on the DevTools connection.
- The probe and the stub platform it started were stopped by PID. No process naming the temp HOME or the gate app was left, and the temp folders were removed.
- The probe now times out every DevTools call (5 s fetches, 10 s socket open), and summarises TCC lines by service and preflight.
- Why the app exited was not looked into, because no relaunch is allowed.

**Read from the files and the code instead** (no launch needed):

| Row | Fact |
|---|---|
| CSP of the main document | No CSP. The packaged UI comes from `openchamber-ui://app` (`entry.mjs:63`: standard, secure, fetch, CORS), served from `Contents/Resources/web-dist`. Its `index.html` has no CSP meta tag, and Electron sets no CSP header for the scheme. The server's CSP is `frame-ancestors` only (`server/index.js:2125-2160`) and applies to server responses, not to the UI scheme. Live check: NOT RUN. |
| Permission handler for the main window | None. `main.mjs:1050-1080` sets request, check and device handlers on the browser panel's session only. The main window uses the default session, where Electron grants. Live check: NOT RUN. |
| The packed VAD files | Under `Contents/Resources/web-dist/vad`, sha256 prefixes `8a48fdc7…` (worklet), `2623a295…` (Silero v5), `e13f7f94…` (ORT mjs), `3398c10d…` (ORT wasm), the pins. Served content types: NOT RUN. |
| `getUserMedia`, track label, `readyState` after stop | NOT RUN (stop condition) |
| MicVAD loads, `onSpeechEnd` within 10 s, sample count | NOT RUN (stop condition). F4: this row was a proxy only; it is proved in Task 9's live check and gate P4-V5. |
| `NSMicrophoneUsageDescription` | Present, Electron's default `This app needs access to the microphone` (F5). The entitlements hold `com.apple.security.device.audio-input`. |
| R164 | `mittrcraft-dev:` now opens the worktree's `dist/mac-arm64/MittrCraft Gate.app`, as R164 expects of a gate build. |

## S6: engine reads (`probe-engine-v2.mjs --only voice`)

Set-up: phase 3's probe set-up as 4A built it.

- The bundled engine `opencode v2.0.22` runs in a fresh temp HOME, with the loopback stub provider and the refusing recording proxy, and the `lsof` sampler on the engine tree.
- There are two git repositories, `work` and `work2`.
- Upstream's `createOpenChamberControlService` uses upstream's `createOpenChamberSessionService`. Both get engine clients whose `fetch` is the R46 port guard.
- The stub provider gained a `hang` mode. It streams one chunk and holds the response open until it is released.

### P19: `session.list { withStatus: true }` for two directories

The call was `control.execute('session.list', { withStatus: true }, <dir>)`, once for each directory, while one session in `work2` was hanging.

- `work`: one session, `{ id, title: 'probe stub/m1', status: 'idle', directory: work }`.
- `work2`: the hanging session `busy` and a second session `idle`. Neither list holds the other directory's sessions.
- Session records carry `cost`, `id`, `location`, `model`, `projectID`, `time`, `title` and `tokens`. The status comes from one global `GET /api/session/active`, reported as `busy`, `idle` or `unknown`.

### P20: the latest assistant text in a 60-message session

- 30 turns gave 30 user and 30 assistant messages, plus 30 `idle` records, for 90 records in all. The stub gave each reply its own text.
- `control.execute('session.messages', { sessionId, directory, role: 'assistant', last: true })` answered one message, the last reply, with `model: stub/m1`, `completedAt` set and `sessionStatus: idle`.
- **Paging calls:**
  1. `GET /api/session/active`;
  2. `GET /api/session/<id>/message?limit=100&order=desc`, one page.

  A second, unbounded read happens only when fewer than one matching message is found in a full page.
- **Page facts.** With no `limit`, the engine answers 50 records, newest first. With `limit=100&order=desc` it answered all 90. Each page has `{ cursor: { next, previous }, data }`. The newest reply is on the first page either way.

### P21: todo and pending permissions

- **Todo: no route.** `GET /api/session/:id/todo` and `GET /api/session/:id/todos` both answer 404. The session record has no todo field. 2.1.1 notes that v2 dropped `todowrite`/`todoread` (`packages/ui/src/lib/opencode/tools.ts:6`).
- **Pending permissions.** The request was created with `POST /api/session/:id/permission` under a managed `ask` rule, and the first create answered `ask`.
  - `GET /api/session/:id/permission` answered 200 with 1 item.
  - `GET /api/permission/request` answered 200 with 1 item, the same id.
  - Both use the header `x-opencode-directory` (the directory, percent-encoded).
  - Item fields: `action`, `id`, `metadata`, `resources`, `save` and `sessionID`. The create sent no `source`, so the item has none.
  - A `reject` reply answered 204.

### P22: interrupt while a stub turn hangs

- `POST /api/session/:id/interrupt` with `x-opencode-directory: <work2>` answered 200 `{ interrupted: true }`. 4A's P18 had already proved the route, and that it aborts a tool's signal.
- The stub saw its streaming request closed 32 ms after the interrupt.
- The session's events on the one stream were `session.text.ended` (35 ms), `session.step.streamed` (35 ms), `session.step.failed` (58 ms) and `session.execution.interrupted` (58 ms).
  - The first three carry `location.directory` `<work2>`, but `session.execution.interrupted` has no `location.directory`, so it must be matched by `sessionID`.
  - No `session.idle` or `session.status` event is sent in v2.
- `session.status` afterwards answered `idle`.
- **The one global event stream** (`/api/event`, opened with the `work` directory header) carried events for both `work` and `work2`.

### P23: `session.send` to a busy session

- The session was hanging (`session.status` `busy`) when `control.execute('session.send', { sessionId, prompt })` answered `promptDispatched: true`, `model { providerID: stub, modelID: m1 }`, `agent: build` and `variant: default`.
- **The calls it made:**
  1. `GET /api/session`;
  2. `GET …/message?limit=100&order=desc`, twice;
  3. `GET /api/session/:id`;
  4. `GET /api/model`, `GET /api/agent` and `GET /api/config`;
  5. **`POST …/model` (204) and `POST …/agent` (204) on the busy session**;
  6. `POST …/prompt` (200).
- **What the engine did: steered.** The inbox held one item with `delivery: steer` (fields `delivery`, `id`, `payload`, `sessionID`, `time`, `type`). The stub saw no new request while the step hung. The released step ended, and the next request (49 ms later) carried the sent text in the same execution: there was no idle in between, and one `session.execution.succeeded` came after it.
- **Where the selection lives:**
  - `GET /api/session/:id` has `model { providerID, id, variant }` and **no `agent`**.
  - The latest assistant message record has `agent` (`build`) and `model { providerID, id, variant }`.
  - A user message record has only `id`, `text`, `time` and `type`.
  - So a queued prompt's `sendConfig` is `{ providerID: model.providerID, modelID: model.id, variant: model.variant }` from the session record, plus `agent` from the latest assistant message.
  - `session.send` itself fell back to the default agent (`build`), because the session record has none.

### P24: 2.1.1's `messageQueueStore.addToQueue`

- **From the source:**
  - `addToQueue(target: { runtimeKey, directory, sessionId }, { content, text?, agentMention?, attachments?, context?, sendConfig? })`;
  - `QueuedMessageSendConfig = { providerID, modelID, agent?, variant? }`;
  - at most 20 items per session.
- The store was run in bun against a recording `runtimeFetch`, with the desktop runtime (server-owned queue):
  - `createMessageQueueTarget` answers `null` for a missing directory or session;
  - without `sendConfig`, `addToQueue` throws `A queued message needs a provider and model to be delivered later.`, removes its optimistic entry, and makes no request;
  - with `sendConfig { providerID, modelID, agent, variant }` it posts `POST /api/message-queue/sessions/:id/items` with `{ directory, item: { attachments, content, context, sendConfig, text } }`, and the queue then holds the server's copy with the same `sendConfig`.
- The server route is `message-queue/runtime.js:907`.
- **Nothing the server cannot know.** Provider, model and variant come from `GET /api/session/:id`, the agent from the latest message record (P23), and the directory from the session's `location`. The `runtimeKey` belongs to the window, which is where Task 8 calls the store.

## Timings

- Dictation: `finish_accepted` came at once with `timeoutMs: 25000`. The whole S1 and S2 run took 4.8 s against the stub, the probe's own waits included.
- Engine: plain turns settled in 73-120 ms. The interrupt reached the stub in 32 ms, and the session was idle in 58 ms. The steered send was carried 49 ms after release.
- S5: DevTools was listening within a second of the start. The TCC preflights came in the same second.

## Outbound connections

- S1/S2: `lsof` on the probe process every 250 ms (17 samples) saw no non-loopback peer. The port guard checked 4 calls and refused 0.
- S6: the engine's proxy saw 0 attempts. `lsof` took 43 samples over 8 PIDs and found no non-loopback remote and no unexplained loopback peer. The engine log names no non-loopback host. The port guard checked 134 engine calls and refused 0. Port 57133 was not listening. No engine process was left after clean-up.
- S5: the app ran under the loopback stub platform. The probe's `lsof` record was lost when the probe was stopped, so S5's egress is not recorded. It is not claimed clean.

## Stop conditions and what they force on later tasks

- **S1 passed.** Task 3's dictation half goes on through upstream's openai-compatible provider, with no fallback in `dictation/service.js`.
- **S1 refusal: owner decision 5 applies.** The text survives with an HTTP status prefix (`429 …`, `503 …`), but the error is `retryable: true` and the failed overlay always offers Retry. The choice is to accept the prefix and the Retry, or +2 for `ComposerDictation.tsx` and `stream-manager.js`. There was one HTTP attempt each time, so there is no owner note on retries.
- **S2 passed.** Task 3's read-aloud half goes on through `/api/tts/speak`, with no fallback in `tts/routes.js`. Task 3's endpoint:
  - may answer `audio/wav` although `mp3` is asked for;
  - ignores `speed` or honours it;
  - gets its refusal text to the UI only as `Failed to generate speech: <status> <text>` (F34).
- **S3:** read-aloud keeps upstream's player, since there is no gap over 2 s. Task 3's speech endpoint splits an input over 4000 characters (one 4200-character Thai sentence arrives as one request). Task 10 keeps `readAloudTiming.test.ts` as its regression test.
- **S4: owner decision 5 (F6).** The shortcut ignores `disabled`, and desktop does not pass `disabled`. Task 7 follows F6's default:
  - `ComposerFooter.tsx` passes `disabled` to the desktop `MemoComposerDictation` and to the mobile button;
  - the reason is visible text from our composer-actions slot, inside the same `!isBtw` guard;
  - a blocked shortcut starts a dictation that fails with the reset text.
- **S5: a TCC log entry appeared. Every launch is stopped, and this is reported for a ruling.**
  - The entries are preflight checks for Input Monitoring and Screen Recording, made at start-up with no prompt, and they name the launching parent process as responsible. Any desktop launch will very likely write them, so as written the rule stops every Part A launch, not only S5's.
  - A ruling is needed on whether Part A may count only prompts and non-preflight or microphone entries.
  - That launches are charged to their parent's identity also matters for Part B's grants.
  - Until the ruling: the getUserMedia, live CSP and VAD rows are NOT RUN. There is no evidence that the CSP or a permission handler blocks Talk (the code shows neither), so Tasks 6, 8 and 9 are not stopped by a finding. The live proof of Talk's VAD moves wholly to Task 9's live check and gate P4-V5 (F4). `NSMicrophoneUsageDescription` is present, so Task 6 adds no `extendInfo`.
- **P19 passed.** Task 4's session lookup uses `session.list { withStatus: true }` per directory.
- **P20 passed.** `session.read_reply` (Task 5) goes on with `session.messages { role: 'assistant', last: true }`.
- **P21: no todo route.** The voice context says "todos unknown" (owner note). Task 4's pending-permission read is `GET /api/session/:id/permission` with `x-opencode-directory`.
- **P22 passed.** `session.stop` (Task 5) goes on with `POST /api/session/:id/interrupt` and `x-opencode-directory`. The loop matches `session.execution.interrupted` by `sessionID`, because that event has no `location`.
- **P23: the engine steers** a send to a busy session into the running execution, and `session.send` also switches the busy session's model and agent first. By F9, Task 5 never sends to a busy session. It queues through 2.1.1's server-owned queue, with `sendConfig` built from `GET /api/session/:id` (`model.providerID`, `model.id`, `model.variant`) and the latest assistant message's `agent`. The "send instead" branch is dropped, and steering is an owner decision only if the owner asks for it.
- **P24:** the 2.1.1 queue needs no field the server cannot know, so there is no owner decision. Task 8's `queue.ts` handles a `null` target and a refused add with a bar line.
- **Outbound:** S1, S2 and S6 saw no non-loopback connection and no host to record. S5's egress was not recorded.

## Owner notes

- **Dictation refusal text.** Upstream shows our text with an HTTP status in front (`429 Voice input is out of quota until Tue 27 Oct, 00:00`) and a Retry button (decision 5).
- **Read-aloud refusal text.** It reaches the UI as `Failed to generate speech: 429 …` (F34).
- **Todos.** OpenCode 2.0.22 has no todo route, so voice cannot report a session's todo list.
- **Steering.** A prompt sent to a busy session is steered into the running turn by default. Voice queues instead (F9).
- - **TCC and launches (S5).** A gate launch from the controller's tools writes TCC preflight entries naming the gate, and macOS charges them to the launching parent app. The binding rule "a TCC log entry appears: stop every launch" therefore stops Part A's desktop launches as written. A ruling is needed on which TCC entries count.
- **The microphone prompt text** is Electron's generic sentence (F5).
