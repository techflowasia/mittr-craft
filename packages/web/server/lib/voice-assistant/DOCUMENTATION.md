# Voice Assistant module

Runs one spoken turn of the Mittr voice assistant: the Mittr platform decides,
this server acts through the MittrCraft control service. Wire shapes are fixed
by `docs/specs/2026-09-29-mittr-voice-wire.md`.

## Files

- `routes.js` registers `POST /api/voice/turn` (SSE) and `POST /api/voice/end`.
  Both sit behind the same `/api` auth gate and body parser as every other
  local route. The turn route validates the body, aborts the turn when the
  client disconnects, and composes the pieces below; it holds the one voice
  conversation state (the pending site host) across turns until `end`.
- `loop.js` owns `runVoiceTurn`: `POST {brokerBaseUrl}/desktop/voice/step` with
  the desktop session bearer, forwards `text-delta`, runs each `tool-call`
  through `controlService.execute`, appends the result as a `tool` message and
  asks again, until a step returns no tool calls or `voiceStepCap` steps ran.
- `tools.js` builds the three tool schemas from the action definitions in
  `../mittrcraft-control/actions.js` and the parameter schemas and descriptions
  exported by `../agent-tool/runtime.js`, so the voice and the coding agent
  describe every action the same way.
- `context.js` builds the per-turn context string and looks up session, Chrome
  and in-app browser state.

## Tools

Tools are rebuilt every turn from the settings, honouring the same switches as
the coding agent's tools (`agentControlToolEnabled`, `agentWebToolEnabled`,
`agentComputerToolEnabled`, `agentChromeToolEnabled`) plus build availability.
A tool left with no actions is not sent; with none at all the turn ends with
`error not_configured`.

- `mittrcraft`: the agent-exposed control actions plus `jira.get_issue` and
  `plane.get_issue` (`MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS`), control
  switch. `wait` and `timeout` are never offered and are stripped from calls,
  so no call can block the turn on a session.
- `mittrcraft_web`: `browser.*` (web switch), `chrome.*` (Chrome switch and
  `chromeControl.available`), `computer.*` (computer switch and
  `computerControl.available`). Parameters are the union of the agent's
  schemas; a name both use keeps one schema with both descriptions.
- `mittrcraft_voice`: `session.stop`, `session.read_reply` (control switch) and
  `chrome.allow_site` (Chrome switch). These never appear in another tool.

Arguments are `{ action, ...inputs }`; inputs nested in `parameters` are
accepted, but the action is only ever the exact top-level `action` string (a
nested `action` is ignored). An action outside the schema its tool was sent
with is refused as a tool result (`unsupported_action`) and never executed.

## Guards

All refusals are tool results; nothing refused is executed.

- Reads: `session.read_reply`, `session.messages`, `session.status`,
  `session.list`, `chrome.read`, `chrome.snapshot`, `chrome.screenshot`,
  `chrome.do`, `browser.snapshot`, `browser.inspect`, `browser.capture`,
  `computer.screenshot`, `jira.get_issue`, `plane.get_issue`.
- After any read earlier in the turn (including earlier in the same step)
  these are refused with `refused_after_read`: `session.stop`, `session.send`,
  `session.create`, `session.fork`, `schedule.create`, `schedule.run`,
  `schedule.delete`, `schedule.toggle`, `chrome.allow_site`. Page interaction
  (`chrome.click`, `browser.type`, ...) stays allowed. This mirrors the
  platform's rule so text read in a turn cannot start, change or stop work.
- `session.stop` is refused with `confirm_first` unless the conversation holds
  an assistant message before the person's last words.
- `chrome.allow_site` runs only for the host of the last
  `site_approval_required` result in this conversation (`not_requested`
  otherwise). That result carries `host` and an `ask` line telling the model to
  ask "allow <host> for this conversation?" and to call `chrome.allow_site`
  only after a clear spoken yes. The grant is held by the control service for
  the `voice` Chrome session only, is never persisted, and ends on
  `POST /api/voice/end`, which also forgets the pending host.
- At most 20 calls run per step; the rest get `too_many_calls` results.
- Each tool has a deadline equal to the step timeout (120 s); past it the tool
  is aborted and the result is `tool_timeout`.

## Invariants

- A weekly quota refusal from the step, as a `429` or as a streamed frame,
  ends the turn with `error llm_quota_exhausted` carrying `resetsAt`; the
  shape is read by `../mittr-quota/exhausted.js`.
- No Mittr session (or no broker) emits `error not_signed_in` before any
  context lookup or platform call. The session is refreshed before every step;
  losing it mid-turn ends the turn with the same error.
- A tool error is a tool result `{ error, reasonCode }`, never thrown out of the
  turn. `reasonCode` is the control error's `code` when it has one, otherwise
  derived from its status.
- Tool results are JSON with `imageBase64`/`imageMime` removed and are capped
  at 20 000 characters.
- `action running` carries the action's human title, never its arguments.
- The step cap comes from `voiceStepCap` (1–20, default 8). Reaching it ends
  the turn with a sentence naming how many steps ran and the last action, in
  the language of what was said (Thai script: Thai, otherwise English).
- Messages sent to the platform stay within 60 messages and 200 000 characters,
  counting tool call arguments. Over the size limit the oldest tool results of
  this turn become `[result omitted]` first, then the oldest history is
  dropped. The current utterance and this turn's calls and results are never
  split, so every `tool` message follows the assistant message carrying its
  call; a turn that cannot fit ends with the closing sentence.
- Only what the person said is ever a `user` message.
- Abort (client disconnect) cancels the in-flight step request and the running
  tool's signal; results of a tool still running are dropped and no further
  step is taken. Nothing is emitted after abort. A Chrome page that finished
  opening meanwhile is still recorded for the context.
- Nothing logged contains what was said, tool arguments or tool results; logs
  carry HTTP statuses and error names only.

## Busy sessions and the message queue

OpenCode cannot take new input mid-turn, and the renderer's
`messageQueueStore` is the one owner of prompts waiting for a busy session. The
server does not hold or dispatch queued prompts itself.

`session.send` is checked first with the session's live status (resolved from
the global session list, so a session in another worktree is checked in its own
directory):

- `busy` or `retry`: nothing is dispatched. The turn stream emits
  `{ "type": "queue", "sessionId", "directory", "text" }` to the client that
  owns this turn, and the tool result is `{ queued: true, sessionId }`. The
  client adds `text` to `messageQueueStore` for that target (capturing the send
  configuration at queue time, as the composer does), and
  `useQueuedMessageAutoSend` delivers it when the session goes idle. Emitting on
  the turn stream, not the shared event stream, keeps one queued entry per
  spoken request even with several windows connected.
- `unknown` (the status lookup failed): nothing is dispatched and the tool
  result is an error (`reasonCode: status_unavailable`), because a failed
  lookup is not proof the session is idle.
- anything else: dispatched through the control service as usual.

## Context

One string, at most 8 000 characters, four lines: project and directory; the
open session (id, directory, title, status, todo done/total, whether a
permission request is waiting, queued prompt count when the client sends
`queuedPrompts`); the voice Chrome page (URL and title, only when its host is
allowed for the `voice` session, otherwise "a page on a site not yet
allowed"); whether a client able to drive the in-app browser is connected.
Every supplied string (titles, labels, paths, URLs) has whitespace and control
characters collapsed, is clipped, and is JSON-quoted; titles are labelled as
page- or session-supplied data, so no title can add a line. A lookup that fails
is reported as unknown, never as empty. Message text, page text, todo text,
permission details, file content and tool results are never included.

The Chrome page is read only after this server opened a page in the voice
session, so building context never launches Chrome.
