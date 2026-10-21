# Phase 4A: how OpenCode 2.0.22 runs our plugin tools, their images and their permission prompt

Date: 2026-10-21. Script: `node scripts/mittr/probe-engine-v2.mjs --only agent-tools --json <out>`. Engine: the bundled `packages/electron/resources/opencode-cli/opencode`, which reports `opencode v2.0.22`. The numbers below are from the last full run, which took 52 s and exited 0. The evidence JSON is kept outside the repository and holds no token, password or home path.

The run uses phase 3's set-up: a fresh temporary HOME with all four XDG bases, `TMPDIR` and `OPENCODE_CONFIG_DIR` inside it, the loopback stub provider, the loopback recording proxy, and the `lsof` sampler. The managed config is written by upstream's own `createManagedConfigRuntime`. Its plugin list is `-opencode.browser`, then upstream's agent-tool plugin (materialized by upstream's `createAgentToolRuntime` in the temp data dir, control and web on, Code Mode off), then the probe plugin from `scripts/mittr/probe-tool-plugin.mjs`. The order is the one `managed-config-file.js` writes. Upstream's agent-tool callback runs on a loopback express app, with upstream's control service and a browser broker that reaches no client.

## The short answer

- **A plugin tool sits beside upstream's tools.** `mittr_probe_direct` (`codemode: false`) is a direct tool next to `openchamber` and `openchamber_web`. `mittr_probe_code` (`codemode: true`) is only in the Code Mode catalog. An engine environment variable reaches the plugin.
- **Our transform can wrap upstream's panel tool.** `tools.get('openchamber_web')` and `tools.update('openchamber_web', fn)` replaced its `execute`. The wrapper ran, and the stub got upstream's error envelope with `probe-wrapped` after it. **Task 5 needs no hook in `agent-tool/runtime.js`.**
- **The model sees a tool's image.** A content part `{ type: 'file', uri: 'data:image/png;base64,…', mime, name }` reached the stub as an `image_url` part, both directly and through Code Mode `execute`, with the marker's sha256 unchanged. 1.22's `attachments` field is ignored. A model whose capabilities say `input: ['text']` gets an error line in place of the image. Today's `{ tools: true }` already means text and image, because the engine fills in its default.
- **The tool context has no `ask`.** Neither 1.22's call nor the v2 request shape works from a plugin. The setup `ctx.permission` has only `get`, `hook`, `list` and `reply`. `options.permission` raises no prompt; it only hides the tool when a `deny` rule for that name exists.
- **The engine's own prompt can still be raised, from the server.** `POST /api/session/:id/permission` with `{ action: 'mittrcraft_chrome', resources: [host], save: [host], metadata: { host } }` raises `permission.asked` and returns `{ id, effect: 'ask' }`. The raw `permission.replied` event carries `reply: once|always|reject`. `always` saves a rule that answers later asks by itself, and `DELETE /api/permission/saved/:id` removes it. **Task 8 takes path E**, with the facts under P15 that change how it is built.
- **Where the `ask` rule lives.** With no rule the engine allows. A managed `permissions` rule `ask` asks, but a project `allow` beats it. `experimental.policies` cannot hold `ask` at all. A plugin `permission.hook('evaluate')` that turns `allow` into `ask` did win over a project `allow`.
- **`auto` answers our ask.** Upstream's permission auto-accept runtime replied `{ decision: 'once' }` to our request 27 ms after it was asked. **On path E, Task 8 needs the A-30 hook** (`permission-auto-accept/runtime.js`, +1, total 35).
- **A plugin rewrite applies live.** A tool removed from `index.js` was gone from the next turn 359 ms later, with the same engine PID.
- **Abort reaches the plugin.** `context.signal` fired 82 ms after the turn was interrupted, and the never-answering listener saw its request closed 83 ms after. `POST /api/session/:id/abort` does not exist (404). The interrupt route is `POST /api/session/:id/interrupt`.
- Nothing tried to leave the machine.

## Results

| Scenario | Verdict | Evidence |
|---|---|---|
| P13 registration beside upstream's tools | PASS | The direct list holds `mittr_probe_direct`, `openchamber` and `openchamber_web`. `mittr_probe_code` is only in the Code Mode catalog. The tool returned `envType: "string"` for `MITTRCRAFT_TOOLS_URL`. |
| P13b wrapping upstream's panel tool | PASS | `tools.get` found `openchamber_web`, `tools.update` replaced `execute`, and the tool result the stub got ends in `probe-wrapped`. |
| P14 an image the model sees | PASS | The marker reached the next request in all four cells. 1.22's `attachments` shape is ignored. |
| P15 raising the permission prompt | PASS (path E) | (a) to (d) raise nothing. The server route raises `permission.asked` with the host in `resources`, `save` and `metadata`, and the tool learned each of `once`, `reject` and `always`. |
| P16 auto-accept and safety on a plugin permission | PASS | `id` and `sessionID` are present; `{ decision: 'once' }` unblocked the tool; the request is in `GET /api/permission/request`. `auto` answers it. |
| P17 hot toggle | PASS | Gone 359 ms after the rewrite (window 5 s), with the engine PID unchanged. |
| P18 abort reaches the plugin | PASS | The signal fired 82 ms after the interrupt, and the listener saw the request closed 83 ms after. |

## P13: registration beside upstream's tools

The probe plugin adds its tools through `ctx.tool.transform((tools) => tools.add({ name, description, options: { codemode }, input, execute }))`, with `input` as plain JSON Schema and no `import` statement.

- **Direct tools the stub received:** `edit`, `glob`, `grep`, `mittr_probe_ask`, `mittr_probe_direct`, `mittr_probe_image`, `mittr_probe_image_legacy`, `mittr_probe_permission_option`, `mittr_probe_wait`, `openchamber`, `openchamber_web`, `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`, `websearch`, `write`, `execute`.
- **The Code Mode catalog** lists each Code Mode tool under its own heading, and the call path is `tools.<name>`:

  ```
  - mittr_probe_code (1 tool)
    - tools.mittr_probe_code(): Promise<string | null> // MittrCraft probe tool mittr_probe_code.
  ```

  The stub called it with `execute` and `return await tools.mittr_probe_code({})`, and the tool's own text came back.
- **Engine env reaches the plugin.** The probe set `MITTRCRAFT_TOOLS_URL` in the engine's environment, and the tool's `typeof process.env.MITTRCRAFT_TOOLS_URL` was `"string"`.
- At the first transform, `tools.list()` already held `openchamber` and `openchamber_web`: upstream's plugin is set up before ours.

### The API names

None of these objects has prototype keys beyond `Object.prototype`.

| Object | Own keys |
|---|---|
| setup `ctx` | `agent`, `aisdk`, `app`, `command`, `event`, `experimental`, `generate`, `integration`, `location`, `mcp`, `model`, `options`, `permission`, `plugin`, `provider`, `reference`, `rpc`, `session`, `shell`, `skill`, `storage`, `tool`, `vcs`, `websearch`, `worktree` |
| `ctx.tool` | `hook`, `list`, `reload`, `transform` |
| `ctx.permission` | `get`, `hook`, `list`, `reply` |
| `ctx.session` | `command`, `compact`, `context`, `create`, `generate`, `get`, `hook`, `interrupt`, `move`, `prompt`, `remove`, `switchAgent`, `switchModel`, `synthetic`, `update`, `wait` |
| `ctx.location` | `directory`, `project`, `workspaceID` |
| the transform's `tools` | `add`, `get`, `list`, `namespace`, `remove`, `update` |
| the execute `context` | `agent`, `id`, `messageID`, `progress`, `sessionID`, `signal` (an `AbortSignal`) |

There is no `ask` on the execute `context`, and no `directory`.

## P13b: wrapping upstream's panel tool

Inside the same transform, the probe ran:

```
tools.update('openchamber_web', (tool) => {
  const original = tool.execute
  tool.execute = async (input, context) => {
    const result = await original(input, context)
    return { ...result, content: [...textOf(result.content), { type: 'text', text: 'probe-wrapped' }] }
  }
})
```

- `tools.get('openchamber_web')` returned the tool, and `tools.update` threw nothing.
- The stub called `openchamber_web` with `browser.snapshot`. Upstream's plugin posted to its callback, the control service found no panel client, and upstream answered its error envelope (`ok: false`, `action: browser.snapshot`, `kind: runtime`). The wrapper ran once, and the tool text the stub got is that envelope, a newline, then `probe-wrapped`.
- The original `execute` handed to the update callback takes `(input, context)` and returns a promise. The context it is given has `progress` and `signal`, so calling it from the wrapper works.

## P14: an image the model sees

`mittr_probe_image` returns `content: [{ type: 'text', text: '{"ok":true}' }, { type: 'file', uri: 'data:image/png;base64,<MARKER_PNG>', mime: 'image/png', name: 'probe.png' }]`. `MARKER_PNG` is a fixed 2×2 PNG, 77 bytes, sha256 `0a66d428…64d6b4`. The probe exports this part as `PROVEN_IMAGE_PART`.

| Model capabilities | Called directly | Through Code Mode `execute` |
|---|---|---|
| `{ tools: true }` (today's provider config) | seen, sha256 matches | seen, sha256 matches |
| `{ tools: true, input: ['text', 'image'] }` | seen, sha256 matches | seen, sha256 matches |
| diagnostic: `{ tools: true, input: ['text'] }` | not sent | not sent |

- **How it travels.** The tool message carries the text as a string. The engine adds a user message right after it whose content is one `image_url` part with the data URI.
- **`{ tools: true }` already allows images.** The engine's model list reports `input: ['text', 'image']` for it, because unset capability fields fall back to the defaults.
- **A text-only model** gets the tool's text plus an error line the engine writes in place of the image: `Cannot read "probe.png" (this model does not support image input)`.
- **1.22's shape is ignored.** `{ content: '{"ok":true}', attachments: [{ type: 'file', mime, url, filename }] }` gave a normal tool result with the text only. There was no image and no error.

## P15: raising the permission prompt

Host `probe.example.test`. Each attempt ran in its own session, and the stub called the tool once.

| Attempt | `permission.asked` | What the tool's call did |
|---|---|---|
| (a) `context.ask({ permission, patterns, always, metadata })` (1.22's call) | no | threw `TypeError`: `context.ask is not a function` |
| (b) `context.ask({ action, resources, save, message, metadata })` (the v2 request shape) | no | threw the same `TypeError` |
| (c) a permission API on the setup `ctx` | no | none found: the probe matched the names `ask`, `create`, `assert` and `request` on `ctx.permission` only, which has `get`, `hook`, `list` and `reply`. `ctx.rpc` and `ctx.event.subscribe` were not examined |
| (d) `options: { permission: 'mittrcraft_chrome' }` on the tool | no | the tool ran normally |
| (e) the server creates the request: the tool calls its loopback callback, which calls `POST /api/session/:id/permission` on the engine and waits for the raw `permission.replied` event | yes | resolved with the person's reply |

- **What `options.permission` does.** With a managed rule `{ action: 'mittrcraft_chrome', resource: '*', effect: 'deny' }`, the tool was no longer offered to the model. It hides the tool under a deny rule and raises no prompt.
- **Attempt (e) is the first that raises the event**, so the reply runs, P15d, P15e and P16 use it. For those runs the managed config held `permissions: [{ action: 'mittrcraft_chrome', resource: '*', effect: 'ask' }]`, because with no rule the engine answers `allow` (see where the rule lives, below). The create body also carried `source: { type: 'tool', messageID, id }` from the tool's context, and the engine accepted it. Every create call carried `source`; the probe's retry without it was never exercised, so whether `source` is optional is not shown. The route answers inside a `data` envelope (`{ data: { id, effect } }`), which the probe unwrapped.

### The event, raw and translated (preflight F7)

The raw `permission.asked` payload from `/api/event`:

```
{ id: "evt_…", type: "permission.asked", created, location: { directory },
  data: { id: "per_…", sessionID, action: "mittrcraft_chrome",
          resources: ["probe.example.test"], save: ["probe.example.test"],
          metadata: { host: "probe.example.test" },
          source: { type: "tool", messageID, id } } }
```

- **The raw `permission.replied` payload has `reply`:** `data: { sessionID, requestID, reply: "once" | "always" | "reject" }`. All three runs carried the decision they sent.
- **The translated one does not.** Upstream's `translateWireEvent` (`translate-v2.js:311-313`) turns it into `properties: { sessionID, requestID }`, plus the `directory` every translated event gets. A subscriber that reads `translated()` never learns once, always or reject.
- The translated `permission.asked` keeps every field above, flattened into `properties` with `directory` added.
- **`message` is dropped.** The probe's create body carried `message: 'Allow the agent to use your Chrome sign-in on probe.example.test?'`. Neither the event nor the pending list has a `message` field. Upstream's permission card shows `permission.message` only when it is present, so **the card does not carry our sentence**; it shows its own title for the action and resources.

### The three replies

The reply is `POST /api/session/:id/permission/:pid/reply` with `{ decision }`.

| Decision | Reply status | What the tool's call got |
|---|---|---|
| `once` | 204 | resolved with `{ effect: 'ask', id, reply: 'once' }` |
| `reject` | 204 | resolved with `{ effect: 'ask', id, reply: 'reject' }` |
| `always` | 204 | resolved with `{ effect: 'ask', id, reply: 'always' }` |

The runs went in the order once, reject, always, so that `always` could not answer the `reject` run. Each request was listed, while pending, by `GET /api/permission/request` with `x-opencode-directory` and by `GET /api/session/:id/permission`. Their items carry `action`, `id`, `metadata`, `resources`, `save`, `sessionID` and `source`.

### P15d: a later ask after `always`

- **The engine answers it by itself.** In a new session, the same host got `{ effect: 'allow' }` and no `permission.asked`.
- **The saved rule can be listed and deleted.** `GET /api/permission/saved` (with or without `?projectID=`) lists it as `{ id, projectID, action: 'mittrcraft_chrome', resource: 'probe.example.test', time }`. `DELETE /api/permission/saved/:id` answered 204.
- **After the delete, the next ask raised `permission.asked` again.**
- The saved rule carries `projectID` and the host, so it is presumably per project and per host. This is inferred from the stored fields; approving in one project and asking in another was not tested.

### P15e: abort while the ask is pending

- `POST /api/session/:id/abort` answered 404. The probe then used `POST /api/session/:id/interrupt`.
- **What the tool saw:** `context.signal` fired, and its pending callback request threw `AbortError: The operation was aborted.` The server side saw the request close before any reply.
- **The request was still listed 1.5 s after the interrupt** by `GET /api/permission/request`. That is all the evidence shows. The probe then sent `reject` to clean up, but it did not keep that reply's status, and it looked for a `permission.replied` straight after the reply with no wait, so its finding none proves nothing.
- **Open for Task 8 to assert:** whether a `permission.replied` ever comes for a request whose turn was interrupted, and whether a `reject` sent after the tool has gone answers 2xx and produces a raw `permission.replied` with `reply: reject`.

### Where the `ask` rule lives (preflight F9)

Each row is one create call in a fresh session, after rewriting the managed config and the project's `opencode.json` and waiting 2 s.

| Managed config | Project `opencode.json` | Effect | `permission.asked` |
|---|---|---|---|
| no rule | none | `allow` | no |
| `permissions: ask` | none | `ask` | yes |
| no rule | `permissions: allow` | `allow` | no |
| `permissions: ask` | `permissions: allow` | `allow` | no |
| `experimental.policies: { action: 'permission', resource: 'mittrcraft_chrome:*', effect: 'deny' }` | `permissions: allow` | `deny` | no |
| no rule, plus the probe plugin's `permission.hook('evaluate')`, for host `hooked.example.test` | `permissions: allow` | `ask` | yes |

- **A project-level `allow` suppresses a managed `ask`.** The rule list is the top-level `permissions` key, an ordinary key that sits below project config.
- **`experimental.policies` cannot hold the rule.** Its entries take `action` `provider.use` or `permission` and `effect` `allow` or `deny` only (`@opencode/schema` 2.0.22 `config/policy.js`). A `permission` policy is matched against `<action>:<resource>`, outranks project config, and can only turn a request into `deny`. The ruling to put `{ effect: 'ask' }` in `experimental.policies` cannot be carried out.
- **A plugin's `evaluate` hook outranks project config.** The hook got `{ action, agent, effect, metadata, resources, sessionID, source }` with `effect: 'allow'` from the project rule. It set `effect = 'ask'`, and the engine asked.
- **Open for Task 8:** the hook was tested only against a project `allow`, for one host. How it interacts with a rule the engine saved after `always` is untested: a hook that turns every `allow` into `ask` may ask again after `always`, unless it consults MittrCraft's own approved sites. The request the hook is handed has no `save` and no `message`, so the hook cannot rely on either.

### P15f: what Task 8 asked of the live engine

Added for Task 8 and run twice on the same set-up (`--only agent-tools`, every scenario PASS, exit 0, no outbound attempt, port guard 146 checked and 0 refused, 57133 not listening). Each row is a server-created request, as in attempt (e).

- **The engine keeps an id the server gives it.** A create carrying `id` (minted as `per_` plus 12 hex time digits and 14 base62 characters, the engine's own shape) answered that id. `permission.asked` and the session's pending list carried it, a `once` reply to it answered 204, and the raw `permission.replied` named it. A second create reusing an answered id was accepted too, so ids must never repeat. Added in Task 8 fix round 1 (R155), with port guard 152 checked and 0 refused.
- **The evaluate hook alone makes the engine ask.** With no rule in any layer, `hooked.example.test` got `{ effect: 'ask' }` and a `permission.asked`.
- **The hook asks again after `always`.** After `always` saved a rule for `hooked.example.test`, a new session's ask got `ask` and a `permission.asked`, not `allow`. The hook cannot tell a saved rule from a project `allow`, so it is MittrCraft's own approved list, checked by the server before it raises anything, that keeps an always-allowed site from being asked about again.
- **A saved rule belongs to one project.** In two git repositories, `always` in the first left the second asking (`ask`), while a new session in the first got `allow`. A `GET /api/permission/saved` without that project's directory did not list the rule.
- **A fresh location answers `deny` first.** The first create in a newly started project location answered `deny`, and the next, about 400 ms later, `ask`. A turn's own session is already running, so the Chrome tool does not meet this.
- **After an interrupt the request stays until the server answers it.** `POST /api/session/:id/interrupt` answered 200. 1.5 s later the request was still listed and the engine had sent no `permission.replied`. A `reject` from the server then answered 204, a raw `permission.replied` with `reply: 'reject'` followed, and the request left the list.

## P16: auto-accept and safety on a plugin permission

The probe ran upstream's `createPermissionAutoAcceptRuntime` against the engine, feeding it every `/api/event` frame as the global hub does (raw payload plus a lazy `translated()`).

- **`properties.id` and `properties.sessionID` are present** in the translated `permission.asked`, which is what `processPermission` reads.
- **`auto` answers our ask with no hook.** In a session set to `auto`, the runtime sent `POST /api/session/:id/permission/:pid/reply` with `{ decision: 'once' }` 27 ms after the ask. The tool resolved with `reply: 'once'`.
- **The request is in the list `reconcilePending` reads.** `reconcilePending({ directories: [work] })` made one call, `GET /api/permission/request` with the work directory header. The request was in it, and the runtime evaluated it a second time.
- **The object `evaluatePermission` is handed in `safety` mode** (with the work directory as the second argument):

  ```
  { id: "per_…", sessionID, action: "mittrcraft_chrome",
    resources: ["probe.example.test"], save: ["probe.example.test"],
    metadata: { host: "probe.example.test" },
    source: { type: "tool", messageID, id: "call_…" },
    directory: "<home>/work" }
  ```

  With no verdict, the runtime held the request, sent `openchamber:permission-auto-accept.left-for-user`, and `isPermissionAutoAnswered` read `false`. The probe then answered it with `reject`.

## P17: hot toggle

While the engine ran, the probe rewrote the plugin's `index.js` without `mittr_probe_direct` and called the managed runtime's `refreshManagedConfigFile()` (`{ updated: true }`).

- **The first check turn, which ended 359 ms after the rewrite, no longer offered `mittr_probe_direct`.** The other probe tools were still offered. The window was 5 s.
- The plugin's `setup` ran once more.
- Engine PID unchanged, engine alive. No refresh and no restart was needed, so there is no restart cost to record.

## P18: abort reaches the plugin

`mittr_probe_wait` awaits `fetch(<loopback listener that never answers>, { signal: context.signal })`.

- **The listener got the request.** The probe then interrupted the turn (`/abort` 404, `/interrupt` used).
- **`context.signal` fired** 82 ms after the interrupt.
- **The listener saw its request closed** 83 ms after.
- The tool's fetch threw `AbortError`. The engine recorded `session.tool.failed` (`aborted`, "Tool execution interrupted") and `session.execution.interrupted`.

## Timings

- Plain tool turns settled 44–83 ms after the prompt. Turns that waited for a permission reply settled 226–325 ms after it, and the abort turn 230 ms.
- `auto` replied 27 ms after the ask. In `safety` mode the probe's `reject` came 165 ms after the ask, after a reconcile.
- The hot toggle took 359 ms. Abort reached the plugin in 82 ms and the listener in 83 ms.

## Outbound connections

There were none.

- The engine's HTTP(S) proxy pointed at the probe's loopback recording proxy, which saw 0 attempts.
- `lsof` was sampled every 250 ms, 161 samples, over the engine (it had no child processes). It saw no non-loopback remote and no loopback peer other than the probe's own stub, proxy, callback and listener ports.
- The engine log names no non-loopback host.
- **Port guard (R46).** Port 57133 was not listening, and the probe never contacts it. Before the engine started, the probe checked with `lsof` that nothing listened on the engine's port. Before each of its 111 HTTP calls to the engine, it checked that the port's listener was in the engine's process group. None was refused.

## Clean-up

- The engine runs in its own process group and was stopped by group. No engine process for its port was left.
- The callback server, the listener and the auto-accept forwarder were closed, and the temp HOME was deleted.

## Stop conditions and what Tasks 4, 5 and 8 must do

None of the plan's Task 1 stop conditions stops the phase.

- **P13 passed.** Tasks 4 to 11 go on. Our tools are added through `ctx.tool.transform`, with `codemode: false` for direct tools, plain JSON Schema `input`, and no `import` statement.
- **P13b passed.** Task 5 wraps `openchamber_web` from our own plugin with `tools.get` and `tools.update`. It adds no hook in `agent-tool/runtime.js`, so the +1 for that file does not happen.
- **P14 passed in every cell.** The image half of A-13, A-18 and A-26 goes on, with the part shape `{ type: 'file', uri: 'data:<mime>;base64,…', mime, name }` (`PROVEN_IMAGE_PART`). Task 5 does not need to add `input: ['text', 'image']`: `{ tools: true }` already gives it. An `input` list that leaves out `image` would drop the image. Code Mode keeps the image, so there is no owner note.
- **P15 chooses path E for Task 8**, because all three of the plan's conditions hold: the ask raises `permission.asked` with the host in `resources`, `save` and `metadata`; the tool learned once, always and reject; and the rule `always` saves can be listed and deleted. These facts bind how path E is built:
  - the request is created by the MittrCraft server through `POST /api/session/:id/permission`, not by the plugin, because the tool context has no `ask`. The plugin waits on its callback, and the server waits for the raw `permission.replied` (F7);
  - the engine allows `mittrcraft_chrome` unless a rule says `ask`. A managed `permissions` rule is beaten by a project `allow`, and `experimental.policies` cannot say `ask`. **F9's ruling needs a new decision.** The probe showed that an `evaluate` hook in our engine plugin, turning `allow` into `ask` for `mittrcraft_chrome`, wins over a project `allow`;
  - `message` does not reach the event, so the card shows the engine's own title. The host is in `resources` and `metadata`;
  - an aborted turn left the request listed 1.5 s later. Whether a `permission.replied` follows, and whether a `reject` from the server then answers 2xx and ends the request, are open, and Task 8's tests must assert them;
  - deleting an approved site calls `DELETE /api/permission/saved/:id` for the saved rule of that host.
- **P16: `auto` answers our ask.** On path E, Task 8 needs the A-30 hook in `permission-auto-accept/runtime.js` (+1), so the upstream-touch count goes from 34 to 35.
- **P17 passed.** Task 4 does not call `context.opencode.refresh('mittr tools changed')`. The probe rewrote both the plugin file and the managed file (through `refreshManagedConfigFile()`, which always rewrites it), so it does not show which of the two made the engine reload. Task 4 rewrites both, as the probe did, and the 1.22 sentence about a restart is dropped (preflight F27).
- **P18 passed.** Task 4 forwards `context.signal` to its callback fetch and aborts in-flight actions when that request closes, as upstream's own plugin does.
- **Outbound.** There is no host to record for the owner.

## Owner notes

- **Path E's rule placement is open.** Preflight F9 assumed `experimental.policies` could hold `ask`; the 2.0.22 schema cannot. The probe found two working options: a managed `permissions` rule, which a project's own `opencode.json` can override with `allow`, or an `evaluate` hook in our engine plugin, which the project cannot override. The owner or controller picks before Task 8.
- **The prompt's wording is the engine's.** Our explanatory sentence is dropped from the request, so the approval card does not say why the agent asks. It shows the action name `mittrcraft_chrome` and the host.
- **A saved approval is probably per project.** `always` stores `{ projectID, action, resource }`, so approving a site in one project presumably does not approve it in another. This is inferred from the stored fields, not tested.
- **Code Mode.** Both of our Code Mode probe tools worked through `execute`, images included. This was not measured with a real model.

## Drivers

Date: 2026-10-21. Build: `node scripts/mittr/build-desktop.mjs --flavor dev`, exit 0. Probe: `node scripts/mittr/probe-agent-browser.mjs --json <out>` under the isolated shell. The verdicts below are from the fix-round run at `d4417ef9d` (11 s, 30 `lsof` samples), the eighth run in all and the only one whose every Chrome launch went through the refusing proxy. Runs 1 and 2 started no Chrome, and run 3 found the last two probe bugs. Runs 3 to 7 drove their main Chrome without a proxy; runs 5 to 7 also ended with a diagnostic launch behind it. The unproxied facts in the AB3 row come from run 6 (73 samples) and run 7, at `95be19c1c` (72 samples). The evidence JSON is kept outside the repository and holds no token or password; temp paths are written as `<temp>`.

### What is packed

The pins are in `scripts/mittr/drivers.json`. The build reads both files from `packages/electron/.cache/` (or the paths in `MITTRCRAFT_AGENT_BROWSER_BINARY` and `MITTRCRAFT_CUA_DRIVER_ARCHIVE`) and checks them before any build step. It never downloads them: a missing or different file stops the build and names the asset, the release URL and the owner's yes. Step 3 stages `agent-browser` with mode 755, extracts `CuaDriver.app` with the system `tar`, links `cua-driver` to `./CuaDriver.app/Contents/MacOS/cua-driver` as 1.22 did, and checks the app with `codesign --verify --deep --strict`. Step 8 checks the packed copies. Before any step, a build whose target is not arm64 is refused, because the pinned agent-browser is arm64 only.

| Item | Pinned | In the packed `MittrCraft Dev.app` |
|---|---|---|
| `agent-browser` 0.38.1 | sha256 `2e612872…e892e0d`, 15,768,448 bytes | re-signed by the builder: ad-hoc, hardened runtime, identifier `agent-browser-5555…`, sha256 `a1eb1ce6…39c5ba`, 15,696,864 bytes. Without its signature: sha256 `0b47b1d7…19e6a0`, 15,646,064 bytes, which is the pinned `resignedStrippedSha256`, measured at the first build and the same at the second. `--version` prints `agent-browser 0.38.1`. |
| `cua-driver` 0.28.2 | archive sha256 `e273181b…fc3fbb1`, binary sha256 `9a7731f7…6b81` | not re-signed: `mac.signIgnore` holds `/Contents/Resources/cua-driver/` in both builder files. Binary sha256 `9a7731f7…6b81`, `Identifier=com.trycua.driver`, `TeamIdentifier=YCK386LBJ7`, Developer ID Application: Cua AI, Inc., notarized (`spctl` accepts it). `--version` prints `cua-driver 0.28.2`. |
| `THIRD_PARTY_NOTICES.md` | `brand/THIRD_PARTY_NOTICES.md` | in `Contents/Resources`, the same bytes. |

The whole app still passes `codesign --verify --deep --strict` with the nested app left as it came. The brand-leak scan reported `1404 files: 255 translation keys, 4126 translated, 129 allowlisted, 0 unexplained, 0 unused allowlist entries`, so `brand/leak-allowlist.json` is unchanged.

The notices file has two sections. The agent-browser section holds the release's `LICENSE` (Apache-2.0), fetched once with the owner's yes from `https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.38.1/LICENSE`, sha256 `014bb31e83d5c2e76aea1cc6e82217346ab41362f32cb355ad0f5c10aa0aeaff`. The repository was read from the npm metadata of agent-browser 0.38.1 (`vercel-labs/agent-browser`, Apache-2.0). The same tag has no `NOTICE` (404). The cua-driver section is 1.22's, with its one line of our own prose now naming `scripts/mittr/drivers.mjs` instead of 1.22's `scripts/prepare-cua-driver.mjs` (R146); the MIT text is unchanged. The build checks the agent-browser licence text and the whole cua-driver section against their sha256 pins.

Which app a macOS permission prompt would name was read from files, without asking macOS: the packed `CuaDriver.app` is named `Cua Driver` (`CFBundleName` and `CFBundleDisplayName`), with `LSUIElement` true. The host is `MittrCraft Dev`, `dev.mittrcraft.desktop.dev`, ad-hoc signed, with no team. Started through LaunchServices, a prompt would name Cua Driver. Started as a child of the server, it would probably be charged to MittrCraft Dev. Which one happens is for Part B to record.

### Probe verdicts

The probe runs the staged copy at `packages/electron/.product/agent-browser/agent-browser` (mode 755, the pinned sha256), never the cache file. It uses a fresh temp HOME with `CFFIXED_USER_HOME`, `TMPDIR` and the XDG folders inside it, a clean environment, `AGENT_BROWSER_EXECUTABLE_PATH` set to Google Chrome 155.0.8059.85, and `AGENT_BROWSER_PROFILE=Default` for a throwaway profile seeded under the temp HOME. Every page is on `127.0.0.1`. An `lsof` sampler covered agent-browser and every Chrome process it started, every 250 ms. A watcher looked for new `SecurityAgent` and `UserNotificationCenter` processes. Every Chrome launch carries `--proxy-server=127.0.0.1:<port>`, pointing at a loopback proxy in the probe that refuses every request; Chrome's own loopback bypass lets the test pages through. The flag goes through `AGENT_BROWSER_ARGS` and has no comma, so it arrives whole (checked on Chrome's command line). SIGINT and SIGTERM run `close --all`, kill the probe's process groups and remove the temp root. The owner's Chrome was running throughout and was not touched.

| Row | Verdict | Evidence |
|---|---|---|
| AB1 profile isolation | PASS | `CFFIXED_USER_HOME` moves the Cocoa home, Application Support, Caches and Preferences into the temp HOME (with HOME alone, the Cocoa home stays the real one). The first call, `agent-browser --json profiles`, ran under `sandbox-exec` denying the real `~/Library/Application Support/Google`, `~/Library/Preferences/com.google.*`, `~/Library/Caches/Google` and `~/.agent-browser`. It exited 0 and listed only the seeded profile, and a system-log query for sandbox denials naming agent-browser found none. `lsof` saw no path under any of those folders, no command line named one, and the `stat -f %m` of each folder and preference file was the same before and after. Chrome's `--user-data-dir` was the profile copy under the temp root. Either a changed time or a copy outside the temp root fails the row. Chrome made its `RLZ` folder in the temp HOME's Application Support. |
| AB2 keychain | PASS | The channel is `--args <args>  Browser launch args, comma or newline separated (or AGENT_BROWSER_ARGS)`. The probe set `AGENT_BROWSER_ARGS`, one flag per line, and Chrome's command line carried `--use-mock-keychain` and `--password-store=basic`. No `SecurityAgent` appeared. `security find-generic-password -s "Chrome Safe Storage"` on the login keychain exited 0 before and 0 after; its value was never read. |
| AB3 quiet network | PASS | Behind the refusing proxy, every peer was loopback, and the test page was served directly. The proxy refused 26 attempts to `clients2.google.com`, `www.gstatic.com`, `www.google.com`, `accounts.google.com`, `update.googleapis.com`, `content-autofill.googleapis.com` and `android.clients.google.com`. In the main launches of runs 3 to 7, which had no proxy, the flags alone did not stop them: Chrome's network-service process connected to about ten Google peers on ports 443, 80 and 5228, `optimizationguide-pa.googleapis.com` among the hosts. |
| AB4 Chrome 155 driven | PASS | `open`, `snapshot -i` (textbox `Name`, button `Send`), `fill @e3`, `click @e2`, `get url` (`/done?name=mittr+probe`), `screenshot` (a PNG) and `read` (`Received: mittr probe`) all worked. Chrome ran with `--headless=new`. |
| AB5 clean-up | PASS | After `close --all`, no process with the staged path or the temp folder in its command line was left (`pgrep -f` found none), and nothing had to be killed. The profile copy was at `<temp>/tmp/agent-browser-profile-<uuid>`, and close removed it. |
| AB6 listeners | PASS | Every listener of agent-browser and its Chrome was on `127.0.0.1`. Streaming is on by default for each session, on its own port. A WebSocket upgrade to that port with its own origin, `http://127.0.0.1:<port>`, was accepted (`101 Switching Protocols`), and the same upgrade with `Origin: http://evil.example.test` was refused with `403 Forbidden`. `stream disable` exists per session and exited 0. |

### What the probe changed, and what binds later tasks

- **A Chrome flag cannot hold a comma.** agent-browser 0.38.1 splits `--args` and `AGENT_BROWSER_ARGS` at every comma as well as every newline, with no escape. The first full run passed `--disable-features=MediaRouter,DialMediaRouteProvider` and Chrome got `DialMediaRouteProvider` as a page to open. The probe passes `--disable-features=MediaRouter`; the DIAL provider is part of the media router. agent-browser adds its own `--disable-features=Translate` before ours. Chromium reads the last value of a repeated switch, so translation is probably no longer switched off; this was not measured. Task 7 must pass flags the same way.
- **Every command needs the same launch options.** The second full run gave `--profile` to `open` only. The next command relaunched Chrome without the profile copy. The probe sets `AGENT_BROWSER_PROFILE` for every command instead. Task 7 does the same.
- **The socket path is limited to 103 bytes.** With `TMPDIR` under `/var/folders`, the session name `mittr-probe` was too long. The probe uses `p4`.
- **AB1, AB4 and AB6 passed**, so Tasks 7 to 9 go on, and the gate's Part A Chrome rows are not stopped by them.
- **AB3 passes only behind the proxy (R145).** Every probe and Part A Chrome row runs with `--proxy-server=127.0.0.1:<refuser>`. Chrome's own Google traffic in the person's Chrome in the product is normal Chrome behaviour and an owner note, not a 4A change.
- **The profile copy.** A copy of the chosen profile sits in `TMPDIR` while an agent Chrome is open, as in 1.22, and `close --all` removes it.

### Owner notes

- **The licences screen.** 2.1.1 has no licences screen, so A-27's "the licences screen lists both" cannot hold. The notices ship as `Contents/Resources/THIRD_PARTY_NOTICES.md`. This is an inventory deviation for phase 5.
- **macOS permissions.** `signIgnore` keeps `CuaDriver.app` signed by Cua AI, Inc., unlike 1.22, whose packed copy was re-signed ad hoc. Whether macOS asks under "Cua Driver" or "MittrCraft Dev" depends on how the server starts the driver, and is recorded in Part B before any grant.
- **The packed agent-browser is re-signed.** It is no longer byte-for-byte the release, so A-27 compares it against the pinned unsigned hash. The builder also turned on the hardened runtime for it; `--version` runs.
