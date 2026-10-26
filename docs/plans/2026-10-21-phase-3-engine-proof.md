# Phase 3: how OpenCode 2.0.22 finds catalog skills and runs catalog connectors

Date: 2026-10-21. Script: `node scripts/mittr/probe-engine-v2.mjs --only skills-mcp --json <out>`. Engine: the bundled `packages/electron/resources/opencode-cli/opencode`, which reports `opencode v2.0.22`. The numbers below are from the last full run. The race rates in the timing notes (4 of 11, 1 of 11) come from repeated runs during development, made once the probe could drive the engine's Code Mode. The evidence JSON holds one run, and it is kept outside the repository; it holds no token.

## The short answer

- Catalog skills reach the engine in both layouts, nested `skills/mittr/<name>/` and flat `skills/mittr-<name>/`. A new skill shows up within about 0.3 s, with no restart. The plan's stop rule does not trip. **Task 8 uses the flat layout `mittr-<name>/` (ruling R119), because nested ids drop `mittr/` and a developer's own skill hid a catalog skill of the same name. It needs no refresh after a change.**
- A connector in the managed config file connects within about 0.3 s. Its tool runs once when asked, and it stops within about 0.3 s when the entry is removed, all with no restart.
- **Settings → MCP does not list a connector that lives only in the managed file.** P10b failed, as preflight finding 14 expected. **Under ruling R128, Task 9 puts catalog connectors only in the managed config file**, for the signed-in account only, and never in the person's user config. They run, but Settings → MCP does not list them; the off switch is the catalog toggle. They are off on hosted web under ruling R132 (see Config reads).
- Nothing tried to leave the machine.

## Results

| Scenario | Verdict | Evidence |
|---|---|---|
| P8 skill discovery | PASS (nested and flat) | Both skills are in `client.skill.list` and in the `<available_skills>` block the engine sends to the model. |
| P9 skill hot pickup | PASS | A nested and a flat skill added while the engine ran were listed 292 ms later. The engine PID was the same before and after. |
| P10 managed connector | PASS | `mittr-probe` read `connected` 293 ms after the write. The tool ran once: the stub log has one call, and the model got `stub-law-41` back. |
| P10b listed in Settings → MCP | FAIL (expected) | Upstream's `listMcpConfigs`, run with the server's own env, returned an empty list. |
| P11 fan-out | PASS | N = 3: one new stub process per project, and each project's tool call ran in that project's process. |
| P12 hot removal | PASS | Every stub process exited 279 ms after the entry was removed. The MCP status list was empty, and the tool was gone from the next turn. |

P11's N = 3 counts the stub processes that are new since P10. The raw `pgrep -f stub-mcp-server.*<marker>` count is 4, because the work dir's own process from P10 is still running.

### P8: skill discovery

The probe wrote these skills under `<OPENCODE_CONFIG_DIR>/skills/` before the engine started. `OPENCODE_CONFIG_DIR` is `<temp HOME>/.config/opencode`.

| Folder | Frontmatter `name:` | Engine id | Engine name |
|---|---|---|---|
| `mittr/probe-skill` (nested) | `probe-skill` | `probe-skill` | `probe-skill` |
| `mittr-probe-skill` (flat) | `mittr-probe-skill` | `mittr-probe-skill` | `mittr-probe-skill` |
| `mittr-probe-mismatch` (flat) | `probe-mismatch-name` | `mittr-probe-mismatch` | `probe-mismatch-name` |

- **The skill id is the skill's own folder name.** A nested skill's id does not carry the `mittr/` folder: it is `probe-skill`, not `mittr/probe-skill`.
- **Flat and nested both work.**
- **A mismatched name is accepted.** The id is the folder name and the name is the frontmatter. The engine needs no `name:` equal to the folder.
- The skills are not in the skill tool's description. They reach the model in an `<available_skills>` block in the system prompt.
- The first listing came 663 ms after the first read for the directory.
- **A name clash.** A developer's `skills/probe-collide/` and a nested `skills/mittr/probe-collide/` both get id `probe-collide`. The engine listed only the developer's skill and sent only its description to the model, so the catalog skill was hidden. This was seen once. Which rule decides the winner is not proven.

### P9: skill hot pickup

`skills/mittr/probe-hot/` and `skills/mittr-probe-hot/` were written while the engine ran. Both were listed 292 ms later. The window was 10 s, and engine PID 73975 was unchanged. No refresh and no restart was needed, so there is no restart cost to record.

### P10: a connector in the managed config

The managed file got this entry:

```
mcp.servers['mittr-probe'] = mcpEntityFromCatalog({ type: 'local', command: ['node', <stub>, '--log', <log>, '--marker', <marker>] })
```

That gave `{ type: 'local', command: [...] }`. `mcpEntityFromCatalog` is `catalogMcpEntity(raw, toMcpEntity)` from `packages/mittr-server/src/mittr/mcp-fragment.js`. It refuses an entry without a valid `type` before upstream's `toMcpEntity` runs, because `toMcpEntity` would default a missing type to local (finding 13).

- `client.mcp.list` read `mittr-probe: connected` 293 ms after the write.
- **The model never sees the connector's tool as a direct tool.** The engine lists it in a "Code Mode" catalog in the system prompt, as `tools["mittr-probe"].lookup({ query?: string })`. The model calls it through the built-in `execute` tool. The stub model sent `return await tools["mittr-probe"].lookup({ query: "41" })`. The stub logged one call, and the tool result the engine sent back read `stub-law-41`. No permission prompt came up.
- **Timing.** In 4 of 11 runs, the first turn, started about 0.5 s after the write, did not have the catalog yet, though the status already read connected. The next turn, about 1.3 s after the write, always did. The probe retries a turn every 0.5 s within the 10 s window. In the recorded run the first turn, at 605 ms, had it.
- The stub is started with `node` from PATH. The probe put node's own directory first on the engine's PATH.

### P10b: listed in Settings → MCP

`GET /api/config/mcp` calls `listMcpConfigs(directory)`. That reads `readConfigLayers`, which takes `OPENCODE_CONFIG` from the server's own env, and the route merges no engine status. The desktop server does not set `OPENCODE_CONFIG` in its own env: the managed file goes only into the engine child's env.

The probe ran `listMcpConfigs` in a separate node process with the server's env: temp `HOME` and `XDG_*`, and no `OPENCODE_CONFIG`.

- **Listed: no.** The list was empty. `customPath` was null; the user path was `<home>/.config/opencode/opencode.json` and the project path was `<work>/.opencode/opencode.json`.
- **Editable: not applicable.** The page cannot edit what it does not list.
- **Diagnostic: with `OPENCODE_CONFIG` set to the managed file**, as the plan first described it, the entry is listed with `scope: user`, and an edit would be written into the managed file, which the server rewrites at every start.
- **Settings → MCP has no read-only state.** `McpGrid.tsx` gives every card a Delete action, and `McpPage.tsx` edits every listed entry. Any listing of catalog connectors there would need a read-only, redacted hook. Under R128 there is none, so catalog connectors are not listed.

### P11: fan-out across projects

The probe made three temp project dirs and ran the tool once in each. Each project's first read started one new stub process, with that project as its working directory, and its call ran in that process.

| Project | New stub processes | Calls | Connected after |
|---|---|---|---|
| `projects/p1` | 1 | 1 | 353 ms |
| `projects/p2` | 1 | 1 | 282 ms |
| `projects/p3` | 1 | 1 | 343 ms |

- **N = 3**, so 1 process per project. With the work dir's own process, `pgrep -f stub-mcp-server.*<marker>` counted 4.
- All four stayed alive until the entry was removed. Each location keeps one process per configured local connector, for as long as the location lives.

### P12: removing a connector while the engine runs

The entry was removed from the managed file.

- All four stub processes exited cleanly within 279 ms. The window was 10 s.
- `client.mcp.list` returned an empty list.
- The next turn, 538 ms after the removal, had no `mittr-probe` catalog entry and no direct `lookup` tool.
- **Timing.** In 1 of 11 runs, the turn right after the removal still listed the connector in the Code Mode catalog, though its processes had already exited. That run had no retry; the probe now retries a turn every 0.5 s within the 10 s window, and records each try.
- Engine PID 73975 was unchanged.

## Config reads

Measured in fix round 3 of Task 9 (`probe-engine-v2.mjs --only config-exposure`), with a managed config holding a remote connector with a secret header and a local connector with a secret environment value. Neither connector reached a host.

- **`GET /api/config` returns the managed config's `mcp` secrets.** With or without `?directory=`, and through `client.config.get()`, the answer lists the managed file as a config document and carries its `mcp.servers.*.headers` and `environment` verbatim.
- **`GET /api/config/shell`, `GET /api/mcp` and `client.mcp.list()` do not.** `mcp.list` gives only each server's name, status and error.
- **The server's generic `/api` proxy passes `GET /api/config` through unchanged**, so every UI session that can reach the server can read it.
- **On the desktop app the UI is the person's own.** The window talks to its own loopback server, so the person reads back only the connectors of the account they signed in with.
- **Hosted web is off under ruling R132.** On any hosted runtime (no desktop host, a UI password, or company sign-in), mittr-server renders no catalog connector into the managed config and logs one line at start. The catalog list and its toggles still work.
- **Owner decision (I3).** Either add a generic proxy response-redaction hook for `mcp.servers.*.headers`, `environment` and `oauth.client_secret` (+1 upstream touch), or keep catalog connectors off hosted web. The same read also returns everything else in the managed config to hosted UI sessions.

## Project layer

Measured in the final review's fix round (`probe-engine-v2.mjs --only project-layer`). The question was whether a repository's own config can take an org connector's secret header to a host of its choosing.

- **The managed config** held `mittr-probe`, a remote connector to a closed loopback port A, with header `x-probe-secret: <marker>`. A control entry, `mittr-probe-control`, pointed at the recording listener with the same header.
- **Three project dirs**, each a fresh git repo, named `mittr-probe` in their own config, with the url of a loopback listener (port B) that records request headers. A session was started and one turn was run in each.

| Project config | Entry | Engine used | Port B got the marker |
|---|---|---|---|
| `opencode.json` at the root | `{ type: 'remote', url: <port B> }` | the project's url, connected | no |
| `.opencode/opencode.json` | `{ type: 'remote', url: <port B> }` | the project's url, connected | no |
| `opencode.json` at the root | `{ url: <port B> }` (no `type`) | the managed url, refused | no request at all |

- **The engine does send a managed connector's headers.** The control received `x-probe-secret` with the marker, so the "no" above is a real no.
- **A project entry of the same name replaces the org entry for that project.** It does not merge into it. The project's url is used and the managed `headers` are dropped with the rest of the org entry.
- **An entry with only a `url` is not taken.** That project's document is not listed in `GET /api/config`, and the engine kept the managed entry.
- `GET /api/config` for a project lists the managed document, which still carries the header (see Config reads), beside the project's own.
- Nothing tried to leave the machine. The evidence JSON is kept outside the repository and holds no marker.

**What it means.** No org secret reaches a host named by a project config, so ruling R139's header and environment rule does not apply, and nothing in the product changes.

## Outbound connections

There were none.

- The engine's HTTP(S) proxy pointed at the probe's loopback recording proxy, which saw 0 attempts.
- `lsof` was sampled every 250 ms, 24 samples, over the engine and its 4 stub children. It saw no non-loopback remote.
- The engine log names no non-loopback host.
- Port 57133 was not listening, and the probe never contacts it. Before the engine started, the probe checked with `lsof` that nothing else was listening on the engine's loopback port. Only the engine port gets this check; the stub provider's and the proxy's random loopback ports do not.

The run itself has no egress control. The recording proxy was shown to catch egress by phase 2's `proxy-control` scenario.

## Clean-up

- Every engine runs in its own process group and was stopped by group.
- Each stub process carries a random marker. After the run, `pgrep -f stub-mcp-server.*<marker>` found nothing, and the probe had nothing to kill.
- The temp HOME was deleted.

## Stop conditions and what Tasks 8 and 9 must do

None of the plan's Task 6 stop conditions stops the phase.

- **P8 passed in both layouts.** The plan's stop rule does not trip. Task 8 uses the flat layout `<skills>/mittr-<name>/` (ruling R119), with id `mittr-<name>`. Ownership is the `mittr-` prefix plus a `.mittr-version` file, and the account marker is `<skillsRoot>/.mittr-account`.
  - Why: a nested skill's engine id is `<name>`, not `mittr/<name>`, and a developer's own skill of the same name hid the catalog skill, as the clash case showed.
  - The frontmatter `name:` does not have to equal the folder name.
- **P9 passed.** Task 8 does not call `context.opencode.refresh('mittr catalog skills changed')` after a change.
- **P10 passed, but P10b failed.** Ruling R127 first moved Task 9 to user-config entries. Ruling R128 reversed that, because writing org secrets into the person's user config was a security downgrade. **Task 9 takes the managed-only path:**
  - catalog connectors go only in the managed config file (mode 0600, written through a temp file and a rename, handed to the engine child alone), for the active account only, and are rewritten before each account-switch restart;
  - nothing is written to the person's user config, and no owned-names record is kept. The only user-config write is the sweep of 1.22's legacy `mcp["mittr/…"]` keys;
  - catalog connectors are not listed in Settings → MCP, so they cannot be edited or deleted there. The supported off switch is the catalog toggle;
  - they render only in the desktop app. On any hosted runtime (no desktop host, a UI password, or company sign-in), mittr-server renders none under ruling R132.
  - **Owner decisions at the gate:** whether to add a read-only, redacted Settings → MCP listing hook (+1 upstream touch), and how secrets are protected on hosted web (I3).
- **P11 gave one process per project.** No owner note is due under the plan's rule.
- **P12 passed.** Removing an entry stops its processes with no restart.
- **Outbound.** There is no host to record for the owner.

## Owner notes

- **Code Mode.** OpenCode 2.0.22 offers MCP tools only through `execute`. A model that does not use Code Mode well will not reach catalog connector tools. This was not measured with a real model.
- **First turn after a change.** About 0.5 s after a connector was added, 4 of 11 turns did not see its tool yet. About 0.5 s after one was removed, 1 of 11 turns still saw it. A person who sends a message the instant a connector arrives or leaves may get one turn with the old tool list.
- **Settings → MCP does not list org connectors.** Under R128 they live only in the managed config, so the page never shows them, and the Mittr catalog list is the only place they appear. A read-only, redacted listing needs a hook (+1 touch), and the owner decides that at the gate.
- **Desktop tunnel.** A tunnel opened on the desktop after start, without a UI password, lets remote clients with a connect link reach the same `GET /api/config`. R132 decides hosted at start and does not cover this. It is an owner note under I3.
- **Process count.** Every project or worktree directory the person opens starts its own process for each local org connector. That is 1 per project per connector, kept while the location lives. Upstream's guide says a location lives for an hour without session events.
- **A repository can replace an org connector.** A project config that names the same `mittr-…` connector with its own `type` and `url` takes its place in that project. The person then reaches the repository's server under the org connector's name, without the org's headers. R130's held-name check cannot see project layers, and org connector names are predictable.
- **Skill name clashes.** A nested catalog skill shares one id space with the developer's own skills. This is why Task 8 uses the flat `mittr-<name>/` layout.
- **Built-in skills.** The engine ships built-in `opencode` ("OpenCode") and `report` skills, and the model sees both. `report` says it publishes the issue with the GitHub CLI.
