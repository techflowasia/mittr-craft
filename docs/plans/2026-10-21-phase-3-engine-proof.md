# Phase 3: how OpenCode 2.0.22 finds catalog skills and runs catalog connectors

Date: 2026-10-21. Script: `node scripts/mittr/probe-engine-v2.mjs --only skills-mcp --json <out>`. Engine: the bundled `packages/electron/resources/opencode-cli/opencode`, which reports `opencode v2.0.22`. The numbers below are from the last full run. The timing notes count the eleven full runs made once the probe could drive the engine's Code Mode. The probe's JSON output is kept outside the repository; it holds no token.

## The short answer

- Catalog skills reach the engine in both layouts, nested `skills/mittr/<name>/` and flat `skills/mittr-<name>/`. A new skill shows up within about 0.3 s, with no restart. **Task 8 keeps its planned `mittr/` folder and needs no refresh after a change.**
- A connector in the managed config file connects within about 0.3 s. Its tool runs once when asked, and it stops within about 0.3 s when the entry is removed, all with no restart.
- **Settings → MCP does not list a connector that lives only in the managed file.** P10b failed, as preflight finding 14 expected. **Task 9 therefore takes the user-config path as its main path:** org entries are written through `context.opencode.userConfig` and reconciled per account before each restart.
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
- **Settings → MCP has no read-only state.** `McpGrid.tsx` gives every card a Delete action, and `McpPage.tsx` edits every listed entry. So a user-config org entry, which is Task 9's main path now, will show as an ordinary editable connector.

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

## Outbound connections

There were none.

- The engine's HTTP(S) proxy pointed at the probe's loopback recording proxy, which saw 0 attempts.
- `lsof` was sampled every 250 ms, 24 samples, over the engine and its 4 stub children. It saw no non-loopback remote.
- The engine log names no non-loopback host.
- Port 57133 was not listening, and the probe never contacts it. Before the engine started, the probe checked that nothing else was listening on the loopback port it had picked.

The run itself has no egress control. The recording proxy was shown to catch egress by phase 2's `proxy-control` scenario.

## Clean-up

- Every engine runs in its own process group and was stopped by group.
- Each stub process carries a random marker. After the run, `pgrep -f stub-mcp-server.*<marker>` found nothing, and the probe had nothing to kill.
- The temp HOME was deleted.

## Stop conditions and what Tasks 8 and 9 must do

None of the plan's Task 6 stop conditions stops the phase.

- **P8 passed in both layouts.** No stop, and no switch to the flat layout. Task 8 writes `<skills>/mittr/<name>/`, as planned.
  - The engine id is `<name>`, not `mittr/<name>`.
  - A catalog skill whose name equals one of the developer's own skills may be hidden by it, as the clash case showed.
  - The frontmatter `name:` does not have to equal the folder name.
- **P9 passed.** Task 8 does not call `context.opencode.refresh('mittr catalog skills changed')` after a change.
- **P10 passed, but P10b failed.** The plan's rule for "P10 or P10b fails" applies, and so does preflight finding 14's ruling. **Task 9 takes the user-config path as its main path:**
  - org entries are written through `context.opencode.userConfig` and reconciled per account before each restart;
  - owned names are recorded in `<dataDir>/mittr-mcp-owned.json` (finding 15);
  - Task 17 checks a catalog connector as a user entry in Settings → MCP.
  - The managed-file path works for the engine. It is not enough, because Settings → MCP would not list the connector.
- **P11 gave one process per project.** No owner note is due under the plan's rule.
- **P12 passed.** Removing an entry stops its processes with no restart.
- **Outbound.** There is no host to record for the owner.

## Owner notes

- **Code Mode.** OpenCode 2.0.22 offers MCP tools only through `execute`. A model that does not use Code Mode well will not reach catalog connector tools. This was not measured with a real model.
- **First turn after a change.** About 0.5 s after a connector was added, 4 of 11 turns did not see its tool yet. About 0.5 s after one was removed, 1 of 11 turns still saw it. A person who sends a message the instant a connector arrives or leaves may get one turn with the old tool list.
- **Settings → MCP shows org connectors as editable.** On Task 9's user-config path, an org connector looks like the person's own: it can be edited or deleted. The next reconcile puts it back. The page has no read-only state to say otherwise.
- **Process count.** Every project or worktree directory the person opens starts its own process for each local org connector. That is 1 per project per connector, kept while the location lives. Upstream's guide says a location lives for an hour without session events.
- **Skill name clashes.** A nested catalog skill shares one id space with the developer's own skills.
