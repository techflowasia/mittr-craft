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
- `answered-by.js` — which answers came from a backup model.
  - `readAnsweredBy(value)` reads the platform's top-level
    `answered_by: { substituted: true, requestedLabel, answeredLabel, answeredKey, reason, notice, caveats? }`
    from a chat completion body or its JSON text and returns
    `{ requestedLabel, answeredLabel, reason }`, or `null` when nothing was
    substituted, a label is empty or `reason` is not `quota`, `failed` or `silent`.
  - `createAnsweredByWatcher(onAnsweredBy)` reads a forwarded stream until the
    first `data:` line that parses to an object with `choices` and stops there.
    It only reads; the bytes the engine receives are unchanged.
  - `createAnsweredByLog()` keeps, in memory, the last 10 substitutions of the
    last 100 sessions. A restart forgets them.
- `service.js` / `routes.js` — `GET /api/mittr/quota/me` and
  `GET /api/mittr/answered-by`.

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
- `503 not_configured` — this install has no broker (the app leaves Mittr
  out of Settings → Usage); `502 unreachable` — the request did not reach the platform;
  `504 upstream_timeout`.
- `502 upstream_failed` — any other failure or an unreadable body. A failed
  read is never answered as an empty week.

## Chat: telling the person a backup model answered

When the model a person chose is out of weekly quota (or failed, or said
nothing), the platform answers with a backup model and adds a top-level
`answered_by` to the first stream chunk or to the non-stream body. The engine
ignores unknown top-level fields, so the app cannot read it from engine
messages; the shim remembers it instead.

The engine sends `X-Session-Id` (and `x-session-affinity`) with the session id
on every request to a provider whose id does not start with `opencode`, which
includes `mittr`. The shim keys each substitution by that id and stores
`{ at, model, reason, requestedLabel, answeredLabel }`, where `at` is when the
shim received the request and `model` is the alias the engine asked for. A
request without a session header is not recorded.

`GET /api/mittr/answered-by?sessionId=` answers `{ now, answers }`: `now` is
the server's clock, the same host clock the engine stamps message times with.
`400` when `sessionId` is missing. Registered by `../mittr/index.js`, so an
install without the shim answers `404`.

The app ties an answer to the assistant message with the same `modelID` whose
`time.created <= at <= time.completed`: the engine creates the assistant
message before it sends the request and completes it after the stream ends.


`packages/ui/src/lib/mittr-quota/quota-me-store.ts` is the one reader of this
route in the renderer: callers that open together share one request, and an
answer is reused for 30 seconds unless the person reloads. It feeds:

- Settings → Usage, where Mittr is the first entry and the one the page opens
  on (`components/sections/usage/MittrUsagePage.tsx`). Lines are grouped by
  kind, used lines first; each says what is left of the limit, what was used,
  and which agents use it.
- The chat model picker, which reads `agentStatus` when it opens and marks each
  Mittr agent: `out` is not selectable, `substitute` names the backup model,
  `near` shows the share left, `ok` shows nothing.

`packages/ui/src/lib/mittr-quota/answered-by-store.ts` reads
`/api/mittr/answered-by` when a Mittr assistant message has completed, once
per session for messages that complete together, and not again while the
last answer's `now` is at or after that message's `time.completed`. A failed
read keeps what was known. `components/chat/message/AnsweredByNotice.tsx`
shows a muted line under the substituted message.
