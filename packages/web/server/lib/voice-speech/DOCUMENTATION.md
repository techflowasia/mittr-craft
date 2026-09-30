# Voice Speech routes

Local routes the voice assistant renderer uses to check Mittr speech and to
turn one utterance into text. Both use the same local auth as every other
`/api/*` route and delegate to `../mittr-speech/client.js`.

## Routes

- `GET /api/voice/readiness` →
  `{ listen, speak, voice, signedIn, voiceSilenceMs, reason }` where `reason`
  is `'not_signed_in' | 'not_configured' | 'unreachable' | null` and
  `voiceSilenceMs` is `null` when the platform did not give one. An install
  without a Mittr broker answers `unreachable` with everything false.
- `POST /api/voice/transcribe`: multipart field `audio` (WAV, 16 kHz mono) →
  `{ text }`, or `{ error, reasonCode }` with the platform's status
  (`401` for `not_signed_in`, `503` for `unreachable` without a broker, `400`
  `bad_request` when the audio field is missing, `429` `llm_quota_exhausted`
  with `resetsAt` when voice input is out of weekly quota).

## Invariants

- Registered in `server/index.js` after the auth routes and before the
  OpenCode proxy, next to the browser-control routes.
- The upload is read with `express.raw` (25 MB) and parsed with the platform
  `Request.formData()`; no multipart dependency.
- A client that disconnects aborts the platform request.
- Transcripts are returned, never logged.
