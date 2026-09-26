# Mittr Integrations module

Lets a person read and write their own Jira and Plane credentials on the
Mittr platform directly from MittrCraft, using the same desktop session
that already gates the app and authorises the model catalog, audit, and My
work routes.

## Scope

- `service.js` owns the outbound calls to the platform's `/api/integrations`
  endpoints and the bearer-token auth.
- `routes.js` owns the four HTTP routes and translates service errors to
  HTTP status codes.
- Nothing here persists anything locally; every request is a live
  read/write-through to the platform, which is the single source of truth.

## Why this exists

The platform's Integrations page (a separate web admin console) already had
per-user settings for Jira and Plane, reachable only by logging into that
console directly. As Mittr access narrows to fewer people while MittrCraft
stays universal, that assumption breaks: someone using only MittrCraft would
have no way to configure their own Jira or Plane connection.

The fix isn't new infrastructure -- the platform's per-user endpoints
(`GET/PUT /api/integrations`, `POST /api/integrations/{jira,plane}/test`)
already existed and needed no admin capability, only a normal per-user
session. They just weren't reachable by a desktop session token. Adding
`@AllowDesktopSession()` to those four routes on the platform (see
`ai-agent-platform/apps/api/src/actions/integrations.controller.ts`) was
the whole platform-side change; this module is the MittrCraft-side half.

## Routes

- `GET /api/mittr/integrations` -> the platform's config for the signed-in
  person: `{ jira: {baseUrl, email, hasToken, configured}, plane: {baseUrl,
  workspaceSlug, hasApiKey, configured} }`. Secrets are never returned, only
  `hasToken`/`hasApiKey` booleans.
- `PUT /api/mittr/integrations` -> forwards the body (a partial `{jira?,
  plane?}` update) and returns the updated config. Omitting `token`/`apiKey`
  keeps the currently saved secret.
- `POST /api/mittr/integrations/jira/test` -> `{ok, displayName?, email?,
  error?}`.
- `POST /api/mittr/integrations/plane/test` -> `{ok, count?, projects?,
  error?}`.
- 401 when nobody has signed in to Mittr; 503 when the broker isn't
  reachable from this install; whatever the platform itself returns
  otherwise (400 for a bad base URL, etc.), passed through.

## Tests

```
cd packages/web && npx vitest run lib/mittr-integrations
```
