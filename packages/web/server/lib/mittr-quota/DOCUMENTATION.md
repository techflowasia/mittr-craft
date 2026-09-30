# Mittr Quota module

The Mittr platform gives each person a weekly allowance per model (chat
tokens, images, voice-input seconds, spoken-reply characters). The week
restarts every Monday 00:00 Asia/Bangkok. This module is how the local
server recognises a refusal for that reason and how the app reads this
week's usage.

## Files

- `exhausted.js` — the one reader of a quota refusal.
  - `readQuotaExhausted(value)` accepts the flat platform body
    `{ code: 'llm_quota_exhausted', modelKey, kind, label, resetsAt, message }`
    and the chat completions envelope
    `{ error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', message, resets_at, model } }`,
    as an object or a JSON string, and returns `{ kind, resetsAt, message, model }`
    or `null`. A provider `insufficient_quota` without `resets_at` is not
    treated as a Mittr weekly quota.
  - `QUOTA_REFUSAL_STATUS` (`402`), `toEngineRefusal` and
    `createQuotaStreamRewriter` are used by `../mittr/shim-routes.js`.
  - `quotaFieldsOf(error)` adds `resetsAt` to a local error reply when the
    error is a quota refusal.
- `service.js` / `routes.js` — `GET /api/mittr/quota/me`.

## Chat: why the shim rewrites the status

The engine retries a `429` five times with growing waits, because the AI SDK
marks every `429` retryable. A weekly quota does not come back in seconds, so
the shim answers the engine with `402` and
`{ error: { type: 'insufficient_quota', code: 'llm_quota_exhausted', message: 'Weekly model quota used up', kind, resets_at } }`:
the engine stops at once, and the assistant message keeps that body as its
`responseBody`, which the app reads to show the reset time and a Try again
button. An ordinary rate-limit `429` is forwarded unchanged.

The engine also retries a non-retryable error whose message or response body
matches its patterns (`/429|500|502|503|504|524/` among others, in the
engine's `session/retry.ts`). So nothing an admin or the platform wrote — the
model label, the platform's message — reaches the engine: the message is
fixed, and `resets_at` is cut to whole seconds so its only digit runs are the
year and `000`.

When the refusal arrives after the stream started, the platform sends one
`data:` frame holding the envelope, then `[DONE]`. The shim rewrites only that
line: the frame's `error.message` becomes a JSON string of
`{ type: 'error', error: { type: 'insufficient_quota', code: 'insufficient_quota', reason: 'llm_quota_exhausted', kind, resets_at } }`.
The engine parses that string into a non-retryable error that keeps the
reset time; left as plain text it would surface without one. Every other
line passes through unchanged, and only an unfinished trailing line is held
until its newline arrives.

## Route

`GET /api/mittr/quota/me`, behind the same local auth as every `/api` route,
reads `GET {brokerBaseUrl}/api/quota/me` with the desktop session.

- `200` — `{ weekStart, resetsAt, lines: [{ modelKey, kind, label, labelKey?, used, limit, source, agents? }], agentStatus? }`.
  Lines that do not parse are dropped; the week itself must parse. A system
  model has `label: ''` and a `labelKey` (`quota.role.*`, `quota.model.other`,
  `quota.fallback.label`) the app translates. `agents` names the Mittr agents
  a chat model serves. `agentStatus` is keyed by agent key, which is the
  catalog alias of the model the app offers for that agent:
  `{ modelKey, left, limit, resetsAt, state: 'ok' | 'near' | 'substitute' | 'out', percentLeft?, substituteLabel? }`;
  an entry that does not parse is dropped.
- `401 not_signed_in` — no session, or the platform refused it.
- `404 not_available` — the platform has no quota route.
- `503 not_configured` — this install has no broker (the app hides the
  panel); `502 unreachable` — the request did not reach the platform;
  `504 upstream_timeout`.
- `502 upstream_failed` — any other failure or an unreadable body. A failed
  read is never answered as an empty week.
