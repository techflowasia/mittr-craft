# The Mittr side is ready — what MittrCraft can build against

Written 2026-09-09, after mittr `v0.15.0`. Everything below is on `main` in
`techflowasia/mittr` and was walked on a running stack, not inferred from the code.

Read this before `2026-09-07-mittr-broker-handoff.md`: two things in that plan and in
the integration spec were wrong, and one of them changes the wire.

## What changed since the handoff plan

**1. A platform key grants MODELS, not agents.**

The first implementation made a platform key grant agent keys. That was wrong, and it
is the one change that affects the wire. §5 of the integration spec always said the
catalog carries model aliases; the implementation now matches it.

- Grants are `{ modelKey }` — no `agentKey`, no `skillBindingId`. Skill bindings are
  scoped to an agent and do not apply to this product.
- `modelKey` is an opaque `pm_`+hash id, never a vendor id and never a studio registry key —
  there is no Studio configuration anywhere in this product's path. The backend model behind it
  stays Mittr's business and can be swapped without touching a single desktop.
- The entitlement kind is `provider_model`, not `agent`.

**2. Nobody types the platform key anywhere.**

There is no field in MittrCraft for it and there must not be. A desktop presents the
access token it got from the sign-in exchange; the server resolves the platform policy
by name on its own. The credential behind that policy is never handed to a person.

An admin's whole job is an assignment: **workspace → Admin → API Keys → "Models
MittrCraft can use"** — tick models, save. Everyone who signs in is offered exactly
that set, on their next sign-in.

## What the API gives you

**The paths in the handoff plan were wrong — every one of them had an `/api` prefix that does
not exist.** `/api/auth/*` is Better Auth's own handler, mounted as Express middleware ahead of
the application's routes, and it answers 404 for anything it does not recognise. So
`/api/auth/desktop/start` is a 404 on prod today, and so is `/api/desktop/catalog`. Verified
against prod on 2026-09-09:

```
GET https://api.mittr.asia/api/auth/desktop/start   404
GET https://api.mittr.asia/auth/desktop/start       302   <- the real one
GET https://api.mittr.asia/api/desktop/catalog      404
GET https://api.mittr.asia/desktop/catalog          401   <- the real one
```

Base URL is the API host, **`https://api.mittr.asia`** — not the workspace host, which only
proxies `/api/*`.

| | |
|---|---|
| `GET /auth/desktop/start` | begins sign-in; redirect must be in the allowlist |
| `GET /auth/desktop/callback` | |
| `POST /auth/desktop/exchange` | `{code, code_verifier, redirect_uri}` → `{accessToken, refreshToken, expiresAt, subject}` |
| `POST /auth/desktop/refresh` | silent refresh; the refresh token is the credential |
| `GET /desktop/catalog` | what this person is offered |
| `POST/GET /desktop/audit` | |
| `GET /desktop/updates/*` | manifests `no-store`, artifacts `immutable` |
| `POST /v1/chat/completions` | `Authorization: Bearer <accessToken>` |

The catalog's shape is what it always was, and now genuinely carries models:

```json
{ "bundleVersion": 7, "issuedAt": 1757400000000,
  "subject": { "userId": "...", "displayName": "..." },
  "models": [ { "alias": "pm_74468a9c32725d1187cce803b266c0d2", "label": "Code Helper" } ] }
```

**`alias` is an opaque id, not a name you can write down.** It is `pm_` followed by a hash of
the provider and upstream model, so `mittr-craft-1-0` and `mittr-1.0` are not aliases and never
were — that line in §5 of the integration spec and in "what changed" above is wrong. Read the
alias out of this response and echo it back verbatim as `model`; never construct or hardcode one.

`alias` is what you send as `model` on `/v1/chat/completions`. The server resolves it
to the provider and upstream model **the grant pinned when it was issued**, so an admin
rotating the registry later cannot silently move a running desktop onto a different
model. A model the platform has not assigned answers `agent_not_granted`; a person
without the entitlement answers `desktop_entitlement_required`.

## Defaults you do not need to configure

- Redirect URI: `mittrcraft://auth/callback`. Register that scheme, or tell the mittr
  side and `DESKTOP_REDIRECT_URIS` is set to yours.
- The platform key's name: `mittrcraft`. The admin screen fills it from the server.

## Still owned elsewhere

- `DESKTOP_UPDATES_DIR` on the prod API container — devops. Only needed for auto-update.
- macOS code signing — IT.
- **§12 pre-flight: run 2026-09-09. The tool loop and the alias are both closed. One step is
  left, and it is ours.**

  Both gateway models answer a real two-turn tool loop: tool call out, tool result fed back,
  correct final answer, `finish_reason: tool_calls` with a populated `tool_calls` and empty
  `content`. This is not the markup-in-content-with-empty-`tool_calls` parser failure.

  **Alias resolution now runs end to end.** *(This section has been rewritten twice in one day.
  It first claimed the alias was proven, which was wrong; it was then corrected to UNPROVEN;
  it is now proven, on the evidence below. Read the evidence, not the heading.)*

  The full round trip was run on the same commit that is on prod, `v0.15.2`: sign-in →
  exchange → `GET /desktop/catalog` → `POST /v1/chat/completions` with `model` set to the alias
  the catalog returned, then the two-turn tool loop above. The `model` field came back **as the
  alias** in both responses, not the vendor id, so the upstream model never reaches our UI.

  Be exact about what that run was: **a local instance of that commit, not prod.** Prod's
  `DESKTOP_REDIRECT_URIS` is the packaged `mittrcraft://auth/callback` scheme alone, so only the
  desktop application itself can finish sign-in there. That is the correct boundary and the
  reason it cannot be driven from a browser or a probe script.

  **So the last unproven step is ours: the first real desktop sign-in against prod, followed by a
  real call using the alias that `GET /desktop/catalog` hands back.** On prod the assignment is
  done and the grant is stored, pinned to `qwen3.8-27b`. If it fails, report it rather than
  working around it.

  Still not covered:
  - **The gateway's tool-call parser setting was not inspected.** The symptom being absent is
    not the same as knowing the parser is configured correctly, so it is not known whether it
    can come back.
  - A reply came back with `<|channel>thought` / `<channel|>` markup inside `content` on
    `gemma-4-26b`. `qwen3.8-27b` is clean. Harmless to the tool loop, but a client that renders
    `content` verbatim will show it — the two models make a ready-made pair for testing a
    stripper.

## One label bug, fixed on the Mittr side

Found while proving the alias: the assignment panel and the desktop catalog chose different
agent names for the same model, so an admin could tick one name and the desktop would offer
that model under another. One rule now decides the name for both. Fixed on branch
`fix/one-name-per-model`, not yet in a release.

Nothing on the wire changes — `label` simply stops disagreeing with what the admin picked. We
render `label` as given and never derive anything from it, so no change is needed here.

## One caveat worth knowing

`external-api-key-runtime.service.ts` still reads `grant.agentKey` on the generic
Bearer-token path, so presenting a platform key as an API key is refused rather than
authorised. That is deliberate — nothing presents it that way, and fail-closed is the
right side to be wrong on — but it means "use the platform key as a bearer token" is not
a path that exists.
