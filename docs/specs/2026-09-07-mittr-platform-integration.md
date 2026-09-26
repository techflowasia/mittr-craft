# MittrCraft ↔ Mittr platform integration

Status: design approved; broker implemented in `techflowasia/mittr` on `feat/desktop-surface`
Date: 2026-09-07 (broker section updated 2026-09-07 after implementation)

## 1. Context

MittrCraft is a fork of an open-source coding agent, rebranded for internal use.
Today it is a bring-your-own-key tool: a developer opens Settings, pastes a
vendor API key, and talks to whichever provider they paid for. Skills, MCP
connectors and agents are whatever that developer put on their own machine.

Mittr already runs the pieces this product should stand on. Workspace issues
governed keys and holds the Azure AD registration. A LiteLLM gateway fronts the
team's own models, and each one this product can reach is offered under an
opaque alias — for example `agent-17okpqe`, or a short readable one such as
`assistant` (illustrative only, not guaranteed to be real values). The alias
names the agent granted, not the backend model behind it, and its shape is not
this product's business: read it from the catalog and echo it back, never
construct or parse it. Studio consumes that platform without owning any of it.

*(Corrected 2026-09-09: this paragraph originally named a single hand-written
alias, `mittr-craft-1-0`, as if it were a fixed registry name reserved for this
product. The platform team corrected that — an alias is opaque, per model, and
read from the catalog, never a name written down anywhere.)*

*(Corrected again 2026-09-10: the 2026-09-09 correction above said the alias
was the literal prefix `pm_` followed by a hash of the provider and model. That
was also wrong. A grant names the agent, not a (provider, model) pair — several
agents can sit on the same backend model with different instructions, RAG and
skills, and keying grants by provider+model collapsed them into one agent. The
alias is the agent key, has no fixed prefix or shape, and has now changed twice
in two days. That history is the reason nothing in this product may depend on
its format — see `docs/plans/2026-09-09-mittr-side-ready.md`.)*

This design makes MittrCraft a consumer of the same platform: identity, models,
and the organisation's shared tooling all come from Mittr, while the repository,
file edits and terminal stay on the developer's machine.

## 2. Goals

- Only people Mittr recognises can use the product.
- Models come from Mittr's catalog. A developer cannot add their own.
- The organisation can hand out skills, MCP connectors and knowledge sources.
- Admins can see who used the product, on which repository, and what they asked.
- The product ships as a packaged desktop application that updates itself.

## 3. Non-goals

- Running the agent loop on Mittr's servers. Tool calls read files, run tests and
  edit code, so the loop stays on the developer's machine.
- Offline operation. The only credential is a Mittr session; without the platform
  there is nothing to talk to.
- Forensic-grade auditing. See §8 for what the audit trail can and cannot prove.

## 4. Fixed constraints

These came out of the design discussion and are not open for re-litigation
during implementation.

1. **Packaged builds only.** Developers get a signed installer. There is no
   `.env` to edit and no source checkout, so every setting either ships inside
   the build or is fetched at runtime.
2. **The platform key never leaves Mittr.** It does not expire, and no copy of it
   exists on any developer machine.
3. **No Azure AD changes.** The desktop application never contacts Microsoft
   directly, so no new app registration, no new redirect URI, and no new admin
   consent round.
4. **The engine is forked, and the fork stays thin.** *(revised 2026-09-08 by the
   owner; this entry previously read "the engine is not patched" and was written
   as though that were a wall. It was not — the upstream project is MIT and we
   may modify it. It was an engineering trade the owner has since weighed
   differently, and stating a preference as a constraint hid the choice.)*

   The engine is built from source at a pinned tag with a patch set confined to
   string literals and one helper: the nine prompt files that tell the model what
   it is, and the project directory it reads. Neither has an environment
   override. See `engine/README.md`.

   The thinness is the constraint that still binds. Upstream ships roughly every
   1.4 days; behaviour added to the fork is paid for at every upgrade, so work
   that belongs to MittrCraft belongs in `packages/`.

   This does not change how the credential is handled. The engine still stores a
   static API key with no concept of rotation, and the shim in §6.1 still exists
   for that reason — patching credential handling would be behaviour, which is
   what this entry rules out.

## 5. Architecture

```
developer machine                        │  Mittr
                                         │
  engine                                 │
    │  static loopback token             │
    ▼                                    │
  MittrCraft server                      │
    ├─ /v1 shim (127.0.0.1 only) ────────┼──▶ broker ──▶ LiteLLM gateway
    ├─ session manager                   │      │
    └─ catalog materializer              │      ├─ verifies the session
                                         │      ├─ checks entitlement
  repository, files, terminal            │      ├─ resolves the platform policy
    stay here                            │      ├─ writes the audit record
                                         │      └─ serves the catalog
```

The shim exists because of constraint 4. The engine wants a key that never
changes; a Mittr session does change. Putting a local proxy between them lets the
engine hold a machine-local token forever while the session rotates behind it.

## 6. Components

### 6.1 Local provider shim — `packages/web/server`

Exposes an OpenAI-compatible endpoint on loopback. The engine is configured to
treat it as a custom provider through the existing `PUT /api/provider` route and
`lib/opencode/auth.js`, which already writes `auth.json` with mode `0600`.

- Binds `127.0.0.1` only. A configuration that would bind any other interface
  must fail at startup, not bind quietly.
- Streams straight through. No buffering of a completion before forwarding it.
- The loopback token is generated per installation. It authorises the engine to
  reach its own server and nothing else; it carries no authority at Mittr.

### 6.2 Session manager

Sign-in runs through Mittr, never through Microsoft directly:

```
desktop → system browser → Mittr → Microsoft → Mittr → mittrcraft://auth/callback
```

The desktop already registers a deep-link scheme (`app.setAsDefaultProtocolClient`
in `packages/electron/main.mjs`). Microsoft's redirect target stays the Mittr URL
that is registered today, which is what keeps constraint 3 true.

- The code delivered to `mittrcraft://` is single-use and bound to a verifier the
  desktop generated, so another application that claims the scheme cannot redeem
  it.
- Mittr's return target must be an allowlist. `entra-auth.js` already validates
  return targets; extend that allowlist rather than accepting a free-form value,
  or the login endpoint becomes an open redirect.
- The session is stored in the OS keychain, refreshed silently, and only prompts
  when refresh fails. A refresh prompt must not discard the work in progress.

### 6.3 Catalog materializer

The engine already has a layered configuration model: `readConfigLayers()`
returns user, project and custom layers, and `getJsonEntrySource()` reports which
layer an entry came from. Organisation content becomes another layer rather than
a parallel mechanism.

| Content | Written through |
| --- | --- |
| Skills | skill routes |
| MCP servers | `lib/opencode/mcp.js` |
| Agents | `lib/opencode/agents.js` |
| Models | custom provider pointing at the shim |

The directory holding organisation *definitions* is owned by MittrCraft and
rewritten whole on every sync. Merging file by file leaves orphans behind when an
admin removes something.

### 6.4 Broker — lives in the `mittr` repository

New service. Authenticates the caller by session, checks the MittrCraft
entitlement, resolves the platform key's policy server-side, forwards to LiteLLM,
records the audit entry, and serves the catalog and the update manifest.

**Correction found during implementation.** "Attaches the platform key" was the
original wording and it does not describe the platform. The credential that goes
upstream to LiteLLM is Mittr's own gateway credential
(`providers.authHeaders(providerKey)`), which is configured per provider and has
always been server-side. The platform key is a *Mittr* key — the kind a client
presents **to** Mittr — and its job here is to carry the policy naming which
agents MittrCraft may use. It is never forwarded onward. The invariant this
sentence was protecting is unchanged and enforced: the desktop never holds or
names a credential, and nothing credential-shaped appears in a response.

It must derive identity from the session it verified itself. A user identifier
sent by the client is ignored.

### 6.5 Platform key — workspace

A new key class. Today's governed keys are personal, non-shareable and expire in
30 days, with activity attributed to their owner. A platform key is none of those
things: it is not tied to a person, it does not expire, and attribution comes from
the broker instead.

- Rotation stays possible. The gateway must accept two active platform keys at
  once so a rotation never takes every developer offline mid-task.
- Because the key is not personal, removing one person's access happens at the
  entitlement layer, not by revoking the key.

## 7. Catalog and local control

Mittr decides **what is available**. The developer decides **what is switched on**.

- `sync` refreshes availability only. It never touches a developer's on/off state.
- A developer who disables an organisation connector has disabled it. It does not
  come back on the next sync.
- Organisation items and personal items are listed separately, with organisation
  items labelled. Neither shadows the other, so no silent override rule is needed.

| | Admin | Developer |
| --- | --- | --- |
| Models | defines what is available | picks one; **cannot add** |
| MCP / skills | adds to the catalog | enables, disables, adds their own |
| Knowledge | manages the content | chooses whether to use it |

Models are the single exception to local freedom. Allowing a developer to add a
model is bring-your-own-key by another name, which is what this work removes.

The catalog carries model aliases only. Each alias is opaque — for example
`agent-17okpqe`, or `assistant` (illustrative; a real alias cannot be derived
from this text) — and the client must read it from the catalog and send it
back verbatim as `model`. It must never construct, guess or hardcode one, and
must never assume anything about its shape. The backend model behind an alias
is Mittr's business, so it can be swapped without touching any machine.

Two catalog entries with the same label or the same backend model are still
two different aliases, and the client must not deduplicate them. Several
agents can run on the same backend model while carrying different
instructions, RAG and skills, so collapsing entries that merely look alike
would hide a real, distinct grant.

*(Corrected 2026-09-09: this paragraph previously showed `mittr-craft-1-0` as
if it were a readable name a developer would see and could write down. Aliases
carry no meaning a human assigned.)*

*(Corrected again 2026-09-10: the 2026-09-09 correction said an alias was the
literal prefix `pm_` followed by a hash of the provider and model — a fixed
shape derived from a (provider, model) pair. That is also wrong: the alias is
the agent key a grant names, not a hash of provider and model, and it has no
guaranteed prefix. The alias has now been redefined twice, which is exactly
why its shape must never be relied on — read it, echo it, and treat it as
opaque. See `docs/plans/2026-09-09-mittr-side-ready.md`.)*

**An absent field and an empty list are different states.** A missing field means
the admin never configured that category and application defaults apply. `[]`
means the admin deliberately published nothing, and the UI says so. Conflating the
two has already caused an outage on Studio.

## 8. Audit

Written by the broker, never by the client. The developer's machine is the thing
being recorded; it cannot also be the recorder.

One record per session, not per request. An agent task issues dozens of model
calls, and a per-request log is too long to read.

```
who        Chaiwat Tanupan
when       2026-09-07 14:02 – 14:41
where      techflowasia/mittr-craft (branch feat/mittr-rebrand)
model      agent-17okpqe   (opaque alias, illustrative)
volume     41 turns · 260k tokens
actions    edit ×23 · bash ×11 · read ×88
prompts    14:02  "ช่วยดู test ที่ fail ใน pr-status หน่อย"
           14:19  "อันนี้พังมาก่อนหรือเปล่า"
           14:33  "ok commit ให้เลย"
outcome    completed
```

- `actions` records tool names and counts, never arguments. An admin can see that
  someone edited 23 files without reading what they wrote.
- `prompts` records what the person typed, in full. The desktop sends it as its
  own field; the broker must not try to recover it from the request payload,
  because the assembled payload has file contents interleaved into it.
- `where` is the git remote, not the local path. A folder name can itself be
  confidential, for example a client's name.
- Retention is 90 days, then automatic deletion.
- Visible to admins only.

**Never recorded:** assembled prompts, model responses, file contents, tool
arguments, shell commands, terminal output.

### Two limits to state plainly

**People paste code into chat.** Recording what a person typed means a pasted
stack trace or config block reaches Mittr. Truncation does not fix this, because
anything sensitive is usually at the start. The mitigation is disclosure, not
technology: the application tells developers that their instructions are recorded
and visible to admins. Someone who knows will not paste a production secret;
someone who finds out later has a legitimate grievance.

**`who` is verified, `where` is claimed.** The broker proves identity because it
verified the session. It cannot know which repository is open unless the desktop
tells it, and a determined person could lie. This audit trail is for
understanding usage, not for proving misconduct.

## 9. Behaviour when things break

The rule for this whole section: **fail loudly**. Every expensive incident in this
team's history was something that failed silently — a gateway returning 201 with
an empty body while the UI showed a 0-byte result, a tool parser mismatch emitting
raw markup as content, an exhausted credit balance returning 402 that never
surfaced.

| Failure | What the developer sees |
| --- | --- |
| Not signed in | Sign-in gate before the application |
| Session expired mid-task | Re-authenticate; the conversation is preserved |
| Broker or network down | Explicit "cannot reach Mittr" with a retry |
| Entitlement revoked | Cut at the end of the current turn, not mid-sentence |
| Platform key rotated | Nothing; two keys are valid during rotation |
| Audit write fails | Nothing; the request proceeds (see below) |

**Audit failures do not block work.** This trail exists to understand usage, not
to gate access, and the broker still sees the traffic even when the write fails.

Three cases need deliberate handling because they have burned this team before:

1. **The gateway answers 200 while the model is dead.** `/v1/models` and
   `/health/liveliness` respond from configuration without touching the backend.
   Health checks must issue a real chat completion with `max_tokens: 1`.
2. **Tool calling fails silently.** A parser mismatch yields empty `tool_calls`
   and raw markup in `content`, with no error. For a chat product that looks odd;
   for a coding agent it is total failure. Detect the shape and say "this model
   cannot call tools through the gateway".
3. **Gateway response caching interferes with the agent loop.** The gateway caches
   on `(model, messages)`, so a retry with identical input returns the previous
   answer instead of reconsidering. Caching must be disabled for this product's
   traffic; a coding agent gains nothing from it and can loop because of it.

## 10. Update distribution

The application already contains the full `electron-updater` stack:
`updater-check.mjs`, `updater-channel.mjs`, `updater-capability.mjs`, manifest
verification and an end-to-end fixture. Only the source of updates is missing.

The current publish configuration points at a repository that does not exist and
must be changed regardless.

**Updates are hosted by Mittr and fetched with the session** the application
already holds, using a generic provider with authenticated requests. Only someone
who can sign in to Mittr can download a build. A public repository would leak the
installer; a private one would require a token on every machine, which is the
pattern this design removes elsewhere.

**Code signing and notarisation are prerequisites, not polish.** An unsigned macOS
build downloads updates and then fails to install them, retrying forever. Without
a company certificate the update path does not work at all.

## 11. Security invariants

Each of these is enforced by a test that fails the build.

1. The shim refuses to bind anything but loopback.
2. The broker ignores client-supplied identity and uses the verified session.
3. The audit payload matches an allowlist of fields. A new field carrying content
   fails the test. This one guards against a future contributor adding `prompt`
   "to make debugging easier".
4. The deep-link callback code is single-use and bound to the desktop's verifier.

Invariant 3 matters most, because it is the only one whose violation nobody would
notice until it was too late.

## 12. Testing

**Before anything is built:** read a model alias from the real catalog and call
it through the real gateway with a prompt that forces a tool call, and confirm
real `tool_calls` come back. If this fails, this design changes rather than
proceeds.

*(Corrected 2026-09-09: this step originally named a literal alias,
`mittr-craft-1-0`, to call directly. Aliases are opaque ids read from the
catalog at run time, not a fixed name to hardcode into a test. See
`docs/plans/2026-09-09-mittr-side-ready.md`, which also carries the
2026-09-10 correction to what the alias identifies.)*

- **Unit:** catalog merging, organisation and personal items staying distinct,
  local switches surviving a sync, absent-versus-empty handling, audit record
  assembly.
- **Integration against a fake broker:** streaming passthrough, session expiry
  mid-stream, entitlement rejection, broker outage messaging.
- **Against the real platform:** open a real repository, give a real instruction,
  and confirm files actually changed. A 200 response is not the result. Thai
  prompts are part of this from the first run, not a later pass: the current
  primary model is known to mix other scripts into Thai output.

Streaming responsiveness, whether the agent is looping, and whether a developer
who is not the author understands that they must sign in cannot be covered by
tests and must be checked by using the product.

## 13. Dependencies outside this repository

| Owner | Needed |
| --- | --- |
| `mittr` repo | The broker |
| Workspace | Non-expiring platform key class; MittrCraft entitlement per account |
| Gateway / infra | Caching disabled for this traffic; two-key rotation window; token pricing in `config.yaml` so usage figures stop reporting zero |
| IT | Code signing certificate and notarisation credentials |

## 14. Open questions

1. ~~Where exactly Mittr hosts update artifacts, and who owns that storage.~~
   **Answered (owner, 2026-09-07):** a directory the Mittr API owns and serves,
   gated by the desktop session, with the root configurable
   (`DESKTOP_UPDATES_DIR`) so it can move to object storage behind a signed URL
   later without a code change. §10 stands as written.
2. ~~Whether the entitlement is per-person or derived from an existing group.~~
   **Answered (owner, 2026-09-07): per-person**, via the eligibility decision
   Mittr already has. There are two checks, at two different moments, and the
   desktop's path uses only the first:

   - **Request time**, on every desktop call —
     `requireAllowed(userId, 'provider_model', <pm id derived from the grant>)`.
     The third argument is **not** the alias: it is an id computed from the
     providerKey and upstream model that the grant pinned when it was issued.
     The alias is used only to find that grant, and a request whose alias no
     active platform policy grants is refused before eligibility is consulted
     at all.
   - **Issuance time**, when an admin opens or saves the assignment panel —
     `requireAllowed(actor, 'agent', agentKey)` **and**
     `requireAllowed(actor, 'provider_model', <pm id>)`. This is where the
     agent-grained check lives.

   Nothing in the desktop depends on either. It sends the alias and names no
   entitlement kind on the wire, which is why two regrains on the platform side
   have cost this repository no code.

   *(Corrected 2026-09-09: this line previously called that source a "studio
   registry." There is no Studio registry anywhere in this product's path.
   Studio is a separate product, and an earlier design that made what
   MittrCraft can run depend on a Studio configuration row was rejected for
   exactly that reason.)*

   *(Corrected again 2026-09-10, twice in one day. The 2026-09-09 pass wrote
   `requireAllowed(userId, 'provider_model', alias)`. A later pass changed the
   kind to `agent`, reasoning from the platform's regrain — a grant names the
   agent — that the desktop's check must have followed. That reasoning was
   marked as inferred rather than verified, and it was wrong: the kind on the
   desktop path is `provider_model` after all. The agent-grained check is real
   but belongs to issuance, not to requests.*

   *The third argument was wrong in **both** earlier versions, which each called
   it the alias. It is the pinned provider-and-model id. That error survived a
   correction because the correction only questioned the kind.)*
   Admin-decided,
   default-deny, checked live on every request, so revoking one person takes
   effect immediately without touching the key every developer shares. No new
   mechanism was added.
3. What an admin sees when a developer has disabled an organisation connector —
   whether that is visible at all, and whether it should be. **Still open.**

4. ~~**Whether Mittr Memory applies to desktop traffic.**~~ **Answered (owner,
   2026-09-07), and the premise was partly wrong.** The finding recorded here —
   that `memory.autoExtract` runs after every turn and that key holders are told
   a key "always uses Memory" — is true, but only for **governed keys**, where a
   grant is attached to the request. `memoryOwnerId()` returns `null` when there
   is neither a grant nor an API key, so **Memory is already off for
   session-authenticated traffic**, which is what a desktop session is.

   The real hazard was the opposite of the one described: resolving the platform
   key by attaching a governed grant would have switched Memory **on** and
   extracted developers' tool output and file contents into the platform key
   owner's store. The implementation therefore attaches no grant, and §8 needs no
   change. Nothing about how any existing key behaves was altered, so this never
   required a decision from whoever owns Memory.
