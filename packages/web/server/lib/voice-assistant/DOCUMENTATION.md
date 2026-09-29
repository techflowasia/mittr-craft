# Voice Assistant module

Runs one spoken turn of the Mittr voice assistant: the Mittr platform decides,
this server acts through the MittrCraft control service. Wire shapes are fixed
by `docs/specs/2026-09-29-mittr-voice-wire.md`.

## Files

- `routes.js` registers `POST /api/voice/turn` (SSE). It sits behind the same
  `/api` auth gate as every other local route, validates the body, aborts the
  turn when the client disconnects, and composes the pieces below.
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

- `mittrcraft`: the agent-exposed control actions plus `jira.get_issue` and
  `plane.get_issue` (`MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS`).
- `mittrcraft_web`: `browser.*` always; `chrome.*` only when the Chrome tool is
  bundled (`chromeControl.available`); `computer.*` only when the desktop driver
  is available (`computerControl.available`). Parameters are the union of the
  agent's web, Chrome and computer schemas; a name both use keeps one schema
  with both descriptions.
- `mittrcraft_voice`: `session.stop` and `session.read_reply` only. These never
  appear in another tool.

Arguments are `{ action, ...inputs }`; inputs nested in a `parameters` object
are accepted too, as the agent tool does. A call whose action is not in the
schema its tool was offered with is refused as a tool result
(`reasonCode: unsupported_action`) and never executed.

## Invariants

- No Mittr session (or no broker) emits `error not_signed_in` before any
  context lookup or platform call.
- A tool error is a tool result `{ error, reasonCode }`, never thrown out of the
  turn. `reasonCode` is the control error's `code` when it has one
  (`site_approval_required`, `site_moved`), otherwise derived from its status.
- Tool results are JSON with `imageBase64`/`imageMime` removed and are capped
  at 20 000 characters.
- `action running` carries the action's human title, never its arguments.
- The step cap comes from `voiceStepCap` (1–20, default 8). Reaching it ends
  the turn with a sentence, in the turn's locale, naming how many steps ran and
  the last action.
- Messages sent to the platform stay within 60 messages and 200 000 characters
  by dropping the oldest history; the current utterance and this turn's tool
  exchange are never dropped.
- Abort (client disconnect) cancels the in-flight step request and the running
  tool's signal; results of a tool still running are dropped and no further
  step is taken. Nothing is emitted after abort.
- Nothing logged contains what was said, tool arguments or tool results; logs
  carry HTTP statuses and error names only.
- Chrome actions run in one Chrome session owned by the voice
  (`VOICE_CHROME_SESSION_ID = 'voice'`). Site approvals are therefore scoped to
  that session; a site not yet allowed returns `site_approval_required` for the
  assistant to tell the person.

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

One string, at most 8 000 characters: project and directory; the open session
(title, id, status, todo done/total, whether a permission request is waiting,
queued prompt count when the client sends `queuedPrompts`); the voice Chrome
page (title and URL only); whether a client able to drive the in-app browser is
connected. A lookup that fails is reported as unknown, never as empty. Message
text, page text, todo text, permission details, file content and tool results
are never included.

The Chrome page is read only after this server opened a page in the voice
session, so building context never launches Chrome.
