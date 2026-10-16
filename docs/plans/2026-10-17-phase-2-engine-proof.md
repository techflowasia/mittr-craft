# Phase 2: what OpenCode 2.0.22 does with our provider, policy, plugin and refusal

Date: 2026-10-17. Script: `scripts/mittr/probe-engine-v2.mjs`. Every scenario passed, so no stop condition from the plan was hit.

## What was run

`node scripts/mittr/probe-engine-v2.mjs --json $TMPDIR/probe.json`, run six times with the same verdicts. The numbers below are from the fifth run; the sixth gave the same verdicts and the same outbound record.

- Engine: `packages/electron/resources/opencode-cli/opencode`, as staged by `prepare:opencode-cli`. It reports `opencode v2.0.22`.
- Isolation:
  - a fresh temp `HOME` under `$TMPDIR`, with `TMPDIR`, all four `XDG_*` bases and `OPENCODE_CONFIG` inside it;
  - no inherited shell env;
  - `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`;
  - a random free port (never 57123 or 57133) and a random `OPENCODE_SERVER_PASSWORD`.

  The engine runs in its own process group, which is killed at the end. The temp `HOME` is deleted on exit. No engine of this worktree was left running.
- Providers: two loopback stubs that speak the OpenAI API, `stub` and `other`, each on its own `127.0.0.1:<random>` port. Each stub records every request's headers and body. No real provider, endpoint or key was used.
- Managed config (`OPENCODE_CONFIG`):

  ```json
  {
    "providers": {
      "stub": { "name": "Stub", "package": "aisdk:@ai-sdk/openai-compatible",
                "settings": { "baseURL": "http://127.0.0.1:<stub>/v1" },
                "models": { "m1": { "modelID": "m1", "name": "m1", "capabilities": { "tools": true } } } },
      "other": { "...": "the same, pointing at the other stub" }
    },
    "plugins": ["<home>/engine-plugins/mittrcraft-identity"],
    "experimental": { "policies": [
      { "action": "provider.use", "resource": "*", "effect": "deny" },
      { "action": "provider.use", "resource": "stub", "effect": "allow" } ] }
  }
  ```
- Identity plugin: a directory plugin (`package.json` with `type: module` and `exports: ./index.js`) carrying the probe's inline copy of Task 14's `identityPluginSource()`. Task 14 replaces the copy with an import.
- Sessions are driven through `@opencode/client` 2.0.22 with `x-opencode-directory` set to a work dir in the temp `HOME`.
- The run takes about 50 s, most of it the two 20 s refusal windows.

## Results

| | Verdict | What the engine did |
|---|---|---|
| P1 headers | PASS | Every provider request carries `x-opencode-session-id: <session id>`. `x-session-id`, `x-session-affinity` and `x-opencode-session` carry the same session id. |
| P2 refusal | PASS | 1 stub request in 20 s. Idle 5 ms after the 402. No `retry` status. The assistant message has `error.type = provider.quota`, `error.status = 402`, and `error.response.body` holds our JSON with `llm_quota_exhausted`. |
| P2b mid-stream refusal | PASS | 1 stub request in 20 s. Idle 6 ms after the frame. No `retry` status. Same `provider.quota` error, but `error.status = 200` (the HTTP status of the stream). |
| P3 identity | PASS | The plugin loads, and `ctx.session.hook('context'…)` can rewrite `system`. The stub received `You are MittrCraft…`, and neither `You are opencode` nor `You are OpenCode`. See the concern below: the prompt still names OpenCode elsewhere. |
| P4 policy | PASS | With deny `*` / allow `stub`, a session on `other/m1` fails with `provider.no-route` ("Model unavailable: other/m1"). The `other` stub saw 0 requests, and `stub/m1` answers. After a restart with `policies: []`, both answer. |
| P5 hot reload | PASS | Adding `m2` to the managed file: `GET /api/model` listed `stub/m2` after 259 ms, with no restart. Rewriting policies to `[]`: the `other` prompt answered 1.7 s after the write (the first try right after the write still got `no-route`). |
| P6 credential | PASS | `POST /api/integration/stub/connect/key {key:'k-123'}` succeeded. The next stub request had `authorization: Bearer k-123`. After an engine restart on the same XDG bases, it still did. |

### Details later tasks build on

- **P1, Task 9:** `sessionIdOf` reads `x-opencode-session-id`, as planned, with `x-session-id` as the fallback. Both carried the session id. Sub-agent sessions add `x-opencode-parent-session-id` and `x-parent-session-id` (read from the binary, not exercised). The engine also sends `user-agent: opencode/latest/2.0.22/cli`, `x-opencode-client: cli`, `x-opencode-project: <project hash>`, `traceparent` and `b3`.
- **P2/P2b, Tasks 18 and 22:** no retry hook is needed. The 2.0.22 classifier reads `x-should-retry` first (`"false"` means no retry), and it maps the `insufficient_quota` error type to `QuotaExceeded`, which it never retries. The mid-stream frame takes the same path without any header. A refused turn costs exactly one call. Code that recognises the refusal keys on `error.type === 'provider.quota'` plus `llm_quota_exhausted` in `error.response.body`. It does not key on `status === 402`, because a mid-stream refusal reports 200.
- **P2, the session events seen:** `session.step.failed` and then `session.execution.failed`, both with the `provider.quota` error. The turn ends there, so the session is idle.
- **P3, Task 14:** the hook path works. `ctx.session.hook('context'|'generate'|'compaction', fn)` is offered to directory plugins, and `fn` may mutate `o.system` in place: it can rewrite `o.system[0].text` and push `{type:'text', text}`. The engine joins the system parts into one `system` message whose `content` is a string. No fallback is needed. The plugin is reloaded on every write of the managed file ("loading plugin" in the engine log).
- **P4, Task 13:** the lock does more than refuse the call. With the lock on, `GET /api/model` lists only `stub/m1`. With `policies: []` it lists every configured and discovered model (see the C12 section). A locked session is created, and its first turn then fails with `provider.no-route`. No request reaches the denied provider.
- **P5, Tasks 10 and 13:** no `context.opencode.refresh(reason)` is needed after a managed-config write. Providers apply in about 0.25 s and policies within 2 s. For reference, a full restart took 256 ms to readiness and about 1.6 s of wall time, including stopping the old engine.
- **P6, Task 10:** the credential API works and persists. It is stored in the engine database (`<XDG_DATA_HOME>/opencode/opencode.db`), and `GET /api/credential` lists it as `{id: 'cred_…', integrationID: 'stub'}`. A configured provider shows up as an integration whose only method is `key`. The `{env:MITTRCRAFT_SHIM_TOKEN}` fallback is not needed.
- Without a key, the stub received no `authorization` header at all.
- `GET /api/model` read about 0.5 s after readiness returned an empty list once. It was complete 130 ms later. The engine fills a location lazily, so an empty model list at startup is not authoritative. Task 10's picker must not read it as "no Mittr models".

## Outbound connections

The engine opened no non-loopback connection with `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`:

- 88 `lsof -a -p <engine pids> -i` samples, every 500 ms, covered the engine and its one child. They showed no non-loopback peer.
- The engine log (`--log-level debug`) names no non-loopback host.

`lsof` sampling can miss a connection that opens and closes between two samples. The log check covers that gap only for requests the engine logs.

One loopback peer that is not ours: the engine connected to `127.0.0.1:11434`, 6 connections in all. On this machine that port is the owner's running Ollama. The engine auto-discovers a local Ollama, and it lists that Ollama's models (`ollama/gemma4:12b`, `ollama/qwen3.5:9b`) when the lock is off. This is not third-party egress, but it is a read of a local service. **For the owner:** 3 of the 6 connections opened while the lock was on, so a Mittr-locked app still probes a local Ollama.

## Owner question (C12)

Shall `engineEnv()` set `OPENCODE_DISABLE_MODELS_FETCH=1` while the provider switch is OFF?

- A Mittr-only picker needs no public model catalog (R30/R39).
- The phase-1 gate saw the engine fetch `models.dev` without this switch.
- With it, this probe saw no non-loopback connection, and the Mittr provider, policies, plugin and credential all worked.

Related, for the owner's decision on the switch ON (R37/R40): with `policies: []`, the model list includes the built-in `opencode/*` free models (`opencode/big-pickle`, `opencode/nemotron-3-ultra-free`, and others). Those are served by OpenCode's hosted service. Choosing one sends prompts to a third party. The integration list also offers `opencode` ("OpenCode Console"), with `key`, `env` and `oauth`.

## Concern for Task 14: the prompt still names OpenCode

P3 passes on the criteria the plan set. But for a model on `aisdk:@ai-sdk/openai-compatible`, 2.0.22 does not use either of the two sentences Task 14 rewrites. Its system prompt starts:

> You are an AI agent running in OpenCode, a coding agent harness.

The appended identity sentence was present. The same system message still names OpenCode 12 times:

- that opening line;
- the built-in `opencode` tool namespace ("Tools for managing OpenCode itself");
- the built-in `OpenCode` skill;
- the built-in skill for reporting an opencode issue with the GitHub CLI.

The binary carries all three opening sentences. Which models get which sentence was not traced. So the model is told it is MittrCraft, and it is also told it runs in OpenCode. Whether Task 14 should also rewrite the opening line, or hide the built-in `opencode` tools and skills, is a product call. It is left to the controller and the owner, not decided here.
