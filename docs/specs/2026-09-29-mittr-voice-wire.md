# Mittr Voice — Wire Contract

Companion to `2026-09-29-mittr-voice-design.md`. Every lane builds against these shapes exactly. A change here is a foundation change: the integrator makes it and every lane rebases.

## Platform (`ai-agent-platform`), desktop session

All routes are `@AllowDesktopSession()`; the caller is the desktop access token (`Authorization: Bearer <accessToken>`). No subject → `403 { message: 'desktop_session_required' }`.

### `GET /desktop/speech/readiness`

```json
{ "listen": { "ready": true }, "speak": { "ready": true }, "voice": { "ready": true },
  "silenceMs": 1500, "startWaitMs": 6000, "voiceSilenceMs": 900 }
```

### `POST /desktop/speech/transcribe`

Multipart field `audio`: WAV, 16 kHz mono PCM16 (our gateway rejects 24 kHz). Reply `201 { "text": string, "ms": number }`.

### `POST /desktop/speech/synthesize`

Body `{ "text": string }` (1–4000 chars). Reply: audio stream with the upstream `content-type` (Gemini: `audio/pcm;rate=24000;channels=1`), `X-Content-Type-Options: nosniff`.

Speech errors: `{ "code": "not_configured" | "audio_too_large" | "upstream_failed" | "upstream_timeout" | "empty_transcript" | "bad_request" }` with the same HTTP statuses as `/api/speech/*`.

### `POST /desktop/voice/step` (SSE)

Body:

```ts
{
  locale: 'th' | 'en';
  context: string;                 // ≤ 8000 chars, built by the app each turn
  messages: VoiceMessage[];        // ≤ 60 messages, ≤ 200000 chars in total
  tools: VoiceTool[];              // 1–3 tools
}
type VoiceMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: { id: string; name: string; arguments: string }[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
type VoiceTool = {
  name: 'mittrcraft' | 'mittrcraft_web' | 'mittrcraft_voice';
  description: string;            // ≤ 4000 chars
  parameters: object;             // JSON Schema, ≤ 30000 chars serialized
};
```

`arguments` is the JSON string the model produced. Tool calls are never executed by the platform.

Events (`data: <json>\n\n`):

- `{ "type": "text-delta", "text": string }`
- `{ "type": "tool-call", "id": string, "name": string, "arguments": string }`
- `{ "type": "done" }`
- `{ "type": "error", "code": "not_configured" | "upstream_failed" | "upstream_timeout" | "bad_request" }`

`bad_request` (an SSE error event after 200, like Studio) also covers: a tool name outside the three allowed names, duplicate tool names, `messages: []`, more than 20 `toolCalls` in one assistant message, and a `tool` message whose `toolCallId` has no earlier assistant tool call.

Guards (the app applies the same lists locally, so a call refused by either side never runs). The action is the exact top-level `action` field of `arguments`.

- Read actions: `session.read_reply`, `session.messages`, `chrome.read`, `chrome.snapshot`, `chrome.screenshot`, `chrome.do`, `browser.snapshot`, `browser.inspect`, `browser.capture`, `computer.screenshot`, `jira.get_issue`, `plane.get_issue`.
- Refused after any read since the last `user` message, including a read in the same batch: `session.stop`, `session.send`, `session.create`, `session.fork`, `schedule.create`, `schedule.run`, `schedule.delete`, `schedule.toggle`, `chrome.allow_site`. Page interaction after a read stays allowed. `session.list` and `session.status` are lookups in the app's own index, not reads: finding a session by name and then sending to it in one turn is allowed.
- `session.stop` is refused unless an assistant message with non-empty text comes before the last `user` message (the assistant asked first).
- A refused call is dropped, never forwarded; a short spoken refusal is streamed as `text-delta` before any `tool-call` (Thai when the last user message has Thai script, otherwise the request's `locale`).

The context is placed in the instructions between `<<<CONTEXT` and `CONTEXT>>>` as data written by pages, agents and the app, never instructions.

## MittrCraft local server (`packages/web/server`)

Local auth is the same as every other `/api/*` route.

### `GET /api/voice/readiness`

```json
{ "listen": true, "speak": true, "voice": true, "signedIn": true,
  "voiceSilenceMs": 900, "reason": null }
```

`reason` is `'not_signed_in' | 'not_configured' | 'unreachable' | null`.

### `POST /api/voice/transcribe`

Multipart field `audio` (WAV 16 kHz). Reply `{ "text": string }` or `{ "error": string, "reasonCode": string }`.

### `POST /api/tts/speak` with `providerId: 'mittr'`

Existing route. Reply is always browser-decodable: raw PCM from the platform is returned as WAV (`audio/wav`); other audio types pass through.

### `POST /api/voice/turn` (SSE)

Body `{ said: string (1–4000 chars); history: { role: 'user' | 'assistant'; text: string (≤ 20000 chars) }[] (≤ 60); locale: 'th' | 'en'; directory?: string; sessionId?: string; queuedPrompts?: integer 0–1000 }`. Malformed → `400 { "error": "bad_request" }`. Only what the person said is ever a `user` message.

Events: the platform events above, plus

- `{ "type": "action", "kind": "running", "label": string }` before each tool runs (human-readable title, no arguments)
- `{ "type": "tool-result", "id": string, "ok": boolean }` after it (also for refused calls, which never run)
- `{ "type": "queue", "sessionId": string, "directory": string, "text": string }` when `session.send` targets a busy/retry session: nothing is dispatched; the renderer that owns the turn adds `text` with `useMessageQueueStore.getState().addToQueue(createMessageQueueTarget(sessionId, directory), { content: text, sendConfig })` (sendConfig only when it is the viewed session), and the model is told `{ queued: true }`. It travels on the turn stream, never the shared event stream.

`{ "type": "error", "code": "not_signed_in" }` when there is no Mittr session (checked before any call and before every step). `{ "type": "error", "code": "not_configured" }` when every voice tool is switched off.

Tools are rebuilt every turn from build availability and the agent tool switches (`agentControlToolEnabled`, `agentWebToolEnabled`, `agentComputerToolEnabled`, `agentChromeToolEnabled`). At most 20 calls run per step. Tool results the model sees include refusals `{ error, reasonCode }` with `reasonCode` in `unsupported_action | refused_after_read | confirm_first | not_requested | too_many_calls | tool_timeout | status_unavailable`, and `site_approval_required` results carrying `host` and `ask`.

### `POST /api/voice/end`

No body. `204`. Ends the voice conversation: clears the `voice` Chrome session's site grants and the pending site question. The renderer calls it when the conversation ends (End, Escape, unmount).

### Voice-only control action `chrome.allow_site { host }`

In `mittrcraft_voice` only (when Chrome is available and its switch is on). One spoken yes allows Chrome on every site for the `voice` Chrome session until the conversation ends, never persisted. The model asks once, at the first `site_approval_required` result, and passes that result's `host`; the loop runs it only for that host and never after a read in the same turn. Reply `{ allowed: true, scope: 'conversation', sites: 'all' }`.

## Spoken narration language

MittrCraft ships no Thai UI locale. Narration the app speaks on its own (session finished, permission waiting, error) uses the language of the person's last utterance (Thai script → `th`, otherwise `en`; platform refusals fall back to the request `locale`), from strings held in the voice-assistant module. Labels on screen use the UI locale through `voice.i18n.ts`.

## Settings

`voiceStepCap` (integer 1–20, default 8) and `voiceReplyMaxChars` (integer 1000–30000, default 8000), persisted with the desktop settings; `sttProvider` accepts `'mittr'`.
