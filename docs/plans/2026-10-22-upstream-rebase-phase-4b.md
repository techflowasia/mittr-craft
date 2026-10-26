# Upstream Rebase — Phase 4B: Voice on the 2.1.1 Base — Implementation Plan

> **For the executor:** implement task by task, with a review after each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A MittrCraft Dev build on upstream 2.1.1 where voice works as it did in 1.22, through the Mittr platform. Dictation and read-aloud go through Mittr speech. The Talk voice assistant drives sessions, the browser panel, the person's Chrome, the desktop and Jira/Plane cards through the 4A action registry. One spoken yes allows Chrome for the rest of a conversation, never saved. This is the last plan of phase 4.

**Architecture:**
- **Server.** Everything lives in `packages/mittr-server/src/mittr/voice/`, behind the phase 2 plugin context.
  - **Speech.** One Mittr speech client calls `/desktop/speech/*` with the active account's bearer. It is pinned to that account and re-checked after each refresh and each answer. It is served three ways:
    - a loopback OpenAI-compatible speech endpoint at `/mittr-speech/v1/audio/{transcriptions,speech}`. Upstream's own dictation and read-aloud are pointed at it, so no upstream speech file is edited (spec §5.3). It opens only with a per-run speech key;
    - Talk's own routes under `/api/mittr/voice/*`;
    - one speech quota state that the window long-polls.
  - **Voice turn.** The loop is 1.22's `runVoiceTurn`, re-ported. It calls `POST /desktop/voice/step`, runs each tool call through `registry.execute(…, { surface: 'voice' })`, and keeps every 1.22 guard. Upstream actions reach the control service through the registry. Voice never waits and never uses `returnResult`, because it has no calling session. A busy session's prompt goes to 2.1.1's server-owned message queue through the window, with the session's own model.
  - **Voice-only actions.** `session.stop`, `session.read_reply` and `chrome.allow_site` are registered on a voice-only tool, `mittrcraft_voice`. The registry refuses them on every surface but `voice`.
  - **Chrome on voice.** A voice Chrome call never raises or answers an engine card. On a site not yet allowed it answers `site_approval_required` with the host, and the loop asks by voice, as 1.22 did (R162).
- **Engine.** Task 1 proves on 2.1.1 and the bundled OpenCode 2.0.22 what the voice needs:
  - upstream's OpenAI-compatible speech paths reaching our endpoint;
  - chunked read-aloud timing;
  - the composer footer;
  - microphone, VAD and ONNX under the Electron window's CSP;
  - the engine reads behind the voice context (one global event stream, cursor paging, `x-opencode-directory`).

  Later tasks take the routes the spike proves.
- **UI.** `packages/mittr-ui/src/voice/` ports 1.22's `lib/voice-assistant/*` and the speech quota store.
  - The Talk button and the speech-quota line fill a new `composer-actions` slot.
  - The voice bar is a portal from the existing root wrapper.
  - The MittrCraft voice settings (Mittr for voice input and read-aloud, preview, the two limits) go in an existing slot (owner decision 2).
  - The Silero VAD and ONNX runtime assets are staged by our build script.
- **Upstream touch.** One counted file is expected: `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx`, for the composer-action slot and the dictation block (spec hook 11). `product-plugins.ts` is a hook file and is not counted. Named fallbacks are in "Coverage and budget".

**Tech Stack:**
- Bun workspaces: installed bun 1.3.14 (R3). Node ≥ 22 via `nvm use` (R4).
- Electron 43 and electron-builder 26; React/Vite UI.
- Tests:
  - `node:test` for `packages/mittr-*` server code and `scripts/mittr/*`;
  - `bun:test` through `scripts/run-isolated-tests.mjs` for the UI;
  - vitest for upstream web hook tests.
- OpenCode 2.0.22, bundled.
- New UI dependencies, as 1.22 shipped them: `@ricky0123/vad-web` 0.0.31 (ISC) and `onnxruntime-web` 1.30.0 (MIT). Both are in the local bun cache.
- Mittr platform routes. Main and develop are identical for all of them (`git diff origin/main origin/develop` is empty):
  - `GET /desktop/speech/readiness` answers `{ listen: { ready }, speak: { ready }, voice: { ready }, silenceMs, startWaitMs, voiceSilenceMs }`.
  - `POST /desktop/speech/transcribe` takes multipart field `audio` (WAV, 16 kHz mono PCM16, ≤ 10 MiB) and answers 201 `{ text, ms }`.
  - `POST /desktop/speech/synthesize` takes `{ text }` (1–4000 characters after trim). It answers an audio stream with the upstream content-type (Gemini: `audio/pcm;rate=24000;channels=1`) and `X-Content-Type-Options: nosniff`.
  - Speech errors are `{ code }` with `not_configured` 409, `audio_too_large` 413, `upstream_failed` 502, `upstream_timeout` 504, `empty_transcript` 422, `bad_request` 400. A quota refusal is 429 `{ code: 'llm_quota_exhausted', modelKey, kind: 'stt' | 'tts', label, labelKey?, resetsAt, message }`. No desktop subject is 403 `desktop_session_required`.
  - `POST /desktop/voice/step` (SSE) takes `{ locale: 'th'|'en', context ≤ 8000, messages 1–60 (≤ 200 000 characters counting tool-call arguments; ≤ 20 tool calls per assistant message; every tool message after its call), tools 1–4 }`.
    - A tool's `name` is one of `mittrcraft`, `mittrcraft_web`, `mittrcraft_voice`, `mittrcraft_end`, unique. Its description is ≤ 4000 characters and its parameters ≤ 30 000 serialized.
    - Events are `text-delta`, `tool-call { id, name, arguments }`, `done`, `error { code: not_configured | upstream_failed | upstream_timeout | bad_request }` and the quota frame `error { code: 'llm_quota_exhausted', resetsAt, model }`.
    - A bad body is an SSE `error bad_request` after 200.
  - `voice.end` decision (`desktop-voice-end.ts`): on a turn's first step, when `mittrcraft_end` is offered, the platform adds or drops a `mittrcraft_end` call.

**Spec:** `docs/specs/2026-10-16-upstream-rebase-design.md` (§5.3 speech, §5.4 voice routes and Talk, §5.6 hook 11, §6 "Dictation, read aloud" and "Voice assistant / Talk mode", §9 gate 4, §12 risk 4). Also:
- `docs/plans/2026-10-17-feature-inventory.md` §4 (P4-V1 to P4-V9) and the voice parts of §5 (A-02 "voice", A-15 `510964a11`, A-31), §7 (C-01, C-02, C-11, C-18);
- the 1.22 wire contract, `git -C ~/Documents/mittr-craft show origin/develop:docs/specs/2026-09-29-mittr-voice-wire.md`;
- the 4A plan's "Interfaces 4B will consume", `docs/plans/2026-10-21-phase-4a-gate.md`, both engine proofs, and the 4A ledger rulings R141–R163.

## Global Constraints

**Where the work happens**
- Branch `rebase/upstream-2.1.1` in `~/Documents/mittr-craft/.worktrees/rebase-2x`, starting at `f01be5ae3` (4A built, Part B pending). Upstream base `e302062e3` (`brand/UPSTREAM`).
- Never touch the main checkout, other worktrees, `develop`, `main` or any remote. **No push.** I3 and I5 stay open and are not part of this phase.
- 1.22 sources are read only, with `git -C ~/Documents/mittr-craft show origin/develop:<path>`. Never check anything out there.
- The local bun cache (`~/.bun/install/cache`) is read only. Task 6's `bun install` takes the two new packages from it. If anything must come from the network, stop and report (owner decision 7).
- Run every node or bun command after `source ~/.nvm/nvm.sh && nvm use` in the worktree (R4). Use the installed bun 1.3.14 and install no other (R3). If `bun install` rewrites the `bun.lock` format, stop and report.
- Run `check-upstream-touch.mjs` only with `--no-write`. Upstream locale files are never edited.
- **The 4A Part B build is kept.** Before the first 4B build (Task 1 S5), check whether 4A Part B has run.
  - If it has not run, move `packages/electron/dist/mac-arm64/MittrCraft Dev.app` (the 4A gate build) into the 4A evidence folder outside the repository, and record its sha256 and the HEAD it was built at.
  - Never rebuild over it in place.

**Code and copy**
- Write no new code comments or docstrings. Code, tests, fixtures, docs and commit messages are in English.
- **Thai text this phase adds is only the assistant's own spoken lines.** They also appear in the voice bar's transcript as the assistant's words, and are never labels or settings copy. They are copied verbatim from 1.22:
  - `loop.js` `CLOSING.th`: `หยุดไว้ก่อนหลังทำไป ${steps} ขั้น ขั้นล่าสุดคือ ${label} ถ้าจะให้ทำต่อ บอกได้เลย`;
  - `loop.js` `GOODBYE.th`: `แล้วคุยกันใหม่นะครับ`;
  - the eight `narration.ts` `SPOKEN.th` lines.

  The language follows the person's last utterance: Thai script gives `th`, anything else `en`.
- Descriptions the platform's model reads are copied from 1.22 and named for 2.1.1:
  - the voice tool, end tool and action descriptions (`voice-assistant/tools.js`, `mittrcraft-control/actions.js`);
  - the control, web, Chrome and computer tool descriptions and parameter schemas 1.22 voice used (`agent-tool/runtime.js` at `origin/develop`), less `wait` and `timeout`.
- User-facing strings:
  - Mittr-only UI strings live in `packages/mittr-ui/src/strings/mittr.en.ts` as `mittr.voice.*` and `mittr.speech.*`, read through `mittrT` / `useMittrT`, English in every locale (C-02);
  - the 1.22 English values of `voice.i18n.ts` and the `quota.stt.*` / `quota.tts.*` keys carry over unchanged;
  - upstream `t()` is never called with a Mittr key.
- Everything visible must work (owner rule, 15 Oct):
  - Talk is not shown where it cannot run: hosted web, a tunnel or remote client, no microphone support, or the platform's voice not ready. At most one plain line says why;
  - a blocked microphone shows its reason, never a dead control with a promise.
- Files we own: `packages/mittr-*/**`, `brand/**`, `scripts/mittr/**`, `patches/**`, `docs/**`. Everything else is upstream.

**Commits**
- Only the existing style: `feat(mittr-server|mittr-ui|mittr): …`, `fix(…): …`, `hook(<name>): …` with a one-paragraph why for any upstream file, `docs(…): …` for notes.
- The working-notes folder that holds the ledger, reports and gate evidence is git-ignored and never named in tracked files.

**Upstream touch**
- The cap is 40 (R35/R36). It is **35 counted today**.
- This phase adds **1** counted file as planned (`ComposerFooter.tsx`, Task 7). Up to 4 more are named fallbacks, each behind a spike result or an owner decision (table under "Coverage and budget").
- Each hook is generic: it names no Mittr concept, keeps upstream behaviour when unused, and has one call site per surface it serves.
- Run `node scripts/mittr/check-upstream-touch.mjs --no-write` after any hook: nothing unlisted, nothing stale, and the count each task states.
- Every task that adds a hook has the step "append `{hook, why}` to `brand/upstream-hooks.json` for every upstream file this hook touches" (R48).
- Every new upstream module, symbol, setting key, store field, event shape or route mittr-server or mittr-ui relies on gets an entry in `packages/mittr-server/src/upstream-contract.js` and its check in `upstream-contract.test.js`, in the task that starts relying on it.
- Hook tests in upstream files use neutral fixtures (`acme`, `acme_action`, `api.example.test`). `node scripts/mittr/neutral-hook-tests.mjs` reports 0 findings after every hook task.

**Dependencies and imports**
- mittr-server imports nothing from `@openchamber/web`. Upstream reaches it through the plugin context, and `express` is `context.express`. The probe scripts in `scripts/mittr/` and the contract tests may import upstream modules, as 4A's did.
- The only new npm dependencies are the two in the Tech Stack, exact versions, in `packages/mittr-ui/package.json`. `bun.lock` is already counted.
- mittr-ui imports upstream UI modules through `@/…`, as it does today. Each new one is a contract item.

**Tests**
- UI behaviour is tested as a pure controller plus static markup (`renderToStaticMarkup`), or with upstream's hand-rolled hook harness. There is no DOM library (R11).
- Every test, runner and probe runs isolated (F9). Every test command below is written `iso <command>`, where `iso` is this shell function, defined once per shell:

  ```bash
  iso() {
    local t; t=$(mktemp -d "$TMPDIR/p4.XXXX")
    env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_DIR -u OPENCODE_CONFIG_CONTENT -u OPENCHAMBER_DATA_DIR \
      -u MITTRCRAFT_BROKER_URL -u MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR -u MITTRCRAFT_BUNDLED_CUA_DRIVER_DIR \
      HOME="$t" XDG_CONFIG_HOME="$t/.config" XDG_DATA_HOME="$t/.local/share" \
      XDG_STATE_HOME="$t/.local/state" XDG_CACHE_HOME="$t/.cache" "$@"
  }
  ```
- The isolated baseline is `node scripts/mittr/test-baseline.mjs`; its guard refuses the real HOME (R102/R103). Add no failure outside `brand/test-baseline.json`.
- Unit tests never touch a microphone, a speaker, Chrome or the platform. `getUserMedia`, `MicVAD`, `AudioContext`, the driver and `fetch` are injected fakes.

**Secrets**
- No Mittr access or refresh token, shim key, speech key, Jira or Plane credential reaches a log line, a reply, a tool result, the engine environment, or a file outside the sealed store (R55, R57, R107/R108). The one exception is the speech key in `voice-keys.json` (owner decision 4).
- **The speech key** (`mc_speech_` + 64 hex):
  - it is minted fresh on every server start and held in memory;
  - it is written only into `<dataDir>/voice-keys.json` (mode 600, temp file and rename), as the `stt` and `openaiCompatible` kinds, and only while the person has chosen Mittr for that kind;
  - it opens only `/mittr-speech/v1/*`, only from loopback with no relay header;
  - it is never logged, never in a route answer, and never in the engine env.
- **Never logged:** what was said, a transcript, audio, a spoken reply, tool arguments or tool results. A log line names the route or action, the HTTP status and an error name only (1.22 invariant).

**Safety, every runtime check**
- All 4A runtime safety rules bind unchanged:
  - never contact, signal or replace the owner's running apps or port 57133;
  - never write the listed real dirs;
  - the owner's Chrome and desktop are off limits outside Part B;
  - isolated launches with temp HOMEs under `/tmp/p4.XXXX` (agent-browser's 103-byte socket limit, gate note Method);
  - `CFFIXED_USER_HOME`, the R145 refusing proxy for every agent Chrome, and the R46 per-call port guard;
  - R9 recorded; the owner types every credential and answers every OS dialog (R10).
- **Microphone and speakers:**
  - never open the real microphone outside Part B. Every launch before Part B passes Chromium's `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<fixture.wav>` and `--mute-audio`;
  - never raise a macOS microphone (TCC) prompt outside Part B. Record the TCC log for the app before and after each launch, with `log show --last <n>m --predicate 'subsystem == "com.apple.TCC"'`, filtered to the app's bundle id;
  - never play audio aloud outside Part B.
- **Fixture audio** is made locally. Speech comes from `say -v <voice> -o <temp>.aiff` converted to 16 kHz mono WAV with `afconvert`; tones and silence come from code. Nothing is recorded, played or uploaded. Fixture files live in the temp HOME and are never committed. Their sha256 values are what the stub maps to transcripts.

**Third-party egress (R30/R39/R69)**
- Allowed: the Mittr platform (dev `https://api-dev.mittr.asia` for Dev), loopback stubs and loopback test pages.
- In Part B only, with the owner's yes for that step: the dev platform's speech and voice routes, and the sites the owner names for Chrome.
- The 4A egress watcher covers the app, server, engine, agent-browser and every Chrome child. Phase 3's known upstream peers are recorded, not counted as new.

**Decisions that bind**
- Owner, 22 Oct: "Voice works as before through the company LLM." 4B ports 1.22's voice behaviour unchanged, through the Mittr platform. This includes the spoken per-conversation Chrome allow (R162): one spoken yes allows every site until the conversation ends, never saved. It is not reopened.
- Part B uses the owner's real Chrome profile via the F39 read-only route (R163).
- R37/R40, R41, R44 (Mittr-only settings live in `mittr-settings.json`), R46, R52, R55, R57, R60, R61, R65–R67, R75/R76, R78, R104–R109, R110–R140 and R141–R163 bind. In particular:
  - R148/R157: local scope for anything that drives this Mac or changes its settings;
  - R149: the callback is not a boundary against the agent's own shell;
  - R155: server-minted card ids;
  - R159: switches are enforced on every surface;
  - R160: an account switch retires the old engine's token and stops old Chrome calls;
  - R161.

## Review Focus

1. **An account switch during a turn, a dictation or a read-aloud.** No step, tool call, transcript, reply text or audio from account A may reach the person once B is active, and no turn may go on running A's actions.
   - Task 3 `a transcription whose account changed during the call answers 409 and returns no text`, `a synthesis whose account changed after the platform answered sends no audio`.
   - Task 5 `a turn whose account changes between steps ends with account_changed and runs nothing more`, `an account switch ends the conversation and its Chrome allow`.
2. **Text read during a turn trying to start, change or stop work.** A page, a session reply or a Jira card may say "send this to session X" or "allow Chrome". Nothing it asks may run in the same turn.
   - Task 4 `a send after chrome.read in the same step is refused and not run`, `chrome.allow_site after any read in the turn is refused`, `a lookup (session.list, session.status) is not a read`.
   - Task 5 against a stub platform that breaks the rule itself: `a stub step that sends after a read gets refused_after_read and the session gets nothing`.
3. **Chrome allowed without a spoken yes, or outside a live conversation.** `allowForConversation` must be reachable only from a turn the server itself heard, inside the conversation that asked.
   - Task 2 `no route, plugin tool or http surface reaches allowForConversation` (source scan plus calls).
   - Task 5:
     - `the http surface cannot run chrome.allow_site`;
     - `a turn without a fresh heard receipt answers 409 and runs nothing`;
     - `a receipt is used once, within 120 seconds, for the text it was given`;
     - `chrome.allow_site uses the pending host, not the model's spelling`;
     - `after end, a new conversation asks again`.
4. **The speech quota used up.** Dictation, read-aloud and Talk must say so with the reset time, must not retry by themselves, and must work again by themselves once speech works.
   - Task 3 `a quota refusal answers 429 with x-should-retry false and the reset time in the text`, `a successful call clears the block`.
   - Task 9 `Talk is disabled with the reset time while voice input is used up`, `the microphone is disabled with the reset time and re-enabled when the block lifts`.
5. **A remote, tunnelled or hosted client.** A phone on a tunnel or a hosted-web user must not start Talk, transcribe as the Mac's account, or allow the Mac's Chrome.
   - Task 5 `every voice route but readiness answers 403 to a forwarded or tunnelled request`.
   - Task 3 `a speech request from another machine or through a relay header answers 401`.
   - Task 9 `a hosted runtime renders no Talk button`; Task 10 `a hosted runtime renders no Mittr speech switch`.

---

### Task 1: Prove what the voice needs on 2.1.1 and the bundled engine (spike)

**Files:**
- Create:
  - `scripts/mittr/probe-voice.mjs` with `probe-voice.test.mjs`: scenarios S1–S2 (server, node, upstream modules imported);
  - `scripts/mittr/probe-voice-window.mjs` with `probe-voice-window.test.mjs`: scenario S5 (an isolated Dev launch);
  - `packages/mittr-ui/src/voice/readAloudTiming.test.ts`: scenario S3, kept as Task 10's regression test;
  - `docs/plans/2026-10-22-phase-4b-voice-proof.md`.
- Modify `scripts/mittr/probe-engine-v2.mjs` and its test: `--only voice`, scenarios P19–P24 (S6).

**Interfaces:**
- `node scripts/mittr/probe-voice.mjs --json <out>` builds a loopback express app with:
  - upstream's `registerTtsRoutes` and the dictation runtime's stream manager, with upstream's `openai-compatible` STT session;
  - `OPENCHAMBER_DATA_DIR` in the temp HOME, holding a `voice-keys.json` with marker keys for `stt` and `openaiCompatible`;
  - a recording stub of `/mittr-speech/v1/audio/{transcriptions,speech}`. It records the path, method, headers by name, the sha256 of the bearer, multipart field names, the file's mime, name and WAV header, and the JSON body keys. Values are not recorded except `model`, `voice` and `response_format`.
- Pure helpers, tested:
  - `wavHeaderOf(buffer) -> { rate, channels, bits } | null`;
  - `multipartFieldsOf(body, contentType) -> Array<{ name, filename?, type? }>`;
  - `maxGapOf(schedule: Array<{ startsAt, endsAt }>) -> number`.
- `node scripts/mittr/probe-voice-window.mjs --json <out> --app <MittrCraft Dev.app> --fixture <speech.wav>` follows the Global Constraints launch rules, fake media and `--mute-audio` included. It drives the window through its DevTools port only.
- `MARKER_TRANSCRIPT = 'probe heard you'`.

- [ ] **Step 1:** Write the failing helper tests:
  - `a 16 kHz mono PCM16 WAV header is read`;
  - `multipart field names come out in order`;
  - `the largest gap between scheduled chunks is found`.
- [ ] **Step 2:** `iso node --test scripts/mittr/probe-voice.test.mjs scripts/mittr/probe-voice-window.test.mjs`. Expected: FAIL (helpers missing).
- [ ] **Step 3:** Implement the scenarios. Record each with PASS or FAIL and the raw evidence in the JSON:
  - **S1 dictation through upstream's OpenAI-compatible STT.** Start a stream with options `{ provider: 'openai-compatible', openaiCompatible: { baseUrl: <stub>/mittr-speech/v1, model: 'mittr' } }` and no key in the options, which is what 2.1.1's `useDictation` sends. Feed 3 s of 16 kHz PCM16 in 1 s chunks, then `finish`.
    - Record the stub request: path, `authorization` sha equal to the `stt` marker, the field names, `model`, `response_format`, a file part `audio/wav` at 16 kHz mono 16-bit, and whether `language` is sent.
    - Record the WS events the client gets (`ready`, `ack`, `final { text }` = `MARKER_TRANSCRIPT`).
    - Then make the stub answer 429 with `{ error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', message: 'Voice input is out of quota until Tue 27 Oct, 00:00', resets_at: '2026-10-26T17:00:00Z' } }` and `x-should-retry: false`. Record the client's `error` payload (`error`, `retryable`, `reasonCode`) and how many HTTP attempts the stub saw.
    - Repeat with 503 `{ error: { code: 'not_configured', message: 'Your Mittr admin has not set up speech models yet' } }`.
  - **S2 read-aloud through upstream's `/api/tts/speak`.** POST `{ text: 'สวัสดี hello', baseURL: <stub>/mittr-speech/v1, model: 'mittr', voice: 'mittr' }`, which is what 2.1.1's `useServerTTS` sends.
    - Record the stub request: path `/mittr-speech/v1/audio/speech`, bearer sha equal to the `openaiCompatible` marker, and the body keys and values (`model`, `voice`, `input`, `response_format`, `speed`).
    - The stub answers `audio/wav` (a 24 kHz mono WAV of 0.5 s). Record the route's status, its `content-type`, and whether the bytes equal the stub's.
    - Then a 429 quota body and a 503. Record the route's status, its JSON, and the stub's attempt count.
  - **S3 chunked read-aloud timing (bun test).** Build a 6000-character answer of Thai and English sentences, including one Thai sentence of 4200 characters with no full stop. Run upstream's `splitSentencesForTTS` and `runChunkedTTSPlayback` (`packages/ui/src/hooks/useServerTTS.ts`) with fake timers, under two conditions:
    - a `fetchChunk` that resolves after 2.0 s per chunk;
    - an audio duration of `characters / 14` seconds.

    Record:
    - the chunk count;
    - the longest chunk in characters (> 4000 means our endpoint must split one request);
    - time to first audio;
    - the largest gap between the end of one chunk and the start of the next (`maxGapOf`);
    - whether chunk N+1 is fetched while N plays.
  - **S4 the composer footer (read and record).** In `ComposerFooter.tsx`, record:
    - the desktop and mobile call sites of the dictation button;
    - which `disabled` each passes;
    - where a slot call fits beside each.

    In `ComposerDictation.tsx` and the shortcut dispatcher (`useKeyboardShortcuts`, action `toggle_dictation`), record whether the shortcut starts a dictation when the button's `disabled` is true. Record that no existing product slot renders inside the composer.
  - **S5 microphone, VAD and ONNX in the 2.1.1 window.**
    - **Build.** Make a throwaway Dev build at HEAD. Before it, copy the four VAD runtime files and vad-web's `dist/bundle.min.js` from the bun cache (`@ricky0123/vad-web@0.0.31`, `onnxruntime-web@1.30.0`) into `packages/web/public/vad/`, read only. Remove that folder after the build and check that `git status --short` is unchanged.
    - **Launch.** Launch with the fake media flags and a `say`-made fixture: 2 s of an English sentence, then 20 s of silence.
    - **Record through DevTools:**
      - the main document's CSP, from response headers and any meta tag;
      - whether `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } })` resolves, with the track's label, and whether any permission prompt or Electron permission-handler call appears for the main window;
      - whether `import('/vad/bundle.min.js')`, then `vad.MicVAD.new({ model: 'v5', baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/', … })`, loads with no CSP violation (console);
      - whether `onSpeechEnd` fires within 10 s, and its sample count;
      - after `destroy()` and stopping the track, every track's `readyState`;
      - the TCC log before and after;
      - the packed `Info.plist` `NSMicrophoneUsageDescription`.
  - **S6 engine reads (`probe-engine-v2.mjs --only voice`).** Phase 3's set-up and upstream's control service, as 4A's probe built it:
    - **P19:** `control.execute('session.list', { withStatus: true }, dir)` for two project directories: each session's id, title and status type.
    - **P20:** a session with 60 messages. `session.messages { sessionId, directory, role: 'assistant', last: true }` returns the latest assistant text, read past the first page (record the paging calls made).
    - **P21:** the routes, with `x-opencode-directory`, that give a session's todo list and its pending permission requests. Record the exact paths and fields.
    - **P22:** while a stub turn hangs, `POST /api/session/:id/interrupt` with `x-opencode-directory`. Record the answer, and the `session.idle` / status events on the one global event stream for both directories.
    - **P23:** `control.execute('session.send')` to a busy session. Record what upstream does (sent, refused, queued). Record where a 2.0.22 session holds its provider, model and agent (`GET /api/session/:id` fields), for a queued prompt's `sendConfig`.
    - **P24:** 2.1.1's `messageQueueStore.addToQueue(target, message)` input. Record whether `sendConfig` is required, and the server route it calls (read the source, and run the store against a recording fetch).
- [ ] **Step 4:** Run the probes and write the proof note: results, raw shapes, timings, every outbound connection seen. **Stop conditions, binding on later tasks:**
  - **S1 fails** (the request never reaches our endpoint, or the `stt` key is not sent):
    - **stop Task 3's dictation half** and report;
    - the fallback is a Mittr provider in `packages/web/server/lib/dictation/service.js` (+1, owner decision 1).
  - **S1: the client's quota error loses our text, or shows a Retry:** owner decision 5 (accept the Retry, or +2 for `ComposerDictation.tsx` and `stream-manager.js`). More than one HTTP attempt despite `x-should-retry: false` is an owner note.
  - **S2 fails** (no request, the key is not sent, or the WAV is not passed through):
    - **stop Task 3's read-aloud half** and report;
    - the fallback is a Mittr branch in `packages/web/server/lib/tts/routes.js` (+1).
  - **S3: the largest gap exceeds 2 s with 2 s synthesis:** owner note. Read-aloud then keeps upstream's player as is, and Talk keeps its own streaming player.
  - **S3: a chunk over 4000 characters:** Task 3's speech endpoint splits it, as specified there.
  - **S4: the shortcut ignores `disabled`:** owner decision 5. Either accept (a blocked shortcut starts a dictation that fails with the reset text), or +1 `ComposerDictation.tsx`.
  - **S5: the CSP blocks the ONNX wasm or the VAD worklet:**
    - **stop Tasks 6, 8 and 9's Talk half** and report. Dictation and read-aloud go on;
    - the fix belongs where the CSP is set. `packages/electron/main.mjs` is already counted (0); a server header is +1.
  - **S5: `getUserMedia` is refused by a main-window permission handler:** the same rule. `main.mjs` costs 0.
  - **S5: the fake-media flags do not take:** the gate's Part A VAD rows are NOT RUN. Unit tests and Part B cover them.
  - **S5: a TCC log entry or prompt appears:** **stop every launch** and report.
  - **S5: no `NSMicrophoneUsageDescription`:** Task 6 adds it through `brand/electron-builder.*.json` `mac.extendInfo` (owned).
  - **P20 cannot read the latest assistant text:** **stop `session.read_reply`** and report.
  - **P21 has no todo route:** the voice context says "todos unknown" (owner note).
  - **P22: the interrupt fails:** **stop `session.stop`** and report.
  - **P23: the engine accepts a send to a busy session and runs it later:**
    - Task 5 sends instead of queueing, and records the ruling;
    - otherwise Task 5 queues through the window with the session's own `sendConfig` from P23.
  - **P24: the 2.1.1 queue needs a field the server cannot know:** owner decision.
  - **Any non-loopback connection:** record the host for the owner.
- [ ] **Step 5:** Commit `docs(mittr): record how 2.1.1 carries Mittr speech, the voice reads and the microphone`, with the scripts, the S3 test and the proof note.

Upstream files added: 0. Running total: 35.

### Task 2: The 4A seams the voice relies on (carries from R141–R163)

**Files:**
- Modify in `packages/mittr-server/src/mittr/tools/`, each with its test:
  - `registry.js`;
  - `chrome-service.js`;
  - `plugin-source.js`;
  - `account-guard.js`.

**Interfaces:**
- **Registry local gate (carry: the voice surface has no local gate).** In `execute`, a Computer or Chrome action on surface `voice` without `ctx.scope?.local === true` is refused with the same 403 as `http`. Task 5 passes the turn request's R148 scope.
- **Ask by voice, never a card (carry: ask-or-refuse, R162).** In `chrome-service.js` `ensureApproved`, on surface `voice`:
  - a host that `isHostAllowed` passes;
  - otherwise it throws `notYetAllowed(host)` (403, `{ code: 'site_approval_required', host }`) without calling `approvals.ask`;
  - no engine card is raised, read or answered from the voice surface.
- **`removeHost` clears conversation grants (carry).** `removeHost(host)` also empties `conversationGrants`, so a voice conversation asks again after any site is removed in Settings.
- **The closeAll window (carry).** `closeAll` stores its running promise. `perform` awaits it before it reads the generation, so a call begun during the close starts in the new generation, after `close --all` has finished.
- **The conversation grant is voice-only (carry).** `allowForConversation(sessionId)` stays the only writer of `conversationGrants`. A source-scan test pins its callers to `tools/chrome-service.js` and `voice/actions.js` (Task 5).
- **The voice page, read without launching.** `pageOf(sessionId) -> Promise<{ url, title } | null>` reads `get url` and `get title` only for a session in `modes` (one this server opened). Otherwise it answers null and runs no command. The voice context uses it.
- **Account pin for speech.** `pinAccount({ activeAccountKey, engineOnActiveHome = () => true })`: the engine check becomes optional, and 4A callers pass it as today.
- **Plugin progress (carry: Task 4 #7, `context.progress`).**
  - The generated plugin calls `context.progress({ mittrcraft: { schemaVersion: 1, action, description: title } })` before its callback, and again with `ok` after, as upstream's template does.
  - **Ruling:** the voice bar's running line comes from the turn stream's `action` event, not from `context.progress`.

- [ ] **Step 1:** Write the failing tests:
  - `a voice chrome call without local scope answers 403 and runs nothing`;
  - `a voice chrome call on a new site answers site_approval_required with the host and raises no card` (fake approvals records 0 `ask`);
  - `an always-allowed site opens from voice with no question`;
  - `removing a site in Settings ends the voice conversation's Chrome allow`;
  - `a call begun while closeAll runs waits and starts in the new generation`;
  - `no route, plugin tool or http surface reaches allowForConversation` (source scan of `packages/mittr-server/src`, plus `POST /api/mittr/control` with a made-up allow action answering 400);
  - `pageOf answers null for a session this server never opened and runs no command`;
  - `the plugin reports progress before and after the call`;
  - `a speech pin ignores the engine when asked to`.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS. Touch check: 35 of 40.
- [ ] **Step 5:** Commit `fix(mittr-server): the seams voice relies on: local scope, ask by voice, removal ends the conversation allow, no relaunch inside a close`.

Upstream files added: 0. Running total: 35.

### Task 3: Mittr speech on the server (P4-V1, P4-V2, P4-V3 server half, P4-V9)

Take the route Task 1 chose: through upstream's OpenAI-compatible paths (S1 and S2 pass), or each failed half's named fallback after owner decision 1.

**Files:**
- Create in `packages/mittr-server/src/mittr/voice/`, each with a `*.test.js`:
  - `audio.js`;
  - `speech-client.js`;
  - `speech-key.js`;
  - `speech-state.js`;
  - `speech-routes.js`.
- Modify:
  - `packages/mittr-server/src/mittr/index.js` and its test;
  - `packages/mittr-server/src/settings.js` and its test (the 1.22 `sttProvider: 'mittr'` carry);
  - `packages/mittr-server/src/mittr/platform.test.js` (`PLATFORM_CALLERS` gains the speech client);
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- `audio.js`, a port of 1.22 `dictation/audio.js` and `tts/routes.js`:
  - `pcm16ToWav(pcm: Buffer, rate: number) -> Buffer` (mono);
  - `pcmFormatOf(contentType) -> { rate, channels, swap } | null` for `audio/pcm` and `audio/l16`, default rate 24000;
  - `splitSpeechText(text, max = 4000) -> string[]`. It cuts at the last sentence end (`. ! ? … 。` or a newline) before `max`, else the last whitespace, else at `max`, and never splits a surrogate pair. It replaces 1.22's `fitMittrText`, which dropped the rest.
- `class SpeechError extends Error { constructor(reasonCode, statusCode, extra = {}) }`, with `reasonCode` and `statusCode`, and `resetsAt` and `kind` for quota.
- `createMittrSpeechClient({ broker, ensureFreshSession, fetchImpl, activeAccountKey, now = Date.now }) -> { readiness(), transcribe(wav, signal), synthesize(text, signal) } | null`. It is a port of 1.22 `mittr-speech/client.js`:
  - readiness is cached 30 s per access token; the readiness timeout is 10 s and speech calls 60 s;
  - the 1.22 reason map applies: `not_signed_in` 401, `not_configured` 503, `unreachable` 502, `upstream_timeout` 504, `upstream_failed` 502, `audio_too_large` 413, `bad_request` 400. A 401/403 is `not_signed_in`; a 404, or a 503 with no code, is `not_configured`. `empty_transcript` gives `''`;
  - a quota body (`readQuotaExhausted` from `../exhausted.js`) throws `SpeechError('llm_quota_exhausted', <platform status>, { kind, resetsAt })`;
  - **account pin:** `pinAccount({ activeAccountKey })` at call start, checked after `ensureFreshSession` against that session's key and again after the platform answers. A change throws `SpeechError('account_changed', 409)` and drops the answer.
- `createSpeechState({ now = Date.now }) -> { block(kind, resetsAt), clear(kind), clearAll(), view() -> { revision, stt: { blockedUntil }, tts: { blockedUntil } }, waitForChange(since, ms, signal) -> Promise<view> }`:
  - `block` with a null `resetsAt` uses 1.22's `nextWeeklyReset(now)` (`lib/mittr-quota/week.ts`, ported: next Monday 00:00 Asia/Bangkok);
  - a successful call of a kind clears it, and an account switch clears both;
  - `blockedUntil` reads null once it is in the past.
- `createSpeechKeys({ dataDir, mint }) -> { current(), matches(bearer) -> boolean, install(kinds), remove(kind), refreshInstalled() }`:
  - `SPEECH_KEY_PREFIX = 'mc_speech_'`;
  - `install(['stt' | 'openaiCompatible'])` writes the current key for those kinds and keeps every other kind;
  - `remove(kind)` deletes a kind only when it holds a `mc_speech_` value;
  - `refreshInstalled()` (called at setup) replaces every `mc_speech_` value with this run's key;
  - `matches` is a timing-safe compare of sha256 digests;
  - the file is `<dataDir>/voice-keys.json`, JSON, mode 600, temp file and rename.
- `registerSpeechRoutes(app, { express, client, keys, state, offered, requestScope, host, logger })`, with `SPEECH_PREFIX = '/mittr-speech/v1'`:
  - **Guard** for everything under the prefix: a non-loopback peer, any relay header (`cameThroughProxy`) or a bearer that does not `match` answers 401 `{ error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Not a MittrCraft speech key' } }`.
  - `POST /mittr-speech/v1/audio/transcriptions` takes `express.raw` multipart up to 25 MB and the `file` part, and answers `{ text }`.
  - `POST /mittr-speech/v1/audio/speech` takes JSON `{ input, model, voice, response_format?, speed? }` (64 kB). It splits with `splitSpeechText` and synthesizes the parts in order:
    - PCM parts are joined into one `audio/wav`;
    - a single non-PCM audio part passes through with its type;
    - several non-PCM parts answer 502 `The Mittr platform returned audio this app cannot join`;
    - multi-channel PCM answers 502 `The Mittr platform returned audio this app cannot play` (1.22's text).
  - **Refusals** under the prefix are `{ error: { type, code, message, resets_at? } }` with the error's status and `x-should-retry: false`. Messages:
    - STT quota: `Voice input is out of quota until <when>`;
    - TTS quota: `Spoken replies are out of quota this week — answering in text` (1.22 `quota.stt.exhausted` / `quota.tts.exhausted`);
    - `<when>` is `formatResetTime(resetsAt, 'en-GB', 'Asia/Bangkok')`: for `2026-10-26T17:00:00Z` it is `Tue 27 Oct, 00:00`;
    - the rest are 1.22 `MITTR_LISTEN_ERRORS`: `Sign in to Mittr to use dictation`, `Your Mittr admin has not set up speech models yet`, `The Mittr platform cannot be reached right now`; and `The Mittr account changed` for `account_changed`.
    - Each refusal or success updates `state`.
  - `GET /api/mittr/voice/readiness` answers `{ listen, speak, voice, signedIn, voiceSilenceMs, reason, here }`:
    - `reason` is `'not_signed_in' | 'not_configured' | 'unreachable' | null`, the 1.22 wire;
    - `here` is the R148 local scope of the request.
  - `GET /api/mittr/speech/state?since=<revision>` long-polls up to 25 s and answers `view()`.
  - `GET /api/mittr/speech` answers `{ offered, baseUrl, model: 'mittr', voice: 'mittr', installed: { stt, openaiCompatible }, carryDictation }`. `baseUrl` is `http://127.0.0.1:<context.server.port()>/mittr-speech/v1`. `offered` is false on a hosted runtime (owner decision 6).
  - `PUT /api/mittr/speech/key` takes `{ stt?: boolean, openaiCompatible?: boolean }` and installs or removes per kind. `POST /api/mittr/speech/carried` clears `carryDictation`. Both need the R157 local scope (403 `These settings can be changed only on this Mac`).
- **Carry:** `settings.js` parks a 1.22 `sttProvider: 'mittr'` as `mittr.sttProvider` (upstream would read `'mittr'` as its default), and `carryDictation` reads it.
- **Wiring:** `setupMittr` creates the client, keys, state and routes. On account change it clears `state`. On `dispose` it stops waiting long-polls.
- **Contract items:**
  - `dictation-openai-compatible`: `dictation/service.js` reads `options.openaiCompatible.{baseUrl,model}` and `readVoiceKey('stt')`, and the session posts a 16 kHz WAV through `tts/stt.js`;
  - `tts-openai-compatible`: `/api/tts/speak` takes `baseURL`, fills its key from `readVoiceKey('openaiCompatible')` and passes the upstream content type;
  - `voice-keys-file`: `<dataDir>/voice-keys.json`, kinds `openai`, `openaiCompatible`, `stt`, each a string of 1–1024 characters;
  - `loopback-speech-urls`: `normalizeCustomOpenAIBaseURL` accepts `127.0.0.1` on every runtime.

- [ ] **Step 1:** Write the failing tests (fake fetch, temp data dir):
  - `a WAV is transcribed through the platform with the active account's bearer`;
  - `empty_transcript gives an empty text`;
  - `a 404 or a bare 503 reads as not configured`;
  - `a quota refusal answers 429 with x-should-retry false and the reset time in the text` (exact `Voice input is out of quota until Tue 27 Oct, 00:00`), and `blocks stt in the state`;
  - `a successful call clears the block`;
  - `a transcription whose account changed during the call answers 409 and returns no text`;
  - `a synthesis whose account changed after the platform answered sends no audio`;
  - `6000 characters are synthesized in two calls and played as one WAV`;
  - `a 4200-character sentence is split at whitespace and nothing is dropped`;
  - `24 kHz PCM is wrapped as WAV and L16 is byte-swapped first`;
  - `a speech request from another machine or through a relay header answers 401`;
  - `a request with the engine's shim key answers 401`;
  - `the speech key is written only for the kinds asked, mode 600, and another kind's key is kept`;
  - `a restart replaces our key and leaves the person's own`;
  - `removing a kind that holds the person's own key changes nothing`;
  - `the speech key, the access token and the audio never reach a log line or a reply`;
  - `readiness says here false for a forwarded request`;
  - `the state long-poll answers when a block is added and when it lifts`;
  - `a hosted runtime offers no Mittr speech`;
  - `a 1.22 sttProvider mittr is carried once`;
  - the four contract items.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement, porting 1.22 `mittr-speech/client.js`, `voice-speech/routes.js`, `tts/routes.js` `speakWithMittr` and `dictation/mittr-session.js` errors.
- [ ] **Step 4:** Re-run. Then one live check under `iso`: upstream's dictation stream manager and `/api/tts/speak`, as in Task 1 S1/S2, against our real routes and a stub platform. Expected: text and WAV arrive; 0 non-loopback peers. Touch check: 35 of 40.
- [ ] **Step 5:** Commit `feat(mittr-server): dictation and read-aloud through Mittr speech, with its quota and the account pinned`.

Upstream files added: 0, or 1 per failed S1/S2 half on its fallback. Running total: 35 + T3, where T3 is 0 to 2.

### Task 4: Voice tools, guards and context (P4-V6, P4-V7, P4-V8 schema half)

**Files:**
- Create in `packages/mittr-server/src/mittr/voice/`, each with a `*.test.js`:
  - `descriptions.js`: the vendored 1.22 texts;
  - `parameters.js`: the vendored 1.22 parameter properties;
  - `tools.js`;
  - `context.js`.
- Modify `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- **Constants, exact from 1.22 `loop.js` and the wire spec:**
  - `READ_ACTIONS`: `session.read_reply`, `session.messages`, `chrome.read`, `chrome.snapshot`, `chrome.screenshot`, `chrome.do`, `browser.snapshot`, `browser.inspect`, `browser.capture`, `computer.screenshot`, `jira.get_issue`, `plane.get_issue`;
  - `REFUSED_AFTER_READ`: `session.stop`, `session.send`, `session.create`, `session.fork`, `schedule.create`, `schedule.run`, `schedule.delete`, `schedule.toggle`, `chrome.allow_site`;
  - `STEP_CALLS_MAX = 20`;
  - `VOICE_TOOL_RESULT_MAX_CHARS = 20_000`;
  - `MESSAGES_MAX_COUNT = 60`;
  - `MESSAGES_MAX_CHARS = 200_000`;
  - `STEP_TIMEOUT_MS = 120_000`;
  - `VOICE_STEP_CAP = { fallback: 8, min: 1, max: 20 }`;
  - `VOICE_REPLY_MAX_CHARS = { fallback: 8000, min: 1000, max: 30000 }`.
- **`VOICE_STRIPPED_INPUTS = ['wait', 'timeout', 'lastAssistant', 'returnResult']`** (carry: `wait: true` on upstream `session.*`).
  - These are never offered, and they are removed from every call before it runs.
  - **Ruling:** 2.1.1 gives agents `returnResult` instead of `wait`. Voice has no calling session, so it gets neither. It never blocks a turn on a session, and reads an answer back with `session.read_reply`. `agentOnlyUsageError` stays in upstream's agent-tool runtime and is not needed here.
- **`VOICE_UPSTREAM_ACTIONS`**, 1.22's set exactly:
  - control: `projects.list`, `models.list`, `session.list`, `session.create`, `session.send`, `session.fork`, `session.status`, `session.messages`, `schedule.list`, `schedule.create`, `schedule.run`, `schedule.delete`, `schedule.toggle`;
  - web: `browser.open`, `browser.snapshot`, `browser.click`, `browser.type`, `browser.scroll`, `browser.back`, `browser.forward`, `browser.inspect`, `browser.capture`, `browser.resize`.

  2.1.1's `session.link`, `file.open`, `memory.*` and `notify.send` are not offered to voice (owner decision 8).
- `VOICE_SESSION_ID = 'voice'` (the voice Chrome session, 1.22 `context.js`).
- `buildVoiceTools({ upstream: context.control.definitions(), registry, switches: { control, web, chrome, computer } }) -> VoiceTool[]`, 1.22's `buildVoiceTools` rebuilt on the registry:
  - **`mittrcraft`** offers the upstream control definitions in `VOICE_UPSTREAM_ACTIONS` (control switch) plus the registry's `jira.get_issue` and `plane.get_issue` when available;
  - **`mittrcraft_web`** offers the upstream web definitions in the list (web switch), plus the registry's available `chrome.*` (Chrome switch) and `computer.*` (Computer switch);
  - **`mittrcraft_voice`** offers the registry's voice-only actions: `session.stop` and `session.read_reply` under the control switch, `chrome.allow_site` under the Chrome switch;
  - **`mittrcraft_end`** is 1.22's `END_TOOL`, verbatim, added whenever anything else is offered;
  - **schema:** 1.22's `toolSchema`, with `action` as `enum` plus `oneOf` of `{ const, description }`. Properties come from `parameters.js`, merged as 1.22's `mergeProperties` does;
  - a tool with no action is not sent.
- `voiceActionTitles({ upstream, registry }) -> Record<action, title>`; `VOICE_END_TITLE = 'End the conversation'`.
- `guardCall(action, { readSeen, assistantSpokeBefore, pendingHost, chromeAllowed }) -> { ok: true } | { refuse: { reasonCode, error } }`. It applies 1.22's refusals in 1.22's order, with 1.22's texts:
  - an allow when Chrome is already allowed answers already allowed (an `ok` with 1.22's note);
  - `refused_after_read`;
  - `confirm_first` for `session.stop` with no assistant words before the person's last;
  - `not_requested` for an allow with no pending host.

  The loop (Task 5) calls it before every tool.
- `createVoiceContextBuilder({ control, chrome, describeSession }) -> ({ directory, sessionId, queuedPrompts, panelOpen }) -> Promise<string>`, a port of 1.22 `context.js`:
  - five lines, ≤ 8000 characters;
  - project and directory come from `projects.list`;
  - the open session line comes from `describeSession`: id, directory, title, status, todos (P21, or "todos unknown"), a waiting permission, and queued prompts;
  - other sessions in the directory come from `session.list { withStatus: true }`, at most 10;
  - Chrome comes from `chrome.pageOf(VOICE_SESSION_ID)`, only when `isHostAllowed(VOICE_SESSION_ID, host)`, otherwise "a page on a site not yet allowed";
  - "In-app browser: open/not open" comes from the client's `panelOpen`;
  - 1.22's `clip` and `quoted` rules apply, and a failed lookup reads "unknown".
- `createSessionLookup({ control, engine }) -> { describe(sessionId, directoryHint) }`. `engine` is `{ url, authHeaders }` from `context.opencode`, with `x-opencode-directory` on every read. It answers `{ found, id, title, directory, status, todo, pendingPermission, sendConfig }`. `sendConfig` is `{ providerID, modelID, agent? }` from the fields P23 found, or null.
- **Contract items:**
  - `control-voice-actions`: every name in `VOICE_UPSTREAM_ACTIONS` is still in `OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS` or `OPENCHAMBER_WEB_ACTION_DEFINITIONS`;
  - `control-voice-parameters`: every vendored parameter name is still a property of upstream's generated control or web tool input. The test materializes upstream's agent-tool plugin in a temp dir and collects `tools.add` inputs with a fake `ctx`;
  - `engine-voice-reads`: the P21 routes.

- [ ] **Step 1:** Write the failing tests:
  - `the tools offer 1.22's actions and no session.link, file.open, memory or notify`;
  - `a switched-off tool's actions leave every voice tool`, and `chrome.allow_site only where Chrome can run`;
  - `the voice-only actions appear in mittrcraft_voice and nowhere else`;
  - `wait, timeout, lastAssistant and returnResult are never offered`;
  - `every tool fits the platform's limits` (≤ 4 tools, descriptions ≤ 4000, parameters ≤ 30 000);
  - `the end tool is offered whenever anything else is`;
  - `a send after chrome.read in the same step is refused and not run`, `chrome.allow_site after any read in the turn is refused` and `a lookup (session.list, session.status) is not a read`, exercised through the exported `guardCall(action, { readSeen, assistantSpokeBefore })` that Task 5's loop uses;
  - context: `never carries message text, page text, todo text or permission details`, `cannot be given extra lines by a page or session title`, `hides the Chrome page of a site the voice has not been allowed on`, `reports no Chrome page without starting Chrome`, and `says a lookup failed instead of reporting it as empty`;
  - the three contract items.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement, porting 1.22 `voice-assistant/tools.js` and `context.js` and their tests.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-server): the voice assistant's tools, guards and per-turn context on the 2.1.1 contract`.

Upstream files added: 0. Running total: 35 + T3.

### Task 5: The voice turn loop, the conversation and the voice-only actions (P4-V6 to P4-V9 server half)

**Files:**
- Create in `packages/mittr-server/src/mittr/voice/`, each with a `*.test.js`:
  - `conversation.js`;
  - `loop.js`;
  - `actions.js`;
  - `speakable.js`;
  - `routes.js`;
  - `index.js` (`setupMittrVoice`).
- Modify:
  - `packages/mittr-server/src/mittr/mittr-settings.js` and its test: the `voice` block and its carry;
  - `packages/mittr-server/src/mittr/index.js` and its test;
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- **Settings (R44).** `mittr-settings.json` gains `voice: { stepCap: 8, replyMaxChars: 8000 }`. An out-of-range or non-integer value reads as the default. `carryParkedVoiceSettings` copies the parked `mittr.voiceStepCap` and `mittr.voiceReplyMaxChars` once (the 4A tools-carry pattern).
- `createVoiceConversation({ now = Date.now, heardTtlMs = 120_000, randomId }) -> { … }`:
  - `start() -> conversationId` ends any live one first (one live conversation per Mac, owner decision 11);
  - `current()`, and `end(conversationId) -> boolean`;
  - `endAll()` is called on an account switch and on dispose;
  - `onEnd(listener)`;
  - `hear(conversationId, text) -> heardId` and `take(conversationId, heardId, said) -> boolean`. A receipt is used once, within `heardTtlMs`, for the conversation it was made in, and only when `sha256(said.trim())` equals what was heard;
  - `pendingHost()`, `setPendingHost(host)`, `chromeAllowed()` and `allowChrome()`, all per conversation.
- **`speakable(text) -> string`** is upstream's `sanitizeForTTS` (`packages/web/server/lib/text/summarization.js`) vendored unchanged. Contract item `sanitize-for-tts` checks it equals upstream's output on a fixture set: Markdown, code fences, URLs, file paths and Thai.
- **`registerVoiceActions(registry, { control, engine, chrome, conversation, settings, switches })`** defines `mittrcraft_voice` (`VOICE_TOOL_DESCRIPTION`) and registers, all `voiceOnly: true`:
  - **`session.stop`** (change; available while the control switch is on): resolve the directory (`input.directory` or `control.resolveSessionDirectory`), then `POST <engine>/api/session/<id>/interrupt` with `x-opencode-directory` (P22). Answers `{ stopped: true, sessionId, directory }`;
  - **`session.read_reply`** (read): `control.execute('session.messages', { sessionId, directory, role: 'assistant', last: true })` (P20), then `speakable` and a cut at `voice.replyMaxChars`. Answers `{ sessionId, directory, text, truncated }`;
  - **`chrome.allow_site`** (change; available while Chrome is available and its switch is on):
    - requires `ctx.conversationId === conversation.current()` and a `pendingHost()`; otherwise it answers 409 `Chrome has not asked for permission in this conversation, so there is nothing to allow`;
    - calls `chrome.allowForConversation(VOICE_SESSION_ID)` and `conversation.allowChrome()`;
    - answers `{ allowed: true, scope: 'conversation', sites: 'all' }`.
- **`runVoiceTurn({ said, history, locale, directory, sessionId, queuedPrompts, panelOpen, conversationId, scope, signal, emit, deps })`** is a port of 1.22 `loop.js`, changed only where 2.1.1 needs it:
  - **dispatch:**
    - a registry action runs `registry.execute(action, input, { surface: 'voice', directory, sessionId: VOICE_SESSION_ID, conversationId, signal: toolSignal, headed: true, scope })`;
    - an upstream action runs `registry.execute(action, input, { surface: 'voice', directory, signal: toolSignal, scope })`, with no `sessionId`, so upstream gets no calling session;
    - `VOICE_STRIPPED_INPUTS` are removed first;
  - **`session.send`** to a target whose `describeSession` status is `busy` or `retry`:
    - emits `{ type: 'queue', sessionId, directory, text, sendConfig }` with the session's own `sendConfig`;
    - with no `sendConfig`, it does not queue and answers `{ error: 'Could not tell which model that session uses, so nothing was queued', reasonCode: 'status_unavailable' }`;
    - `unknown` answers 1.22's `status_unavailable`;
    - P23 may replace this branch (Task 1 ruling);
  - **`site_approval_required`:** 1.22's `failure` records the pending host on the conversation and adds 1.22's `ask` line verbatim;
  - **account pin (Review Focus 1):** `pinAccount({ activeAccountKey })` at the start, checked before each step, after each `ensureFreshSession` and after each tool. A change emits `{ type: 'error', code: 'account_changed' }` and nothing more runs;
  - everything else is 1.22's: the step cap from `voice.stepCap` with the Thai or English closing sentence, `fitMessages`, `serializeResult`, the tool deadline, abort, the quota frame and 429, the end tool with goodbye, and no logging of content.
- **`registerVoiceRoutes(app, { express, conversation, runTurn, client, requestScope, host, logger })`.** Every route needs the R148 local scope; otherwise it answers 403 `The voice assistant can only be used on this Mac` (Review Focus 5).
  - `POST /api/mittr/voice/start` answers `{ conversationId }`;
  - `POST /api/mittr/voice/transcribe` takes multipart `audio` (25 MB, a 16 kHz WAV) and header `x-mittr-voice-conversation`. It answers `{ text, heard }` or `{ error, reasonCode, resetsAt? }` with the speech error's status;
  - `POST /api/mittr/voice/synthesize` takes `{ text }` (1–4000) and streams the platform audio unchanged (content type passed, `nosniff`), or answers `{ error, reasonCode, resetsAt? }`. The client's close aborts it;
  - `POST /api/mittr/voice/turn` (SSE) takes the 1.22 body (`readTurnBody`: said ≤ 4000, locale `th|en`, history ≤ 60 entries of ≤ 20 000 characters, directory, sessionId, queuedPrompts 0–1000) plus `conversationId`, `heard` and `panelOpen?`.
    - A conversation that is not current answers 409 `{ error: 'conversation_ended' }`; a receipt that does not `take` answers 409 `{ error: 'not_heard' }`. Nothing runs in either case;
    - a new turn aborts the conversation's running turn;
    - the client's close aborts the turn;
  - `POST /api/mittr/voice/end` takes `{ conversationId }` and answers 204. It ends the conversation: `chrome.endConversation(VOICE_SESSION_ID)`, the pending host forgotten, the live turn aborted.
- **`setupMittrVoice(context, { registry, tools, speech, mittrSettings, platform, logger }) -> { accountChanged(), dispose() }`:**
  - `accountChanged` calls `conversation.endAll()` and is wired into `setupMittr`'s `onAccountChange` next to `tools.accountChanged()`;
  - on a hosted runtime no voice route is registered, and readiness `here` is false;
  - the voice actions register only when `context.host` is set.
- **Contract items:**
  - `session-interrupt-route`: `POST /api/session/:id/interrupt` (P22);
  - `sanitize-for-tts`.

- [ ] **Step 1:** Write the failing tests (fake platform SSE, fake registry and control). Port every 1.22 `loop.test.js`, `routes.test.js` and `tools`-guard case, plus:
  - `the http surface cannot run chrome.allow_site` (400 through `POST /api/mittr/control`);
  - `an upstream action from voice reaches the control service with no calling session`;
  - `a voice chrome action carries the voice session, the conversation and headed`;
  - `wait and returnResult in a model's call are removed before it runs`;
  - `a send to a busy session is queued with the session's own model`;
  - `a busy session whose model is unknown is not queued`;
  - `records the host of a site approval request and tells the model to ask the person`;
  - `allows Chrome in a later turn after a spoken yes`;
  - `chrome.allow_site uses the pending host, not the model's spelling`;
  - `answers a repeated allow as already allowed`;
  - `after end, a new conversation asks again`;
  - `a turn without a fresh heard receipt answers 409 and runs nothing`;
  - `a receipt is used once, within 120 seconds, for the text it was given`;
  - `a second Talk start ends the first conversation and its Chrome allow`;
  - `a turn whose account changes between steps ends with account_changed and runs nothing more`;
  - `an account switch ends the conversation and its Chrome allow`;
  - `a stub step that sends after a read gets refused_after_read and the session gets nothing`;
  - `every voice route but readiness answers 403 to a forwarded or tunnelled request`;
  - `session.stop interrupts the session in its own directory`;
  - `read_reply speaks the latest answer without Markdown, cut at the setting`;
  - `the closing sentence is Thai after a Thai request at step cap 2 and names 2 steps`;
  - `nothing logged carries what was said, a transcript, a tool argument or a result`;
  - `a hosted runtime registers no voice route`;
  - `1.22 voice limits parked under mittr are carried once`;
  - the contract items.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement, porting 1.22 `voice-assistant/{loop,routes}.js` and `mittrcraft-control/service.js` (`session.stop`, `session.read_reply`, `allowChromeSite`, `endChromeConversation`).
- [ ] **Step 4:** Re-run. Then one live check under `iso`: the real loop against the stub platform's scripted step and the real engine from the 4A probe set-up. Ask "what sessions are running?"; expected: `session.list` runs, the reply streams, 0 non-loopback peers. Touch check: 35 + T3.
- [ ] **Step 5:** Commit `feat(mittr-server): the voice assistant's turn loop, its conversation and the voice-only actions through the Mittr platform`.

Upstream files added: 0. Running total: 35 + T3.

### Task 6: VAD and ONNX in the build (P4-V5 build half)

**Files:**
- Create:
  - `scripts/mittr/vad-assets.json`;
  - `scripts/mittr/vad-assets.mjs` with `vad-assets.test.mjs`.
- Modify:
  - `packages/mittr-ui/package.json`: `dependencies` gains `"@ricky0123/vad-web": "0.0.31"` and `"onnxruntime-web": "1.30.0"`;
  - `bun.lock`, through `bun install` only;
  - `scripts/mittr/build-desktop.mjs` and its test;
  - `brand/THIRD_PARTY_NOTICES.md`;
  - `brand/electron-builder.dev.json` and `brand/electron-builder.prod.json`, only if Task 1 S5 found no `NSMicrophoneUsageDescription`.

**Interfaces:**
- `vad-assets.json` lists the four runtime files 1.22 copied (`scripts/copy-vad-assets.mjs`), each with its package, version, path inside the package and sha256 read from the installed copy:
  - `vad.worklet.bundle.min.js` and `silero_vad_v5.onnx` from `@ricky0123/vad-web` 0.0.31;
  - `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm` from `onnxruntime-web` 1.30.0.
- `resolveVadSources({ repoRoot }) -> { vadDir, ortDir }`. It resolves the packages from `packages/mittr-ui`, then `onnxruntime-web` from the vad-web entry, as 1.22 did.
- `stageVadAssets({ pins, sources, outDir }) -> string[]` copies and checks each sha256. A missing or different file fails with `<file> is missing or does not match scripts/mittr/vad-assets.json (expected sha256 <sha>).`
- `verifyPackedVadAssets({ appPath, pins })`: the four files are in the packed renderer folder under `vad/` with the pinned sha256 values.
- **Build:**
  - step 4 stages into `packages/electron/resources/web-dist/vad/` after upstream's desktop build has written `web-dist`;
  - step 8 verifies the packed copy. Record the packed path in the test (`Contents/Resources/web-dist` or inside `app.asar`, whichever step 6 gives).
  - Nothing is written under `packages/web/public`.
- **Install:** `bun install` with the cache as above. If bun asks the network for any package, stop (owner decision 7). Record the `bun.lock` lines added.
- **Notices:** three sections, each the package's own `LICENSE` file text copied unchanged from the installed package, pinned by sha256 in `build-desktop.mjs` as R146 did:
  - `@ricky0123/vad-web` (ISC);
  - `onnxruntime-web` (MIT);
  - the Silero VAD model (MIT, the text vad-web ships).

  A package with no `LICENSE` file is an owner item, not a fetch.

- [ ] **Step 1:** Write the failing tests:
  - `a file whose sha256 differs is refused with the exact message`;
  - `the four files are staged beside the renderer, not in packages/web/public`;
  - `the dev and prod builds verify the packed VAD files`;
  - `the notices hold the three licence texts with their pins`.
- [ ] **Step 2:** `iso node --test scripts/mittr/vad-assets.test.mjs scripts/mittr/build-desktop.test.mjs`. Expected: FAIL.
- [ ] **Step 3:** Run the install, then implement. Run `node scripts/mittr/build-desktop.mjs --flavor dev`.
- [ ] **Step 4:** Re-run the tests, the build (exit 0, leak scan 0 unexplained), `bun run type-check`, `bun run lint` (knip included) and the touch check: 35 + T3 (`bun.lock` already counted). Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr): pack Silero VAD and the ONNX runtime for Talk, pinned, with their notices`.

Upstream files added: 0. Running total: 35 + T3.

### Task 7: Hook: the composer-action slot and the dictation block (spec hook 11)

**Files:**
- Modify (hook):
  - `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx` (**new counted file, +1**);
  - `packages/ui/src/lib/product-plugins.ts` (hook file, not counted);
  - `brand/upstream-hooks.json`.
- Create `packages/ui/src/components/chat/composer/ui/ComposerFooter.product.test.tsx`.
- Modify `packages/mittr-server/src/upstream-contract.{js,test.js}`.
- **Fallback, only under owner decision 5:** `packages/ui/src/components/dictation/ComposerDictation.tsx` (+1), the shortcut honouring the block.

**Interfaces:**
- **Slot.** `ProductSlotProps['composer-actions'] = { isMobile: boolean; footerIconButtonClass: string; iconSizeClass: string; dictationActive: boolean }`.
- **Plugin field.** `ProductUiPlugin.composer?: { useDictationBlock: () => { blocked: boolean; reason?: string } }`.
- **Hook.** Exported `useProductDictationBlock(): { blocked: boolean; reason?: string }`:
  - with no plugin it answers `{ blocked: false }`;
  - once the footer has called it, a plugin registered later is ignored until reload, the rule the model-picker hook already follows;
  - a plugin that throws reads as not blocked.
- **`ComposerFooter.tsx`:**
  - one `<ProductSlot name="composer-actions" … />` right after the dictation button in the desktop row and in the mobile row;
  - both dictation buttons get `disabled={<existing> || block.blocked}`, and `title`/`aria-label` gets `block.reason` when blocked;
  - with no plugin the footer renders as before.
- **Contract item** `composer-actions-slot`: the slot name, its props and `useProductDictationBlock` are in `product-plugins.ts`, and both footer rows call them.

- [ ] **Step 1:** Write the failing tests (neutral fixtures, `renderToStaticMarkup`):
  - `a plugin's composer action renders beside the microphone on desktop and on mobile`;
  - `without a plugin the footer has no extra element and the microphone is enabled`;
  - `a plugin that blocks dictation disables both microphone buttons and names the reason`;
  - `a plugin whose block hook throws leaves dictation enabled`;
  - the contract item.
- [ ] **Step 2:** `iso bun test packages/ui/src/components/chat/composer/ui/ComposerFooter.product.test.tsx` and `iso bun run --cwd packages/mittr-server test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Append `{ hook: 'composer-actions', why }` to the `ComposerFooter.tsx` and `product-plugins.ts` entries. The why: a downstream build adds its own composer action beside the microphone (a voice assistant button) and can hold dictation off with a reason, without editing the footer on every upstream release. With no plugin nothing changes.
- [ ] **Step 4:** Re-run, then `bun run type-check`, `bun run lint`, `node scripts/mittr/neutral-hook-tests.mjs` (0) and the touch check: **36 + T3** of 40.
- [ ] **Step 5:** Commit `hook(composer-actions): a composer action slot beside the microphone and a dictation block for product plugins`.

Upstream files added: 1. Running total: 36 + T3 (+1 under decision 5).

### Task 8: The voice client in mittr-ui (P4-V5, P4-V6, P4-V8, P4-V9 client half)

**Files:**
- Create in `packages/mittr-ui/src/voice/`, each with a test, porting 1.22 `packages/ui/src/lib/voice-assistant/*` and `lib/mittr-quota/speech-quota-store.ts` with their tests:
  - `voiceApi.ts`;
  - `voiceSession.ts`;
  - `listen.ts`;
  - `player.ts`;
  - `sentences.ts`;
  - `narration.ts`;
  - `queue.ts`;
  - `keys.ts`;
  - `talkStore.ts`;
  - `week.ts`;
  - `speechQuotaStore.ts`;
  - `speechStateClient.ts`;
  - `upstreamSpeech.ts` (new: it points upstream's speech settings at Mittr).
- Modify `packages/mittr-ui/src/strings/mittr.en.ts` and `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- **`createVoiceApi(fetch: runtimeFetch) -> VoiceApi`** is 1.22's `turn.ts`, re-pointed at Task 3/5 routes:
  - `readiness()` uses `/api/mittr/voice/readiness`, and `isTalkReady` also needs `here === true`;
  - `start() -> conversationId`;
  - `end(conversationId)`;
  - `transcribe(wav, conversationId, signal) -> { text, heard }`, throwing `TranscribeError(code, resetsAt)`;
  - `synthesize(text, signal) -> { contentType, body }`, throwing `SynthesizeError(code, resetsAt)`;
  - `turn(request, signal)`. The request adds `conversationId`, `heard` and `panelOpen` to 1.22's `VoiceTurnRequest`. `VoiceTurnFailure` adds `account_changed`. `VoiceQueueEvent` adds `sendConfig`.
- **`VoiceSession`** is 1.22's `session.ts` unchanged in behaviour (phases, barge-in, `speakQueue`, `HISTORY_LIMIT` 20, `TEXT_LIMIT` 2000, quota notices), except:
  - it calls `start()` before listening and `end(conversationId)` when it ends;
  - each turn carries the `heard` from its own transcription;
  - `account_changed` ends the conversation with the bar line `mittr.voice.accountChanged` ("The Mittr account changed.") and nothing spoken.
- **`listen.ts`, `player.ts`, `sentences.ts`, `keys.ts`** are 1.22's verbatim, with `VAD_ASSET_PATH = '/vad/'`.
- **`narration.ts`** is 1.22's verbatim (the `SPOKEN` texts in both languages).
- **`queue.ts`:** `queueSpokenPrompt(event)` calls 2.1.1's `useMessageQueueStore.getState().addToQueue(createMessageQueueTarget(sessionId, directory), { content, sendConfig })` with `event.sendConfig`. `queuedPromptCount` reads `getQueueForTarget`. Both follow P24.
- **`speechQuotaStore.ts`** is 1.22's store. `speechStateClient.ts` long-polls `/api/mittr/speech/state` and drives `block`/`clear`, so a refusal from upstream's dictation or read-aloud reaches the store too.
- **`upstreamSpeech.ts`**, against 2.1.1's `useConfigStore` (Task 1 S1/S2 shapes):
  - `MITTR_SPEECH_MODEL = 'mittr'`, `MITTR_SPEECH_VOICE = 'mittr'`;
  - `isMittrSpeechUrl(url) -> boolean`: http, a loopback host, and a path of exactly `/mittr-speech/v1`;
  - `mittrDictationOn(state)`: `sttProvider === 'openai-compatible' && isMittrSpeechUrl(sttServerUrl)`;
  - `mittrReadAloudOn(state)`: `voiceProvider === 'openai-compatible' && isMittrSpeechUrl(openaiCompatibleUrl)`;
  - `chooseMittrDictation(baseUrl)`: `setSttProvider('openai-compatible')`, `setSttServerUrl(baseUrl)`, `setSttModel('mittr')`, then `PUT /api/mittr/speech/key { stt: true }` and `refreshVoiceApiKeys({ force: true })`;
  - `chooseMittrReadAloud(baseUrl)`: `setVoiceProvider('openai-compatible')`, `setOpenaiCompatibleUrl(baseUrl)`, `setOpenaiCompatibleTtsModel('mittr')`, `setOpenaiCompatibleVoice('mittr')`, `setTtsChunkedMode(true)`, then `PUT /api/mittr/speech/key { openaiCompatible: true }`;
  - `stopMittrDictation()` and `stopMittrReadAloud()`: upstream's defaults (`'local'` and `'browser'`), and remove our key for that kind;
  - `followPort(state, baseUrl)`: at load, a field holding a Mittr speech URL with another port is rewritten to `baseUrl`, and nothing else changes;
  - `applyFirstRun(state, facts)`: 1.22's defaults (`resolveUnsavedSttProvider`, `resolveInitialVoiceProvider`).
    - With no saved STT provider, no saved local model and none installed, it uses Mittr dictation; with no saved voice provider, Mittr read-aloud. Not in VS Code; once (owner decision 3).
    - A `carryDictation` from Task 3 uses Mittr dictation once, then `POST /api/mittr/speech/carried`.
  - `MittrVoiceRoot` (Task 9) runs `followPort` and `applyFirstRun` once after sign-in, from `GET /api/mittr/speech`. It does nothing when `offered` is false.
- **Strings:**
  - every 1.22 key of `voice.i18n.ts` becomes `mittr.voice.*`;
  - `quota.stt.exhausted`, `quota.tts.exhausted`, `quota.kind.stt` and `quota.kind.tts` become `mittr.speech.*`;
  - English values are unchanged, plus `mittr.voice.accountChanged`.
- **Contract items:**
  - `message-queue-add`: `createMessageQueueTarget`, `addToQueue` and `getQueueForTarget`, with the `QueuedMessageSendConfig` fields;
  - `runtime-fetch`;
  - `speech-config-store`: the store fields and setters `upstreamSpeech.ts` uses, `refreshVoiceApiKeys`, and the `sttProvider` values.

- [ ] **Step 1:** Port the 1.22 tests (`turn`, `session`, `listen`, `player`, `sentences`, `narration`, `queue`, `keys`, `speech-quota-store`) to the new names and routes, then add:
  - `a turn carries the conversation and the receipt of its own transcription`;
  - `ending the conversation calls end once with its id`;
  - `account_changed ends the conversation silently with the bar line`;
  - `the queue event adds one entry with that send config`;
  - `a block from the server state disables voice input until it lifts`;
  - `Talk is not ready away from this Mac`;
  - `upstreamSpeech`:
    - `choosing Mittr voice input points upstream dictation at this run's speech endpoint and installs the key`;
    - `stopping it restores upstream's provider and removes only our key`;
    - `a changed port is followed and nothing else changes`;
    - `a person's own speech server is never rewritten`;
    - `a fresh install uses Mittr for both, once, unless a local model is installed`;
    - `a 1.22 Mittr dictation choice is carried once`;
  - `Mittr strings are English in Japanese`;
  - the contract items.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, then `bun run type-check` and `bun run lint`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mittr-ui): the voice assistant's client: listening, turns, spoken replies, queueing and the speech quota`.

Upstream files added: 0. Running total: 36 + T3.

### Task 9: Talk, the voice bar and the dictation block in the window (P4-V2, P4-V5, P4-V9 UI)

**Files:**
- Create in `packages/mittr-ui/src/voice/`, each with a test:
  - `TalkButton.tsx`;
  - `VoiceBar.tsx`;
  - `VoiceQuotaText.tsx`;
  - `ComposerVoiceActions.tsx`;
  - `useMittrDictationBlock.ts`;
  - `MittrVoiceRoot.tsx`.
- Modify:
  - `packages/mittr-ui/src/product-ui-plugin.tsx` and its test;
  - `packages/mittr-ui/src/strings/mittr.en.ts`;
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`.

**Interfaces:**
- **`TalkButton`, `VoiceBar`, `VoiceQuotaText`** are ports of 1.22's components. They use upstream's `Icon` (`voiceprint`, `loader-4`) and theme tokens.
  - `TalkButton` renders nothing unless `isTalkReady` (here, signed in, listen/speak/voice ready) or a conversation is open. While voice input is blocked it is a disabled button titled with `mittr.speech.sttExhausted` (`Voice input is out of quota until {when}`), `when` from `formatResetTime(…, PRODUCT_LOCALE, PRODUCT_TIME_ZONE)`.
  - `VoiceBar` shows Listening / Thinking / Speaking / `Working: {label}`, what was said and the reply, and End.
- **`ComposerVoiceActions`** fills `composer-actions`. It renders `TalkButton` with the slot's classes, and nothing in VS Code or where dictation capture is unsupported (`isDictationCaptureSupported`).
- **`useMittrDictationBlock()`**, the plugin's `composer.useDictationBlock`:
  - blocked when Mittr is the voice input (Task 8's `mittrDictationOn`) and either `speechQuotaStore.stt` is set (reason `Voice input is out of quota until {when}`) or readiness says listen is not ready (reason from the 1.22 provider note: `Sign in to Mittr to use it.`, `Your Mittr admin has not set up speech models yet.`, `The Mittr platform cannot be reached right now.`);
  - otherwise not blocked;
  - it re-renders when the block lifts (1.22's timer in `useSpeechQuotaBlock`).
- **`MittrVoiceRoot`**, rendered by `MittrRoot` on the `main` surface only, inside `MittrErrorBoundary`:
  - it owns the one `VoiceSession` and portals `VoiceBar` to `document.body`;
  - Escape ends the conversation (`bindEscapeToEnd`);
  - the person's next turn context comes from `useSessionUIStore.currentSessionId` and the directory store;
  - narration on the viewed session's finish, waiting permission, error or stop comes from `useSessionStatus` / `useSessionPermissions` (2.1.1 `sync/sync-context`), through 1.22's `createNarrationWatch`;
  - an account change (phase 2 `accountChange.ts`) or sign-out ends the conversation;
  - readiness refreshes every 60 s and on window focus;
  - the speech state client starts with the root;
  - once after sign-in it runs Task 8's `followPort` and `applyFirstRun` from `GET /api/mittr/speech`.
- **Wiring:** `product-ui-plugin.tsx` adds `slots['composer-actions']: ComposerVoiceActions` and `composer: { useDictationBlock: useMittrDictationBlock }`.
- **Contract items:**
  - `session-sync-hooks`: `useSessionStatus`, `useSessionPermissions` and `useSessionUIStore.currentSessionId`;
  - `dictation-capture-supported`.

- [ ] **Step 1:** Write the failing tests (controllers plus `renderToStaticMarkup`), porting 1.22's `TalkButton.test.tsx` and `VoiceBar.test.tsx`, plus:
  - `Talk renders beside the microphone when voice is ready`;
  - `Talk is disabled with the reset time while voice input is used up`;
  - `a hosted runtime renders no Talk button` (readiness `here: false`);
  - `the microphone is disabled with the reset time and re-enabled when the block lifts`;
  - `a not-configured platform disables the microphone with the admin line`;
  - `the bar shows Working with the action's title`;
  - `Escape ends the conversation`;
  - `an account switch ends the conversation`;
  - `the bar is only on the main surface`;
  - `Mittr strings are English in Japanese`;
  - plugin: `the composer-actions slot holds the Talk button and the dictation block is the plugin's`.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement per `theme-system`, `ui-api-decoupling` and `locale-ui-patterns`.
- [ ] **Step 4:** Re-run, then `bun run type-check`, `bun run lint` and `node scripts/mittr/test-baseline.mjs`. Expected: PASS. Touch check unchanged.
- [ ] **Step 5:** Commit `feat(mittr-ui): Talk beside the microphone, the voice bar, and voice input that waits out its quota`.

Upstream files added: 0. Running total: 36 + T3.

### Task 10: MittrCraft voice settings (P4-V1, P4-V3, P4-V4 UI, C-01, C-11)

**Files:**
- Create `packages/mittr-server/src/mittr/voice/settings-routes.js` with its test.
- Create in `packages/mittr-ui/src/voice/`, each with a test:
  - `voiceSettingsApi.ts`;
  - `voiceSettingsController.ts`;
  - `MittrVoiceSection.tsx`.
- Modify:
  - `packages/mittr-ui/src/product-ui-plugin.tsx`;
  - `packages/mittr-ui/src/integrationsPage.ts` (default placement);
  - `packages/mittr-ui/src/strings/mittr.en.ts`;
  - `packages/mittr-ui/src/voice/readAloudTiming.test.ts` (from Task 1);
  - `packages/mittr-server/src/upstream-contract.{js,test.js}`.
- **Alternative placement, owner decision 2:** `packages/ui/src/components/sections/openchamber/VoiceSettings.tsx` (+1) with a `voice-settings` slot.

**Interfaces:**
- **Routes** (UI auth; writes need the R157 local scope):
  - `GET /api/mittr/voice/settings` answers `{ stepCap, replyMaxChars, canChange }`;
  - `PUT /api/mittr/voice/settings` takes `{ stepCap?, replyMaxChars? }`. Integers in range are stored; anything else answers 400 `Unknown or invalid voice setting: <key>`.
- The two switches read `mittrDictationOn` / `mittrReadAloudOn` and call `chooseMittr…` / `stopMittr…` from Task 8's `upstreamSpeech.ts`.
- **`MittrVoiceSectionView`** is markup only, from upstream's `SettingsSection`, `SettingsCheckboxRow`, `SettingsFieldRow`, `NumberInput` and `Button`. The section title is `mittr.voice.title` ("MittrCraft voice"). It holds:
  - the switches "Voice input through Mittr" and "Read aloud through Mittr", with 1.22's `settings.voice.mittr.description` line ("Uses the speech models your Mittr admin pinned on the platform. Nothing to set up here.") and the reason note when readiness has one;
  - one line saying the speech key replaces a key stored for another speech server;
  - "Preview voice", which plays 1.22's preview sentence through `/api/mittr/voice/synthesize` and is shown only while speak is ready;
  - "Most actions per spoken request" (1–20, default 8), with 1.22's hint;
  - "Longest agent answer read aloud (characters)" (1000–30000);
  - nothing at all on a hosted runtime (`offered: false`); without `canChange`, values only and one line, as 4A's tools section does.
- **Placement (owner decision 2):** default is the `integrations-page` slot, after MittrCraft tools, in `MittrErrorBoundary` (0 files).
- **`readAloudTiming.test.ts`** keeps Task 1's S3 assertion: with 2 s synthesis per chunk, chunks are fetched ahead and no gap exceeds 2 s.
- **Contract item** `settings-number-input`: `NumberInput` is still exported where the section imports it.

- [ ] **Step 1:** Write the failing tests:
  - routes: `PUT stores in-range limits`, `an out-of-range value answers 400 and stores nothing`, `a forwarded request cannot change them`;
  - controller: `a switch turned on calls chooseMittrDictation with the server's base URL`, `a failed write reloads the stored state`;
  - view: `a hosted runtime renders no Mittr speech switch`, `the reason line shows when the platform has no speech models`, `preview is hidden while speaking is not ready`, `Mittr strings are English in Japanese`;
  - plugin: `the integrations slot holds Work tracking, MittrCraft tools, then MittrCraft voice`;
  - the contract item.
- [ ] **Step 2:** `iso bun run --cwd packages/mittr-server test` and `iso bun run --cwd packages/mittr-ui test`. Expected: FAIL.
- [ ] **Step 3:** Implement per `settings-ui-patterns` and `theme-system`.
- [ ] **Step 4:** Re-run, then `bun run type-check`, `bun run lint` and `node scripts/mittr/test-baseline.mjs`. Expected: PASS. Touch check: 36 + T3 (+1 under decision 2's alternative).
- [ ] **Step 5:** Commit `feat(mittr): MittrCraft voice settings: Mittr for voice input and read-aloud, preview, and the assistant's limits`.

Upstream files added: 0 (or 1 under decision 2's alternative). Running total: 36 + T3 + T10.

### Task 11: Phase 4B gate — every voice row on an isolated Dev build

**Files:**
- Create `docs/plans/2026-10-22-phase-4b-gate.md`.
- Modify `scripts/mittr/stub-platform.mjs` and `scripts/mittr/stub-platform.test.mjs`.
- Create `scripts/mittr/voice-fixtures.mjs` with its test: fixture WAVs made locally and their sha256 map.

**Isolation.** Every launch follows the Global Constraints:
- a fresh `/tmp/p4.XXXX` HOME per scenario;
- the Dev binary launched directly with the fake-media flags and `--mute-audio`, and killed by its PID;
- the R46 per-call guard;
- R9 recorded;
- the TCC log before and after;
- a before and after `stat` of the real dirs and of the real Chrome folder's top level;
- the owner's Chrome PIDs before and after.

The evidence stays outside the repository, holds no secret and no audio, and is never named.

The gate runs in two parts:
- **Part A** is headless on a loopback stub platform, with stub audio, a throwaway Chrome and no real microphone, and needs no owner.
- **Part B** runs only with the owner present, and the owner's yes for each numbered step.

- [ ] **Step 1: Stubs and static checks.**
  - **Stub platform**, extended with tests. Every shape matches the platform controllers in the Tech Stack.
    - `GET /desktop/speech/readiness`, with modes `ready`, `not_configured` and `voice_off`.
    - `POST /desktop/speech/transcribe`, mapping a fixture's sha256 to its transcript. Modes:
      - `quota` answers 429 with kind `stt` and `resetsAt` 7 days ahead;
      - `empty` answers 422 `empty_transcript`;
      - `slow` holds the answer for 8 s.
    - `POST /desktop/speech/synthesize` answers `audio/pcm;rate=24000;channels=1`: 0.1 s of silence per 20 characters, sent in 4 parts 200 ms apart. Modes: `quota` (kind `tts`) and `not_configured` 409.
    - `POST /desktop/voice/step`, validated with the controller's limits (a breach answers SSE `bad_request`) and scripted on the last user message:
      - "what sessions are running" → `mittrcraft { action: 'session.list' }`, then text naming the count;
      - "send 'add a README' to the newest session" → `session.list`, then `session.send`;
      - "what did it answer" → `mittrcraft_voice { action: 'session.read_reply' }`;
      - "stop the newest session" → text "Should I stop it?"; a following "yes" → `session.stop`;
      - "open <url> in Chrome and tell me the heading" → `mittrcraft_web chrome.open`. A `site_approval_required` result → text "May I use Chrome for this conversation?"; "yes" → `chrome.allow_site`, then `chrome.open`, then `chrome.read`;
      - a Thai request beginning "ทำต่อ" → a tool call every step until the cap;
      - "bye" → `mittrcraft_end` with "Goodbye.";
      - **rule-breaking mode:** `chrome.read` then `session.send` in one step;
      - **quota mode:** a `llm_quota_exhausted` frame, and a 429 body.
    - It records the tools offered and the actions called, never a header or audio.
  - **Fixtures:** `say -v Samantha` for English and `say -v Kanya` for Thai (if installed; otherwise Thai rows run with English fixtures and say so), converted to 16 kHz mono WAV. Each is followed by 25 s of silence so the looping fake capture gives one utterance per loop.
  - **Build and static checks:**
    - `node scripts/mittr/build-desktop.mjs --flavor dev`: exit 0, leak scan clean, drivers, VAD files and notices verified;
    - `node scripts/mittr/check-upstream-touch.mjs --no-write`: **36 + T3 + T10 of 40**, nothing unlisted, nothing stale;
    - `bun run type-check`, `bun run lint`, `node scripts/mittr/test-baseline.mjs`;
    - `iso bun run --cwd packages/mittr-server test`, `iso bun run --cwd packages/mittr-ui test`, `iso bun run --cwd packages/mittr-opencode test`;
    - `node scripts/mittr/neutral-hook-tests.mjs`.
- [ ] **Step 2 — Part A, headless.**
  - **Launch setup:**
    - `MITTRCRAFT_BROKER_URL=http://127.0.0.1:<stub>`, the 4A driver and Chrome settings (stub cua-driver, throwaway profile, refusing proxy, `chromeHeaded` false);
    - the fake-media flags with the fixture of each row, and `--mute-audio`;
    - Talk clicked and the bar read through DevTools.
  - Record the command, the observed value and PASS or FAIL for each:
  - **P4-V1:**
    - with Mittr voice input on, the dictation shortcut on the "what sessions are running" fixture puts that text in the composer;
    - upstream's Settings → Voice shows OpenAI-compatible, the loopback URL and model `mittr` (DOM read, for owner decision 3);
    - readiness `not_configured`: the microphone is disabled with the admin line and no request reaches `/desktop/speech/transcribe`.
  - **P4-V2:** stt `quota`. Dictate: the text shows `Voice input is out of quota until <when>`, and the microphone is disabled with it. Record whether upstream's Retry shows (decision 5). Clear the mode: within one long-poll the block lifts and the next dictation works.
  - **P4-V3:**
    - read aloud a 6000-character answer: the stub sees ≥ 2 synthesize calls, and every chunk plays. Record the largest gap from the window's playback timestamps (muted);
    - tts `not_configured`: a visible message, not silence.
  - **P4-V4:** change both limits, restart on the same HOME: both kept in `mittr-settings.json`. Preview sends one synthesize call.
  - **P4-V5:** Talk, "what sessions are running": the bar goes Listening → Thinking → Speaking and shows the reply. Escape: the bar closes, every audio track reads `ended`, and `POST /api/mittr/voice/end` is seen.
  - **P4-V6:** two sessions open:
    - "send 'add a README' to the newest session": that session gets the prompt and runs;
    - "what did it answer": the bar shows its latest reply, cut at the setting;
    - "open http://127.0.0.1:<p>/form in Chrome and tell me the heading": the driver is asked for a headed session (A-15 `510964a11`) and the heading is in the reply. No window is shown in Part A. `MITTRCRAFT_BUNDLED_AGENT_BROWSER_DIR` points at the 4A gate's wrapper, extended to record and then remove `--headed` and `--init-script` before it runs the packed binary. This is gate tooling only; the product is unchanged.
  - **P4-V7:**
    - "stop the newest session" asks first; "yes" stops it (`/interrupt` seen);
    - two Chrome pages on one site: one question, one yes, no second question;
    - "end the conversation", then a new Talk: asked again;
    - "bye": the goodbye plays and the conversation ends.
  - **P4-V8:**
    - step cap 2 with the Thai fixture: the closing sentence is Thai and names 2 steps;
    - send by voice to a busy session: the composer queue shows the text, and it is delivered when the session finishes;
    - rule-breaking mode: `refused_after_read`, and the session gets nothing.
  - **P4-V9:** voice-step quota. Talk ends with the reset time and the last answer stays as text. stt quota: Talk is disabled with the reset time.
  - **Chrome seams:**
    - a voice `chrome.open` on a new site raises no engine card (`GET /api/permission/request` is empty);
    - removing the site in Settings during the conversation: the next voice Chrome call asks again;
    - an always-allowed site opens with no question.
  - **Accounts (Review Focus 1):** SA and SB signed in. Switch to SB while a turn waits on a slow step: the turn ends with `account_changed`, no further step is sent, and the conversation and its Chrome allow end. SB's next dictation uses SB (stub record).
  - **Remote and hosted (Review Focus 5):**
    - the voice routes with `X-Forwarded-For: 203.0.113.9`: 403, readiness `here: false`;
    - the speech endpoint from a relay header or with the shim key: 401;
    - packed `mittrcraft serve`: no Talk button, no Mittr speech switch, and readiness `here: false`.
  - **Secrets:**
    - `grep -r -F` of the speech key (read from `voice-keys.json` into a shell variable, never printed) across the logs, the evidence and the stub's state: 0;
    - `voice-keys.json` mode 600;
    - `ps eww <engine>` holds no speech key;
    - no transcript text in any log (fixture transcripts grepped).
  - **C-02:** in Japanese, the voice section, Talk and the bar show English Mittr strings and no raw key.
  - **Egress:** loopback only, apart from phase 3's known upstream peers.
- [ ] **Step 3 — Part B, INTERACTIVE BLOCK (owner at the keyboard; one sitting; the owner's yes per numbered step).** The owner types every credential and answers every OS dialog, the microphone prompt included. The controller reads results only (R10). Every step records its before state.
  1. Sign in as A on a fresh HOME (R66 links), on the dev platform. Record the TCC microphone entries before.
  2. **Microphone (owner only):** press Talk; the owner answers macOS's microphone prompt for MittrCraft Dev. Record which name the prompt shows.
  3. **P4-V1 on the dev platform:** the owner dictates a Thai sentence: the text appears.
  4. **P4-V3:** read aloud a long answer: it plays to the end; the owner judges gaps.
  5. **P4-V5 and P4-V6:** "what sessions are running?"; "send 'add a README' to the newest session"; "what did it answer?".
  6. **P4-V7 with the real Chrome:**
     - "open example.com in Chrome and tell me the heading": the visible voice Chrome on the owner's profile (R163, F39 route), one question, a spoken yes, the heading spoken;
     - a second page on the same site: no question;
     - "end the conversation", then Talk again: asked again.
  7. **P4-V8:** a Thai request with the step cap at 2: a Thai closing sentence.
  8. **P4-V9 and P4-V2:** only if the owner sets account Q's speech quota low on dev; otherwise NOT RUN.
  9. **Clean-up:** end Talk, close the voice Chrome, restore Settings. The owner decides whether to revoke the microphone grant. Record after.
- [ ] **Step 4:** Isolation evidence:
  - the real dirs `diff` is empty;
  - the real Chrome folder's top level was untouched in Part A;
  - no TCC entry or prompt in Part A;
  - no upstream default dirs in any temp HOME;
  - the installed apps' PIDs and uptime are unchanged;
  - the 57133 holder before each launch, and every `$PORT` call guarded;
  - R9 before and after;
  - the egress table.
- [ ] **Step 5:** Write the gate note:
  - a verdict table by group: dictation, read-aloud, settings, Talk, turn loop, voice-only actions, guards, quota, Chrome seams, accounts, remote and hosted, secrets, egress, isolation;
  - every row with evidence, and findings numbered;
  - the touch count, with each new file's hook and why;
  - a "needs the owner" list naming each NOT RUN row and what would unblock it;
  - platform follow-ups.

  Commit `docs(mittr): phase 4B gate on the Dev build`. **Do not push.**

Upstream files added: 0. Running total: 36 + T3 + T10.

---

## 4A carries and how this plan settles each

| Carry (4A ledger and final review) | Settled by |
|---|---|
| The voice surface has no local gate in `registry.execute` | Task 2: Chrome and Computer on `voice` need `scope.local`, as on `http`. Task 5: every voice route but readiness needs the R148 local scope and passes it to the registry. |
| `wait: true` on upstream `session.*` would hold a turn open; `agentOnlyUsageError` lives only in the agent-tool runtime | Task 4 ruling: `wait`, `timeout`, `lastAssistant` and `returnResult` are never offered and are removed from every voice call. Voice reads answers with `session.read_reply`. |
| `removeHost` must clear conversation grants | Task 2: any removal empties the conversation grants; tested from Settings. |
| `allowForConversation` only by a spoken yes inside a live voice conversation, never by a route or the UI | Task 2: source-scan test, and the `http` surface cannot run it. Task 5: voice-only action, server-heard receipt per turn, current conversation, pending host only, never after a read in the turn, ended by end, a new start, or an account switch. |
| The `closeAll` generation-bump window | Task 2: a call begun during a close waits for it and starts in the new generation. Task 5: an account switch also ends the conversation and aborts its turn. |
| Voice ask-or-refuse for a Chrome card (R162) | Task 2: on `voice`, a site not yet allowed answers `site_approval_required` with the host and raises no card. Task 5: 1.22's spoken question and `chrome.allow_site`. Voice never reads or answers an engine card. |
| `context.progress` running state (Task 4 #7) | Task 2: the plugin reports progress as upstream's template does. Ruling: the voice bar's "Working: <action>" comes from the turn stream. |

## Coverage and budget

| Inventory item | Task(s) |
|---|---|
| P4-V1 Mittr dictation | 1 (S1), 3, 10, 11 |
| P4-V2 dictation stops on the speech quota | 1 (S1, S4), 3, 7, 8, 9, 11 |
| P4-V3 Mittr read-aloud | 1 (S2, S3), 3, 10, 11 |
| P4-V4 voice settings | 5, 10, 11 |
| P4-V5 Talk button and voice bar | 1 (S4, S5), 6, 7, 8, 9, 11 |
| P4-V6 voice turn loop | 1 (S6), 2, 4, 5, 8, 11 |
| P4-V7 voice-only actions | 1 (P20, P22), 2, 5, 11 |
| P4-V8 voice guards and queued sends | 1 (P23, P24), 4, 5, 8, 11 |
| P4-V9 voice and quota | 3, 5, 8, 9, 11 |
| A-02 session actions by voice | 4, 5, 11 |
| A-15 visible Chrome for voice (`510964a11`) | 5 (`headed: true`), 11 |
| A-31 one contract for agent, window, CLI and voice | 2, 5 |
| C-01 Settings pages (MittrCraft voice) | 10, 11 |
| C-02 English Mittr strings | 8, 9, 10, 11 |
| C-11 `voiceStepCap`, `voiceReplyMaxChars` under `mittr` | 5 |
| C-18 the dictation shortcut | 1 (S4), 7, 11 |
| Spec §9 gate 4: dictation and read-aloud show quota reasons; Talk drives sessions and Chrome | 11 |

Carried, not in this phase:
- **Phase 5 walk:** voice in the full walk of every sidebar item and exit, and the prod build against `api.mittr.asia`.
- **Platform follow-ups:** a vision flag in the catalog (4A). Whether the dev platform has `voice.end` on its fast decision list (1.22 handoff), checked in Part B.

### Upstream files this phase may count

| File | Task | Hook | When |
|---|---|---|---|
| `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx` | 7 | `composer-actions` | planned |
| `packages/ui/src/components/sections/openchamber/VoiceSettings.tsx` | 10 | `voice-settings` slot | owner decision 2, alternative |
| `packages/web/server/lib/dictation/service.js` | 3 | Mittr STT provider | only if Task 1 S1 fails |
| `packages/web/server/lib/tts/routes.js` | 3 | Mittr TTS branch | only if Task 1 S2 fails |
| `packages/ui/src/components/dictation/ComposerDictation.tsx` (+ `packages/web/server/lib/dictation/stream-manager.js`) | 7 | dictation block on the shortcut, no Retry on quota | owner decision 5, alternative (+1 or +2) |

Edits to files already counted or generic (no count change):
- `packages/ui/src/lib/product-plugins.ts` (hook file);
- `bun.lock` (Task 6);
- `packages/electron/main.mjs`, only if Task 1 S5 needs a CSP or permission change there.

Zero-touch routes taken first:
- upstream's OpenAI-compatible dictation and read-aloud pointed at our own loopback speech endpoint, instead of a Mittr provider in upstream's speech code;
- Talk's speech and turn on our own routes, not upstream's `/api/voice/*`;
- the voice-only actions in the 4A registry, not upstream's action list;
- the voice bar as a portal from the existing root wrapper;
- the voice settings in the existing `integrations-page` slot;
- the VAD assets staged by our build script into the built renderer, not `packages/web/public` or upstream's build script;
- 2.1.1's server-owned message queue through its own store, not a queue of ours;
- the session reads through the control service, plus three engine reads with `x-opencode-directory`.

### Budget, against the cap of 40

| Point | Counted files | Remaining |
|---|---|---|
| After 4A (today) | 35 | 5 |
| **4B planned:** the composer slot only | **36** | 4 |
| 4B with voice settings in Settings → Voice (decision 2) | 37 | 3 |
| 4B worst: both speech fallbacks, decision 2's and decision 5's alternatives (+2) | 40 | 0 |
| Phase 5 named: `ChatInput.tsx`, `MainLayout.tsx`, `useUIStore.ts`, `ContextSidebarTab.tsx` | +4 → 40 (from 36) | 0 |
| Phase 5 with both named savings (sidebar side without `useUIStore.ts`, timeline as an extension) | +2 → 38 (from 36) | 2 |
| Phase 3 and 4A owner items, if taken: org-connector listing (R128), I3 redaction, Settings search | +1 each | |
| R155 narrowing of the engine child environment | 0 if it lives in `lifecycle.js` (already counted), else +1 | |

**Plainly:** 4B as planned ends at 36. With it, the whole re-fork fits 40 in every phase 5 case (38–40), as long as no optional item is taken. Each 4B alternative or fallback the owner or the spike takes costs one of the phase 5 savings. Anything past 40 is an owner decision before phase 5: raise the cap, or accept reduced variants.

## Owner decisions this plan needs

1. **Budget.** 4B adds 1 counted file as planned (`ComposerFooter.tsx`, 36 of 40). Approve that, and that a Task 1 S1 or S2 failure may add its named speech fallback (+1 each) only after you see the proof.
2. **Where the MittrCraft voice settings live.** Default: Settings → Integrations, after MittrCraft tools, through the existing slot (0 files). Alternative: 1.22's place in Settings → Voice, through a new slot in `VoiceSettings.tsx` (+1).
3. **What Settings → Voice shows when Mittr is chosen.** With the zero-touch route, upstream's Voice page shows "OpenAI-compatible", the loopback address `http://127.0.0.1:<port>/mittr-speech/v1` and model `mittr`, not "Mittr (set on the platform)". Our MittrCraft voice section carries the Mittr switches and 1.22's note. Accept, or take decision 2's alternative and also hook the provider picker.
   - First-run default, as 1.22 did: Mittr for voice input and read-aloud when nothing was chosen and no local model is installed, and a 1.22 Mittr dictation choice carried once.
4. **The speech key.** Upstream's dictation and read-aloud send the key stored in `voice-keys.json`. So, while Mittr is chosen, a per-run MittrCraft speech key sits there (mode 600) for that kind, replacing a key the person stored for another speech server. It opens only Mittr speech, only from this Mac, and changes every run. Alternative: no key, loopback only, so any program on this Mac could spend the person's speech quota.
5. **Dictation on a used-up quota.** As planned, the microphone is disabled with "Voice input is out of quota until <time>" and comes back by itself. A dictation that fails mid-way shows upstream's error with its Retry button, and a Retry fails at once with the same text. If Task 1 S4 finds the shortcut ignores the disabled button, a blocked shortcut starts a dictation that fails the same way. Accept, or +1 to +2 (`ComposerDictation.tsx`, `stream-manager.js`) for 1.22's exact behaviour.
6. **Hosted web and tunnels.** Talk is offered only on this Mac (R148 local scope): not on hosted web, not over a tunnel, not from another device. Mittr voice input and read-aloud are not offered on hosted web either, because every hosted user would use the hosted server's one Mittr account (as F40, I3). Accept, or allow Mittr speech on hosted.
7. **Two new UI dependencies,** as 1.22 shipped them: `@ricky0123/vad-web` 0.0.31 (ISC) and `onnxruntime-web` 1.30.0 (MIT), with the Silero VAD model (MIT). They install from the local bun cache. If bun needs the npm registry for any package, that download needs your yes.
8. **What voice can do.** Exactly 1.22's action set. 2.1.1's newer `session.link`, `file.open`, memory and notify actions are not offered to voice. Accept, or offer them (the platform's guard lists would need a look).
9. **No waiting by voice.** 2.1.1 gives agents `returnResult` instead of `wait`. Voice has no calling session, so it gets neither, and it never blocks on a session. Answers are read back with "what did it answer?" (`session.read_reply`). Confirm.
10. **A turn must be speech the server heard.** Every voice turn carries a one-time receipt from the server's own transcription (120 s). So a spoken yes, and not a crafted request, is the only way to allow Chrome for a conversation. This is stricter than 1.22, where typed text never reached the voice loop either. Confirm.
11. **One conversation per Mac.** Pressing Talk in a second window ends the first conversation, its Chrome allow included. Confirm.
12. **Removing a site in Settings during a conversation** ends that conversation's Chrome allow, so voice asks again. Confirm.
13. **Voice Chrome is always visible** (1.22's `510964a11`), whatever the "Show the Chrome window" switch says. Agents keep following the switch. Confirm.
14. **Part B** with your real microphone, the dev platform's speech and voice, and your real Chrome profile: one yes per numbered step. You answer macOS's microphone prompt and decide whether to revoke it afterwards. P4-V2/P4-V9 on dev need you to set account Q's speech quota low, or they stay NOT RUN.
15. **Carried and still open:** R155 (engine shell children see the engine password), I3 (hosted), I5, gate builds sharing the Dev 1.x bundle id (phase 3 item 23), and the 4A Part B steps themselves.
