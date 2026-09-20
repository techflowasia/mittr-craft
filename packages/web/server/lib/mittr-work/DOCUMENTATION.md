# Mittr Work module

Read-only bridge to the Mittr platform's "my work" feed for the signed-in
person, backing the desktop "My work" panel.

## Scope

- `service.js` owns the outbound call to the Mittr platform and the mapping
  from its response to what the route returns.
- `routes.js` owns the single HTTP route, resolving the signed-in email
  server-side and translating service errors to HTTP status codes.
- Nothing here persists anything; every request is a live read-through to the
  platform.

## Route

`GET /api/mittr/work`

- No query parameters. The email is never taken from the client; it is
  resolved from the signed-in session via `uiAuthController.getSessionEmail`.
- 200 `{ items: [...], configured: true }` on a successful platform read.
- 200 `{ items: [], configured: false }` when `MITTR_PLATFORM_BASE_URL` or
  `MITTR_PLATFORM_SERVICE_KEY` is not set, so the UI can say the platform is
  not connected instead of showing an error.
- 401 `{ error: string }` when the request has no signed-in session.
- 401/403 `{ error: string }` when the platform rejects the service key or
  the request.
- 500 `{ error: string }` for an unexpected failure, or when the platform is
  down (mapped from a 5xx response).

## Platform contract

```
GET {MITTR_PLATFORM_BASE_URL}/desktop/work?email=<urlencoded email>
Header: Authorization: Bearer {MITTR_PLATFORM_SERVICE_KEY}

200 -> { "items": [ { "id": string, "title": string, "project": string, "phase": string|null, "state": string, "priority": string|null, "due": string|null, "estimate": string|null, "url": string, "updatedAt": string } ] }
401/403 -> { "error": string }
5xx -> treated as unavailable
```

This route is built ahead of the platform lane that serves it, so
`service.js` is exercised in tests with a fake `fetchImpl` rather than a real
endpoint.

## Environment variables

- `MITTR_PLATFORM_BASE_URL`: base URL of the Mittr platform. Trailing
  slashes are stripped before the path is appended.
- `MITTR_PLATFORM_SERVICE_KEY`: bearer token sent as `Authorization: Bearer
  <key>`. Never logged.

Both must be set for `createMittrWorkService(...).configured` to be `true`.

## Timeouts

Each platform request is bound to a 10 second `AbortController` timeout; a
timeout is surfaced as a 504-mapped error, not a hang.

## Tests

```
cd packages/web && npx vitest run lib/mittr-work
```

`service.test.js` covers the configured/unconfigured split, the 200 mapping,
401/403 handling, 5xx handling, and the request timeout, all against a fake
`fetchImpl`. `routes.test.js` covers the route with a signed-in session, no
session, and service failures, using the same fake-dependency/handler-capture
style as `../scheduled-tasks/service.test.js`.
