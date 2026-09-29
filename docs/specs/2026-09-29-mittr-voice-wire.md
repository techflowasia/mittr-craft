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

`bad_request` also covers a tool name outside the three allowed names. A `session.stop` requested by the model after the person's last `user` message when the same turn already holds a read (`session.read_reply`, `session.messages`, `chrome.read`, `chrome.snapshot`, `browser.snapshot`, `jira.get_issue`, `plane.get_issue`) is not forwarded as a tool call; the platform streams a short refusal as text instead.

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

Body `{ said: string; history: { role: 'user' | 'assistant'; text: string }[]; locale: 'th' | 'en'; directory?: string; sessionId?: string; queuedPrompts?: number }` (`queuedPrompts`: integer 0–1000, the renderer's queued prompt count for the open session; omitted means unknown).

Events: the platform events above, plus

- `{ "type": "action", "kind": "running", "label": string }` before each tool runs (label is human-readable, no arguments)
- `{ "type": "tool-result", "id": string, "ok": boolean }` after it
- `{ "type": "queue", "sessionId": string, "directory": string, "text": string }` when the assistant sent a prompt to a busy session: nothing was dispatched; the renderer that owns the turn adds it with `useMessageQueueStore.getState().addToQueue(createMessageQueueTarget(sessionId, directory), { content: text, sendConfig })` (sendConfig captured at queue time like the composer), and `useQueuedMessageAutoSend` sends it when the session goes idle. It travels on the turn stream, not the shared event stream, so several windows never queue it twice.

`{ "type": "error", "code": "not_signed_in" }` when there is no Mittr session.

## Spoken narration language

MittrCraft ships no Thai UI locale. Narration the app speaks on its own (session finished, permission waiting, error) uses the language of the person's last utterance (Thai script → `th`, otherwise `en`), from strings held in the voice-assistant module. Labels on screen use the UI locale through `voice.i18n.ts`.

## Settings

`voiceStepCap` (integer 1–20, default 8) and `voiceReplyMaxChars` (integer 1000–30000, default 8000), persisted with the desktop settings; `sttProvider` accepts `'mittr'`.
