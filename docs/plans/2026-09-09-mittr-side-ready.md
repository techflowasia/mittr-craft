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
- `modelKey` is a **studio registry key** (`mittr-craft-1-0`, `mittr-1.0`), never a
  vendor id. The backend model behind it stays Mittr's business and can be swapped
  without touching a single desktop.
- The entitlement kind is `provider_model`, not `agent`.

**2. Nobody types the platform key anywhere.**

There is no field in MittrCraft for it and there must not be. A desktop presents the
access token it got from the sign-in exchange; the server resolves the platform policy
by name on its own. The credential behind that policy is never handed to a person.

An admin's whole job is an assignment: **workspace → Admin → API Keys → "Models
MittrCraft can use"** — tick models, save. Everyone who signs in is offered exactly
that set, on their next sign-in.

## What the API gives you

Unchanged from the handoff plan (all live):

| | |
|---|---|
| `GET /api/auth/desktop/start` | begins sign-in; redirect must be in the allowlist |
| `GET /api/auth/desktop/callback` | |
| `POST /api/auth/desktop/exchange` | `{code, code_verifier, redirect_uri}` → session |
| `POST /api/auth/desktop/refresh` | silent refresh; the refresh token is the credential |
| `GET /api/desktop/catalog` | what this person is offered |
| `POST/GET /api/desktop/audit` | |
| `GET /api/desktop/updates/*` | manifests `no-store`, artifacts `immutable` |

The catalog's shape is what it always was, and now genuinely carries models:

```json
{ "bundleVersion": 7, "issuedAt": 1757400000000,
  "subject": { "userId": "...", "displayName": "..." },
  "models": [ { "alias": "mittr-craft-1-0", "label": "MittrCraft 1.0" } ] }
```

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
- **§12 pre-flight: run 2026-09-09, passed — with two gaps that are still open.**
  Two calls to `gemma-4-26b` through the real gateway (different cities, different
  languages, to defeat the `(model, messages)` cache) both returned
  `finish_reason: tool_calls` with a populated `tool_calls` and empty `content`. A
  two-turn loop also worked: tool call out, tool result fed back, correct final answer.
  This is not the markup-in-content-with-empty-`tool_calls` parser failure.

  What it does NOT cover, and nobody should read as covered:
  - **The alias was never exercised.** The calls named `gemma-4-26b` directly, not
    `mittr-1.0` and not `mittr-craft-1-0`, so alias resolution is unproven.
  - **The gateway's tool-call parser setting was not inspected.** The symptom being
    absent is not the same as knowing the parser is configured correctly, so it is not
    known whether it can come back.
  - A second-turn reply came back with `<|channel>thought` / `<channel|>` markup inside
    `content`. Harmless to the tool loop, but a client that renders `content` verbatim
    will show it.

## One caveat worth knowing

`external-api-key-runtime.service.ts` still reads `grant.agentKey` on the generic
Bearer-token path, so presenting a platform key as an API key is refused rather than
authorised. That is deliberate — nothing presents it that way, and fail-closed is the
right side to be wrong on — but it means "use the platform key as a bearer token" is not
a path that exists.
