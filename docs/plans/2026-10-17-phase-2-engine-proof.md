# Phase 2: what OpenCode 2.0.22 does with our provider, policy, plugin and refusal

Date: 2026-10-17. Script: `scripts/mittr/probe-engine-v2.mjs`. The probe's output from the run below is next to this note, in `2026-10-17-phase-2-engine-proof.json`. Every scenario and both controls passed. No stop condition was hit, and the probe exited 0.

P7, the lock against a user's or a project's own config, was added later and recorded by its own run (`--only P7`). Its verdict is in the same JSON under `scenarios.P7`, and that run's metadata and egress record are under `p7Run`. See [P7](#p7-the-lock-against-user-and-project-config).

Every claim marked *read from the binary* comes from reading the 2.0.22 executable. The probe does not record those claims. Everything else is in the JSON.

## What was run

`node scripts/mittr/probe-engine-v2.mjs --json $TMPDIR/probe.json`. The run took 91 s, most of it the four 20 s refusal and retry windows.

- **Engine.** `packages/electron/resources/opencode-cli/opencode`, as staged by `prepare:opencode-cli`. It reports `opencode v2.0.22`.
- **Isolation.**
  - A fresh temp `HOME` under `$TMPDIR`, with `TMPDIR`, all four `XDG_*` bases and `OPENCODE_CONFIG` inside it. No inherited shell env.
  - `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`.
  - A random free port (never 57123 or 57133) and a random `OPENCODE_SERVER_PASSWORD`.
  - The engine runs in its own process group. The probe signals the whole group on every exit path: a failed start, normal completion, `SIGINT`/`SIGTERM`/`SIGHUP`, or an uncaught error. It then deletes the temp `HOME`. No engine of this worktree and no temp `HOME` was left after the run.
- **Egress recording.**
  - `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (and their lowercase forms) point at a loopback proxy inside the probe. `NO_PROXY` lists the loopback addresses only.
  - The proxy records every request and `CONNECT`. It forwards loopback targets and answers 403 to everything else, so nothing it sees leaves the machine.
  - The engine's pid is sampled with `lsof -a -p <engine pids> -i` every 250 ms, from the moment it is spawned.
  - The engine log runs at `--log-level debug`.
- **Providers.** Two loopback stubs that speak the OpenAI API, `stub` and `other`, each on its own `127.0.0.1:<random>` port. Each stub records every request's headers and body.
  - A third provider, `canary`, points at `https://egress-canary.invalid/v1`. It is used once, as the proxy control.
  - No real provider, endpoint or key was used.
- **Managed config** (`OPENCODE_CONFIG`). It sets `providers.{stub,other,canary}`, each with `package: "aisdk:@ai-sdk/openai-compatible"`, `settings.baseURL` and models `{m1: {modelID, name, capabilities: {tools: true}}}`. It also sets `plugins: [<hook recorder>, <identity plugin>, <retry hook>]` and `experimental.policies: [{provider.use, *, deny}, {provider.use, stub, allow}]`.
- **Plugins.** All are directory plugins (`package.json` with `type: module` and `exports: ./index.js`):
  - `identity` is the shipped source: since Task 14 the probe imports `identityPluginSource()` from `packages/mittr-opencode/src/identity-plugin.js`. It rewrites the 2.0.22 harness sentence (R50) and the two older opening sentences, and adds the identity line. A re-run with it on 2026-10-17 passed every scenario, P3 included: `context` fired once, the harness sentence was gone, `You are MittrCraft, an AI coding agent.` and the identity line were sent, and the 10 remaining OpenCode mentions were all built-in tool and skill text.
  - `retry hook` is probe-only and hooks nothing unless the P2/P2b fallback writes it with a provider. It used to be part of the inline identity copy.
  - `hook recorder` is probe-only. It appends each `context`/`generate`/`compaction` call, and the first 120 characters of `system[0]` it saw, to a file in the temp `HOME`.
- **Sessions** are driven through `@opencode/client` 2.0.22, with `x-opencode-directory` set to a work dir in the temp `HOME`. Each stub request is matched to its session by `x-opencode-session-id`.

## Results

| | Verdict | What the engine did |
|---|---|---|
| P1 headers | PASS | The provider request carried `x-opencode-session-id` and `x-session-id`, both equal to the session id. So did `x-session-affinity` and `x-opencode-session`. |
| P2 refusal | PASS | 1 stub request in 20 s. Idle 4 ms after the 402. No `retry` status. The assistant `error` has `type: provider.quota`, `status: 402`, and `response.body` holding our JSON with `llm_quota_exhausted`. |
| P2b mid-stream refusal | PASS | 1 stub request in 20 s. Idle 5 ms after the frame. No `retry` status. Same `provider.quota` error and body, but `status: 200`, the HTTP status of the stream. |
| P2c header only | PASS | A 429 with a plain rate-limit body and `x-should-retry: false`: 1 request, idle 4 ms after, no retry (`provider.rate-limit`, 429). The header alone stops a retry the engine would otherwise make. |
| P2 control | PASS | The same 429 without the header: 4 requests at 0, 2.0, 6.7 and 15.2 s, with `session.retry.scheduled` attempts 2 to 5. So the probe does see retries when they happen, and the single requests above are real. The probe then interrupts the session. |
| P3 identity | PASS | Details below. |
| P4 policy | PASS | Lock on, a session on `other/m1` fails with `provider.no-route` ("Model unavailable: other/m1"). The `other` stub saw 0 requests, and `stub/m1` answered. After a restart with `policies: []`, both answered. |
| P5 hot reload | PASS | Model `m2` added: `GET /api/model` listed `stub/m2` 287 ms after the write, with no restart. Policies set to `[]`: the `other` prompt answered 1.74 s after the write, on the 2nd try (the first still got `no-route`). |
| P6 credential | PASS | `POST /api/integration/stub/connect/key {key:'k-123'}` succeeded. The keyed turn answered, and its request carried `authorization: Bearer k-123`. After an engine restart on the same XDG bases, the turn answered and the request still carried it. |
| P7 user and project config | PASS | Lock on, a user `OPENCODE_CONFIG` file, the user's `OPENCODE_CONFIG_CONTENT` and a project `opencode.json` each allowed `*`, `other` and `opencode` by name. In each case `other/m1` failed with `provider.no-route` with 0 requests to its stub, and `stub/m1` answered. `opencode/big-pickle` was refused with no egress. With the switch ON, `other` answered and `opencode` stayed refused. This holds only with the managed file as the `OPENCODE_CONFIG` layer; details below. |
| Proxy control | PASS | The one `canary` prompt reached the proxy as `CONNECT egress-canary.invalid:443`, and was refused (the turn ends `provider.auth`, 403). So the engine's outbound HTTPS goes through `HTTPS_PROXY`, and the proxy record covers it. |

### P3 in detail
- **Hook firing.** `context` fired once for the turn; `generate` and `compaction` fired 0 times. The recorder saw `system[0]` open with the original sentence: "You are an AI agent running in OpenCode, a coding agent harness."
- **Canary rewrite.** The stub received `You are MittrCraft, an AI coding agent.` in place of that sentence, and the original sentence was gone. A directory plugin can rewrite the harness opening line in place through `ctx.session.hook('context', …)`, so R50 is achievable in Task 14 without the shim fallback.
- **Identity line.** It was present. Neither "You are opencode" nor "You are OpenCode" was sent.
- **Remaining mentions.** The system message (one message, `content` a string) names OpenCode 11 times, or 10 without our identity line ("Never call yourself OpenCode"). Those 10 are all built-in tool and skill text, which R50 keeps:
  - the `opencode` tool namespace ("Tools for managing OpenCode itself");
  - the built-in `OpenCode` skill;
  - the built-in skill for reporting an opencode issue.
- **Other variants.** The binary also carries "You are opencode, an interactive CLI tool…" and "You are OpenCode, a coding agent…" (*read from the binary*). This run used an openai-compatible model and got neither. Which models get those was not traced. The identity copy keeps both rewrites.

### P7: the lock against user and project config

**How the engine resolves policies** (*read from the binary*, then confirmed by the diagnostics below):
- OpenCode 2.0.22 loads its config documents in this order: well-known (org) config, then the global `opencode.json`, then `OPENCODE_CONFIG`, then `opencode.json` in the project directories, then `.opencode/`, then `OPENCODE_CONFIG_CONTENT`. For ordinary keys, later documents win.
- For `experimental.policies` it reverses that order. It lists the policies of `OPENCODE_CONFIG_CONTENT` first and well-known last, then appends any organization statements. A provider is allowed or denied by the **last** matching rule (`findLast`).
- So, for policies: inside one list, a later rule wins. Across documents, the global file beats `OPENCODE_CONFIG`, which beats project config, which beats `OPENCODE_CONFIG_CONTENT`.

**What that broke.** Task 3 first followed R45 as written: when the user set `OPENCODE_CONFIG`, our provider, plugin and policies were merged into `OPENCODE_CONFIG_CONTENT`. That is the weakest place for a policy. In the first P7 run, a user `OPENCODE_CONFIG` file that allowed every provider undid the lock: `other/m1` answered, and the `opencode/big-pickle` turn tried `CONNECT opencode.ai:443`, which the probe's proxy refused. A project `opencode.json` would beat `OPENCODE_CONFIG_CONTENT` the same way (*read from the binary*; not run as its own case).

**The fix** (`hook(managed-config)`). When a server plugin contributes config, the managed file stays the `OPENCODE_CONFIG` layer even when the user set `OPENCODE_CONFIG`. The user's own file, then their `OPENCODE_CONFIG_CONTENT`, move into `OPENCODE_CONFIG_CONTENT`. Our policies then outrank the project config and every user layer except the global file. Without a contribution, upstream behaviour is unchanged.

| Run | Allows placed in | Switch | `other/m1` | `stub/m1` | `opencode/big-pickle` |
|---|---|---|---|---|---|
| lockedContent | user `OPENCODE_CONFIG_CONTENT` | OFF | refused, 0 requests | answered | refused, no egress |
| lockedFile | user `OPENCODE_CONFIG` file | OFF | refused, 0 requests | answered | refused, no egress |
| lockedRepo | project `<work>/opencode.json` | OFF | refused, 0 requests | answered | refused, no egress |
| openRepo | project `<work>/opencode.json` | ON | answered | answered | refused, no egress |
| open | user `OPENCODE_CONFIG_CONTENT` | ON | answered | answered | refused, no egress |

The two ON runs show that each layer holding the allows really loads. With the switch ON, the user file's provider (folded into `OPENCODE_CONFIG_CONTENT`) and the project's provider both answered. So the OFF refusals come from the lock, not from a missing provider. With the switch ON, our only policy is `deny opencode` (R52), and it still beat the user's `allow opencode`.

Diagnostics (recorded under `engineObeys`, not part of the verdict):

| Diagnostic | Result |
|---|---|
| One list: the user's allows, then `[deny *, allow stub]` | `other` refused: a later rule wins |
| One list: `[deny *, allow stub]`, then the user's allows | `other` answered |
| The lock only in `OPENCODE_CONFIG_CONTENT`, the allows in the user's `OPENCODE_CONFIG` file (the original R45 design) | `other` answered: the user file wins |
| The lock in the managed `OPENCODE_CONFIG`, the allows in the global `opencode.json` | `other` answered: **the global file wins** |

**Open gap.** A global `opencode.json` that allows other providers still undoes the lock, and so would well-known (org) config. In MittrCraft the global file is `$OPENCODE_CONFIG_DIR/opencode.json`, inside the app's own engine config folder, which upstream's settings UI also writes. The UI writes no `experimental.policies`, so only a hand edit can do this today. This needs a ruling: either keep the lock there too (mittr-server rewriting it through `context.opencode.userConfig`), or accept it as the user's own machine.

The P7 run made no non-loopback attempt. The proxy saw nothing, `lsof` took 90 samples, and the log names no outside host. Its only loopback peer that is not ours was the local Ollama (R51).

### Details later tasks build on
- **Task 9.** `sessionIdOf` reads `x-opencode-session-id`, with `x-session-id` as the fallback. Both equal the session id.
  - The engine also sends `user-agent: opencode/latest/2.0.22/cli`, `x-opencode-client: cli`, `x-opencode-project: <project hash>`, `traceparent` and `b3`.
  - Sub-agent turns add `x-opencode-parent-session-id` and `x-parent-session-id` (*read from the binary*, not exercised).
- **Tasks 18 and 22.**
  - No retry hook is needed, and a refused turn costs exactly one call.
  - Recognise a refusal by `error.type === 'provider.quota'` plus `llm_quota_exhausted` in `error.response.body`, never by `status === 402`, because a mid-stream refusal reports 200.
  - The events on refusal are `session.step.failed` and then `session.execution.failed`, both carrying that error.
  - *Read from the binary:* the classifier reads `x-should-retry` first, and maps the `insufficient_quota` error type to `QuotaExceeded`, which it never retries.
- **Tasks 10 and 13, policy placement.** The lock belongs in the managed `OPENCODE_CONFIG` file and nowhere else (P7). Inside that list, `[deny *, allow mittr]` keeps our allow last, and nothing may be appended after it. The R52 rule `deny opencode` holds with the switch ON as well.
- **Task 13.** The lock also hides the denied providers' models: lock on, `GET /api/model` lists only `stub/m1`. A locked session can still be created; its first turn fails with `provider.no-route`, and no request reaches the denied provider.
- **Tasks 10 and 13.** No `context.opencode.refresh(reason)` is needed after a managed-config write. Providers apply in about 0.3 s and policies within 2 s. The engine also reloads every configured plugin on each write ("loading plugin" in the log).
  - For comparison, a full restart took 1.36 s from the stop signal until the probe was connected to the new engine. That includes a fixed 0.5 s pause the probe takes after connecting. The new engine itself was ready 260 ms after spawn.
- **Task 10, credential.** The credential API works and persists. It is stored in the engine database (`<XDG_DATA_HOME>/opencode/opencode.db`). `GET /api/credential` lists it as `{id: 'cred_…', integrationID: 'stub'}`, and a configured provider shows as an integration whose only method is `key`. The `{env:MITTRCRAFT_SHIM_TOKEN}` fallback is not needed.
- Without a key, the stub received no `authorization` header.
- **Tasks 11 and 12.** `GET /api/model`, read about 0.5 s after readiness, returned `[]` once, and the full list 119 ms later. The engine fills a location lazily, so an empty list at startup is not authoritative.

## Outbound connections

With `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`, the engine made no attempt to reach a non-loopback host, apart from the deliberate canary:

- **Proxy.** It recorded 1 attempt in the whole run: the canary `CONNECT`. The proxy control shows the engine's HTTPS goes through it, so a short-lived outbound HTTPS connection would have been recorded too.
- **`lsof`.** 299 samples, 250 ms apart from spawn to stop, covered the engine and its one child. They showed no non-loopback peer.
- **Log.** The debug log names no non-loopback host other than the canary.

What this does not cover: traffic that ignores the proxy variables, such as a raw socket or a DNS lookup made directly, is visible only to the `lsof` samples. Those can miss a connection that opens and closes between two samples.

One loopback peer that is not ours: 6 connections to `127.0.0.1:11434`, the owner's running Ollama, 3 of them while the lock was on. The engine auto-discovers a local Ollama, and lists its models (`ollama/gemma4:12b`, `ollama/qwen3.5:9b`) when the lock is off. R51 accepts this as loopback-only, and notes it for the owner.

## Owner question (C12)

Shall `engineEnv()` set `OPENCODE_DISABLE_MODELS_FETCH=1` while the provider switch is OFF?

- A Mittr-only picker needs no public model catalog (R30/R39).
- The phase-1 gate saw the engine fetch `models.dev` without this switch.
- With it, this probe saw no outbound attempt, and the Mittr provider, policies, plugin and credential all worked.

Related: with `policies: []`, the model list includes the built-in `opencode/*` free models, which OpenCode's hosted service serves, and the integrations offer `opencode` ("OpenCode Console": `key`, `env`, `oauth`). R52 keeps that provider denied even with the switch ON.
