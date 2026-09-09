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
against prod on 2026-09-09.

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
- **§12 pre-flight: run 2026-09-09. The tool-loop gap is closed; the alias gap is not.**

  Both gateway models answer a real two-turn tool loop: tool call out, tool result fed back,
  correct final answer, `finish_reason: tool_calls` with a populated `tool_calls` and empty
  `content`. This is not the markup-in-content-with-empty-`tool_calls` parser failure.

  **Alias resolution end to end is still UNPROVEN.** *(Corrected 2026-09-09, later the same day:
  an earlier version of this section claimed the alias had been exercised end to end. That was
  wrong — read back what was actually run, below, before trusting anything else in this file.)*

  Every pre-flight run so far — the tool-loop runs included — named a vendor model id directly
  in `model`, for example `gemma-4-26b`, never an alias read from `GET /desktop/catalog`. That
  proves the gateway and its tool-call parsing work for those models. It proves nothing about
  the path this product actually uses: catalog → alias → `/v1/chat/completions` → grant
  resolution → pinned provider/model. No run has gone through that path.

  Said plainly, because it matters: sign-in itself has not been driven end to end either. Prod's
  `DESKTOP_REDIRECT_URIS` is the packaged `mittrcraft://auth/callback` scheme alone, so only the
  desktop application itself can complete sign-in there — which is the correct boundary and the
  reason it cannot be driven from a browser or a probe script. On prod the model assignment is
  done and the grant is stored; the first real desktop sign-in, followed by a real
  `/v1/chat/completions` call using the alias that `GET /desktop/catalog` hands back, is the step
  that actually proves this. **The Mittr side will run that test after `v0.15.2` deploys.**

  Still not covered:
  - **The gateway's tool-call parser setting was not inspected.** The symptom being absent is
    not the same as knowing the parser is configured correctly, so it is not known whether it
    can come back.
  - A reply came back with `<|channel>thought` / `<channel|>` markup inside `content` on
    `gemma-4-26b`. `qwen3.8-27b` is clean. Harmless to the tool loop, but a client that renders
    `content` verbatim will show it — the two models make a ready-made pair for testing a
    stripper.

## One caveat worth knowing

`external-api-key-runtime.service.ts` still reads `grant.agentKey` on the generic
Bearer-token path, so presenting a platform key as an API key is refused rather than
authorised. That is deliberate — nothing presents it that way, and fail-closed is the
right side to be wrong on — but it means "use the platform key as a bearer token" is not
a path that exists.
