# Mittr Work module

Read-only bridge to the Mittr platform's "my work" feed for the signed-in
person, backing the desktop "My work" panel.

## Scope

- `service.js` owns the outbound call to the Mittr platform and the mapping
  from its response to what the route returns.
- `routes.js` owns the single HTTP route and translating service errors to
  HTTP status codes. It has no session or identity check of its own — see
  below.
- Nothing here persists anything; every request is a live read-through to the
  platform.

## Identity: the existing Mittr session, not a separate connection

There is no separate "connect to Plane/Mittr" step for this feature and no
admin-managed key. `MittrSignInGate` already refuses to show the app at all
until a person signs in to Mittr (every model call needs that session), so
by the time this route can be reached, the same `ensureFreshSession()`
session used for the model catalog and audit routes (see
`../mittr/index.js`) already exists. This module just reuses it: whoever the
access token identifies is whoever's work comes back, because the platform's
`/desktop/work` resolves the caller from the token, not from a query
parameter.

The practical effect: work shows up automatically for anyone whose Plane
workspace-member email matches the platform user their AD/SSO login
resolves to. Nothing needs to be typed in or configured per user.

## Sources: Plane and Jira, merged on the platform side

`GET /desktop/work` on the platform already merges more than one source —
`DesktopWorkController` combines `PlaneMirrorRepository.listWorkForUser` and
`JiraMirrorRepository.listWorkForUser` into one list, sorted by recency,
before this route ever sees it. This module has no idea Jira exists and
needs no change when a new source is added on that side; it only ever sees
the same generic `{id, title, project, phase, state, priority, due, url,
updatedAt}` shape, regardless of where an item actually came from.

## Route

`GET /api/mittr/work`

- No query parameters, no body, and no gate of its own on who can call it.
  Earlier this checked `uiAuthController.getSessionEmail` (a *separate* local
  login layer for the MittrCraft server itself — password/passkey/AD to the
  desktop app), which was both wrong and redundant: it only recognises
  AD/Entra-based local logins, so anyone using password or passkey login (or
  an install with no local login layer at all) got a permanent false 401
  despite being fully signed in and using the rest of the app. The real
  identity was never that email anyway — it's the Mittr session's access
  token. Removed; `mittrWorkService.listWork()` already covers "nobody is
  signed in to Mittr" via `configured: false`.
- 200 `{ items: [...], configured: true }` on a successful platform read.
- 200 `{ items: [], configured: false }` when the Mittr broker isn't
  reachable (`brokerBaseUrl` unset, e.g. a LAN-bound install where the shim
  failed to start) or nobody has completed the Mittr sign-in yet, so the UI
  can say "not connected" instead of showing an error.
- 401/403 `{ error: string }` when the platform rejects the access token.
- 500 `{ error: string }` for an unexpected failure, or when the platform is
  down (mapped from a 5xx response).

## Platform contract

```
GET {brokerBaseUrl}/desktop/work
Header: Authorization: Bearer <Mittr desktop session access token>

200 -> { "items": [ { "id": string, "title": string, "project": string, "phase": string|null, "state": string, "priority": string|null, "due": string|null, "estimate": string|null, "url": string, "updatedAt": string, "source": "plane"|"jira", "key": string|null } ] }
401/403 -> { "error": string }
5xx -> treated as unavailable
```

`key` is the card number people use to talk about an item: the Jira issue
key (`MRKB-2122`) or Plane's `<project identifier>-<sequence id>`
(`MITRAI-12`), and `null` when the platform does not know it. The route
passes it through untouched. A platform older than `key` omits the field; the
My work list then falls back to the key in a Jira browse URL and shows
nothing for Plane.

`brokerBaseUrl` and `ensureFreshSession` are the same values `startMittrShim`
(`../mittr/index.js`) already produces and hands to the catalog and audit
routes; `index.js` threads them into `registerMittrWorkRoutes` the same way.
This route is built ahead of the platform lane that serves it, so
`service.js` is exercised in tests with a fake `fetchImpl` rather than a real
endpoint.

## Timeouts

Each platform request is bound to a 10 second `AbortController` timeout; a
timeout is surfaced as a 504-mapped error, not a hang.

## Tests

```
cd packages/web && npx vitest run lib/mittr-work
```

`service.test.js` covers the configured/unconfigured split, the 200 mapping,
401/403 handling, 5xx handling, and the request timeout, all against a fake
`fetchImpl`. `routes.test.js` covers the happy path, the not-connected case,
and service failures, using the same fake-dependency/handler-capture style as
`../scheduled-tasks/service.test.js`.
