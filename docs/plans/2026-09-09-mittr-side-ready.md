# The Mittr side is ready — what MittrCraft can build against

Written 2026-09-09, after mittr `v0.15.0`. Everything below is on `main` in
`techflowasia/mittr` and was walked on a running stack, not inferred from the code.

Read this before `2026-09-07-mittr-broker-handoff.md`: two things in that plan and in
the integration spec were wrong, and one of them changes the wire.

**Updated 2026-09-10:** the alias contract described below turned out to be wrong a
second time, one day after it was written. See "The alias contract, corrected again
(2026-09-10)" below for the current truth and "Develop environment, verified
2026-09-10" for what was checked against `api-dev.mittr.asia` since. The rest of this
file is left as originally written, corrections marked inline, so the sequence of what
was believed and when stays readable.

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

*(Corrected 2026-09-10: this whole point turned out to be wrong. A grant does not name a
(provider, model) pair — it names the agent. Several agents can sit on the same backend
model while carrying different instructions, RAG and skills, so keying grants by
provider+model collapsed distinct agents into one. Grants are `{ agentKey }` again, the
entitlement kind is `agent`, and the `modelKey`/`pm_`+hash shape described above never
existed on the wire the way this section claimed. This is the second time the alias
contract has been corrected in as many days — see the section below for what that means
for how the client is allowed to treat it.)*

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
  "models": [ { "alias": "agent-17okpqe", "label": "Code Helper" } ] }
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

*(Corrected 2026-09-10: "it is `pm_` followed by a hash of the provider and upstream
model" is wrong. `alias` is the agent key of the agent the grant names — `assistant`,
or a generated one such as `agent-17okpqe` — not a hash of provider and model, and it
carries no fixed prefix. See "The alias contract, corrected again (2026-09-10)" below
for the full correction and the rule it leaves behind.)*

## The alias contract, corrected again (2026-09-10)

The platform team corrected the alias contract twice now, one day apart:

- 2026-09-09 said an alias was a readable registry name like `mittr-craft-1-0`. Wrong.
- 2026-09-09 (later the same day) said an alias was `pm_` followed by a hash of the
  provider and model, e.g. `pm_9f2c1d4e7b`. Also wrong.
- 2026-09-10: a grant names the **agent**, not a (provider, model) pair. Several agents
  can sit on the same backend model while carrying different instructions, RAG and
  skills — keying grants by provider+model collapsed them into one. The alias is the
  agent key: real examples are `assistant`, or a generated one such as `agent-17okpqe`.
  There is no `pm_` prefix.

The rule this leaves behind is the point, not the specific shape: **the alias is opaque
and its shape is not the client's business.** It has changed twice in two days; nothing
in MittrCraft may depend on its format. Concretely:

- Read it from `GET /desktop/catalog` and echo it back verbatim as `model` on
  `/v1/chat/completions`. Never construct, guess, hardcode, or pattern-match one.
- Never assume a prefix, a length, a character set, or that it encodes provider/model
  information — the last two beliefs about its shape were both wrong.
- Never deduplicate catalog entries. Two entries can legitimately point at the same
  backend model and still be genuinely different agents with different instructions,
  RAG or skills; collapsing them by label or by backend model would silently drop a
  real grant.

## Develop environment, verified 2026-09-10

The develop environment is up and carries the desktop work: **`https://api-dev.mittr.asia`**,
no `/api` prefix, same as prod. Verified:

```
GET  https://api-dev.mittr.asia/                                    200
GET  https://api-dev.mittr.asia/auth/desktop/start?...               302
GET  https://api-dev.mittr.asia/desktop/catalog                      401
```

Develop is at commit `f6c3ce36`, deployed by Jenkins job "non-prd mittr" build #241.

The redirect allowlist is genuinely enforced there, not just on prod:

```
redirect_uri=mittrcraft://auth/callback        -> 302
redirect_uri=https://evil.example/cb           -> 400  desktop_redirect_not_allowed
```

Two blockers, both outside this repository and neither fixable from here:

**1. Develop returns its own origin as `localhost`.** The `/auth/desktop/start` redirect
lands on:

```
http://localhost:3000/api/auth/sign-in/social?...&callbackURL=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fdesktop%2Fcallback%3Fstate%3D...
```

because `BETTER_AUTH_URL` is unset on the non-prd deployment and better-auth falls back
to its own default. A packaged app that follows that redirect lands on the user's own
machine, and sign-in cannot complete. The fix is deploy-side — set
`BETTER_AUTH_URL=https://api-dev.mittr.asia` and redeploy — and is owned by whoever has
access to that environment's config.

**2. No platform key / model assignment exists on develop yet.** The admin panel says
"No models assigned — no desktop can sign in," and org-level agents are default-denied
in resource eligibility for that environment. This one is self-serve: in the develop
workspace admin screen, under API Keys, allow the agent and the provider/model it uses,
tick it under "Models MittrCraft can use," then Save.

Neither blocker can be worked around from this repository. Sign-in against develop stays
untestable end to end until both are cleared.

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

## What is actually on develop (2026-09-10)

Thirteen agents, and **every one of them resolves to the same backend model,
`llm-dev / gemma-4-26b`** — the four with no explicit setting inherit the
installation default, which is that same pair. This is the case the alias
regrain exists for: one model, many agents, each with its own instructions, RAG
and skills.

| Scope | Agents | Agent-level state |
|---|---|---|
| Org | Senior Analyst, Lead Engineer, QA Engineer, Developer, Product Owner, R & D | denied |
| Org, built-in | General Assistant | **allowed** — the only explicit agent allow in the environment |
| Org, built-in | Code Helper | denied |
| Personal, owned by the workspace admin | นักกฎหมาย, ผู้ช่วยความปลอดภัย, ทนายสัญญาไทย, นักออกแบบสไลด์ | auto-allowed to their owner |
| Personal, owned by someone else | POD Agent | not visible to the admin, not offerable |

So the panel offers five today: General Assistant and the four personal ones.
The other six need one tick each.

**Eligibility is two ticks, not one.** Allowing an agent does not carry its
model and allowing a model does not carry its agents; both rows must be
allowed. The exception is a personal agent, which is auto-allowed at the agent
level to the person who owns it — which is why four personal agents are
offerable in an environment holding exactly one explicit agent allow. On
develop the model tick is already satisfied for everything, so the six org
agents are missing only the agent tick.

### Two consequences worth deciding on rather than discovering

**Four of the five agents offerable today belong to one person.** Assigning any
of them hands every developer who signs in an agent owned by an individual,
along with that person's RAG and skills. That sits badly against the platform
semantics this product is built on — a platform key issued to the platform, not
to a person — and it is a decision for the owner, not something either side
should quietly settle by ticking a box.

**Every agent on develop runs `gemma-4-26b`, which is the model that leaks
`<|channel>thought` / `<channel|>` into `content`.** `qwen3.8-27b`, which the
prod grant is pinned to, is clean. So a build pointed at develop will show that
markup to whoever uses it, on essentially every reply, and the detector in
`packages/web/server/lib/mittr/response-markup.js` will report it on every
call. The detector reports and never edits, by design. Whether the desktop
should strip this markup before rendering is a product decision that has not
been taken; it is worth taking before the team sees it rather than after.

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
