# Mittr broker wire contract

Recorded 2026-09-07 from the committed source of the desktop surface in
`techflowasia/mittr`, handed over by the session that implemented it. This is the
contract the MittrCraft plans are written against; where a plan disagrees with
this document, this document is right.

## Sign-in — `/auth/desktop/*`

```
GET  /auth/desktop/start?code_challenge=<b64url(sha256(verifier))>&redirect_uri=<exact allowlisted uri>
     public · 302 into the existing Microsoft flow
     400 desktop_redirect_not_allowed · 400 desktop_challenge_required

GET  /auth/desktop/callback?state=<opaque>
     not public — needs the session cookie Microsoft just set
     302 to <redirect_uri>?code=<code> · 400 desktop_state_invalid

POST /auth/desktop/exchange   { code, code_verifier, redirect_uri }
     public · 201 { accessToken, refreshToken, expiresAt, subject: { userId, displayName } }
     401 desktop_code_invalid | desktop_code_expired

POST /auth/desktop/refresh    { refresh_token }
     public · 201 same shape · 401 desktop_refresh_invalid
```

- `redirect_uri` is matched exactly, never by prefix. Default
  `mittrcraft://auth/callback`, overridable with `DESKTOP_REDIRECT_URIS`.
- A code is spent on first presentation whether or not it succeeds, and expires
  after 10 minutes. A wrong verifier burns it: restart sign-in, never retry.
- Refresh rotates both tokens and kills the old refresh token immediately.
  Concurrent refreshes race and one loses, so the client must serialise them.
- `expiresAt` is epoch milliseconds for the access token. Access lasts an hour,
  refresh thirty days.

## Authenticated surface

Every route below takes `Authorization: Bearer <accessToken>`.

```
POST /v1/chat/completions     OpenAI-shaped, streaming supported
     403 desktop_entitlement_required · 403 agent_not_granted
     404 model_not_found · 400 messages is required

GET  /desktop/catalog
     200 { bundleVersion, issuedAt, subject: { userId, displayName },
            models: [{ alias, label }], mcp?, skills?, knowledge? }
     403 desktop_entitlement_required

POST /desktop/audit           201 { accepted: true }, always
GET  /desktop/updates/*path   200 file
     latest*.yml | *.yaml  →  Cache-Control: no-store
     anything else         →  Cache-Control: public, max-age=31536000, immutable
     400 update_artifact_path_invalid · 404 update_artifact_not_found
```

The caching split matters to the updater. A manifest is a mutable pointer and must
never be cached; an installer is that build forever, and marking it `no-store`
leaves an interrupted download with nothing to resume against — every retry pulls
the whole file again. Range requests are honoured either way.

Three things the client has to get right:

1. `mcp`, `skills` and `knowledge` are **absent or an array, never null**. Test
   with `'mcp' in catalog`, not truthiness: `[]` is falsy, and reading it as
   "unset" silently restores defaults an admin deliberately cleared.
2. `models` carries aliases only. There is no backend model id in the response.
3. `/desktop/audit` answers 201 even when the write fails, by design (§9). It is
   never confirmation that the record landed, and it is never retried.

## Failures the client must tell apart

`POST /v1/chat/completions` can refuse for two unrelated reasons, and they need
different words in the UI.

| Code | What is true | What the person should be told |
| --- | --- | --- |
| `desktop_entitlement_required` | **this person** is not allowed this model | ask an admin for access |
| `agent_not_granted` | no active platform key grants this model | the cached catalog is stale — re-sync |

`agent_not_granted` is a state the client can fix by itself: catalog `models` are
derived from the same platform key grants this check reads, so being refused means
the local catalog has drifted from the platform. Offer a re-sync, not an admin.

**Do not word the entitlement failure as "not in your catalog".** The catalog gate
is entitled-to-*any*, so somebody can hold a catalog listing models A and B while
being entitled only to A. Picking B returns `desktop_entitlement_required` even
though B is legitimately in their catalog, and that wording would be wrong exactly
when it fires.

Entitlement is checked before platform grants on purpose, so a person with no
entitlement cannot probe which models the platform key carries. When both fail
they see `desktop_entitlement_required`.

## Audit payload

Anything not on this list is dropped silently:

```
startedAt, endedAt   epoch ms
repository           git remote, not a local path
model, outcome       strings
turns, tokens        numbers
actions              [{ tool, count }]     an `args` key on an entry is dropped
prompts              [{ at, text }]        text capped at 4000 characters each
```

`userId` and `displayName` in the body are ignored; identity is stamped from the
verified session. At most 100 actions and 200 prompts.

## Mittr-side environment

```
DESKTOP_REDIRECT_URIS=mittrcraft://auth/callback
DESKTOP_PLATFORM_KEY_NAME=mittrcraft
DESKTOP_UPDATES_DIR=/var/lib/mittr/desktop-updates
```

## Admin routes

`GET|POST /api/keys/platform` needs `external.manage_installation_policy`.
`PUT|DELETE /desktop/catalog/:collection` for `mcp|skills|knowledge`, PUT body
`{ items: [...] }` — `PUT { items: [] }` and `DELETE` are deliberately different
operations, per point 1 above. `GET /desktop/audit` needs `audit.view`.
