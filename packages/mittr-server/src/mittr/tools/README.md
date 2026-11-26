# App-owned tools

`registry.js` owns app tool names and actions. `index.js` registers tools and renders the engine plugin with `plugin-source.js`. The plugin sends calls through the authenticated loopback callback in `callback.js`. The model's input is separate from the engine execution context.

## Code Mode

OpenChamber 2.7.3 dropped its Code Mode setting and always registers its control and web tools behind OpenCode's Code Mode `execute` tool. The MittrCraft tools follow it: `mittrcraft_computer`, `mittrcraft_chrome`, `mittrcraft_work` and `mittrcraft_widgets` are registered with `codemode: true`, each with a namespace named after the tool and described by the first sentence of its description (on engines that have `tools.namespace`, 2.3 and later). `mittrcraft_todo` stays direct (`DIRECT_TOOLS` in `index.js`), for upstream's reason for its render and secret tools: the chat draws the checklist from the tool's own call (`packages/mittr-ui/src/todo/readTodoSnapshot.ts`), and inside an `execute` script that call is only an entry in `execute`'s list. The retired `agentToolsCodeMode` setting is ignored.

Since OpenCode 2.3.0 a tool that returns after `context.signal` aborts has that return recorded as its result. A call whose callback request fails because the turn was stopped therefore rethrows instead of answering with an `ok: false` envelope, as upstream's tools do; so does the capture wrapped around the panel browser tool.

## Conversation checklist

`todo.js` registers `mittrcraft_todo` with `todo.read` and `todo.write`. It is available to signed-in conversations without a settings switch, including when the control tool is off. Only the agent callback may call it. HTTP control and voice cannot read or change checklists.

`todo.write` accepts `todos`, the complete replacement list. Each item has a unique stable `id`, `content`, and a status of `pending`, `in_progress`, `completed`, or `cancelled`. An empty list clears the checklist. Both actions return `{ todos: [...] }`. The existing callback wraps this as `{ schemaVersion: 1, ok: true, action, data: { todos: [...] } }`. The engine plugin keeps this JSON in the tool result's `content`, so each successful call retains its own full historical snapshot.

The callback captures the active account key before any asynchronous lookup and takes the session ID from the engine plugin's execution context, never from tool parameters. The action verifies that the account still matches the active engine home and checks cancellation before touching disk. Model-supplied account or session fields are rejected.

The private store is `<dataDir>/chat-checklists/<account-key>/<sha256(session-id)>.json`, with a versioned snapshot written through `writePrivateAtomic`. Each operation is synchronous through the final atomic rename, with no asynchronous read/write gap. Concurrent whole-list replacements use last committed write wins; no partial list is exposed. Existing unreadable data causes an error and is not overwritten. A failed replacement preserves the previous file and removes its temporary file. Missing files mean an empty checklist. There is no migration from project todos, which remain separate.

A translated `session.deleted` event removes only that session's checklist for the active account while its engine home matches. Disposal or sign-out does not erase durable checklists. No timers or caches belong to this store. The tool describes progress only and never executes checklist content.

Desktop and other clients using the Mittr server use the same engine tool path. A VS Code instance without this server does not offer the tool. Checklists remain local, with snapshots sent to the conversation's configured provider as normal tool results; no new external service or listener is added.

Focused coverage lives in `todo.test.js` and the checklist integration case in `index.test.js`.
