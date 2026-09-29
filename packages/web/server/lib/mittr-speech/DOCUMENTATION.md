# Mittr Speech module

Calls the Mittr platform's speech routes with the desktop session that already
gates the app. Used by Mittr dictation (`../dictation`), Mittr read aloud
(`../tts/routes.js`) and the local voice routes (`../voice-speech`).

## Scope

- `client.js` exports `createMittrSpeechClient({ brokerBaseUrl, ensureFreshSession, fetchImpl?, now? })`.
  It returns `null` when this install has no broker or no session source.
- `readiness()` → `{ signedIn, ready: { listen, speak, voice }, silenceMs?, voiceSilenceMs?, reason }`
  from `GET /desktop/speech/readiness`.
- `transcribe(wavBuffer, signal?)` → text, from `POST /desktop/speech/transcribe`
  (multipart field `audio`, `audio/wav`; the caller sends 16 kHz mono PCM16).
- `synthesize(text, signal?)` → `{ body: ReadableStream, contentType }` from
  `POST /desktop/speech/synthesize`, with the upstream content type untouched.
- The platform owns the speech models and their credentials. This install never
  holds a speech key or URL.

## Reasons

`reason` / `reasonCode` is one of:

- `not_signed_in`: no Mittr session, or the platform refused it (401/403).
  Nothing is sent to the platform without a session.
- `not_configured`: the platform answered `{ code: 'not_configured' }`, a
  bare `503` without a code, or `404` (a platform without the speech routes),
  or at least one of listen/speak/voice is not pinned.
- `unreachable`: the request did not reach the platform.
- Any other platform `{ code }` (`upstream_failed`, `upstream_timeout`,
  `audio_too_large`, `bad_request`) is passed through as `reasonCode` with the
  platform's HTTP status as `statusCode`.

Errors thrown by `transcribe`/`synthesize` carry `reasonCode` and `statusCode`.
A caller abort rethrows the abort error unchanged.

## Invariants

- Readiness answered by the platform is kept for 30 s per access token; a new
  token asks again. `unreachable` and `not_signed_in` are never kept.
- `empty_transcript` from the platform is returned as `''`, not an error: a
  silent segment is not a failure.
- Nothing said or synthesized is logged.
