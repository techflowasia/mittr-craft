# Mittr server

`src/mittr/index.js` installs Mittr's account, catalog, shim, and other product routes through the in-process server plugin. Catalog synchronization is owned by `src/mittr/catalog-routes.js`; account-specific persistence is owned by `src/mittr/catalog-cache.js`.

## Account transition boundary

The host may supply `opencode.beforeAccountMutation()`. Mittr auth routes await it before storing a sign-in, activating an account, signing out, repairing the account list or removing an active account after token revocation. Direct account switching also awaits it before activation. A failed drain prevents the mutation. Sign-in cancellation and revoked-refresh ownership are checked again after the await.

The web host's hooks do nothing at present: they belong to its automatic continuation after a length limit, which this build has off. `beforeAccountMutation()` resolves at once without a token, nothing is suspended or drained, and `accountMutationSettled()` and the registered readiness callback have no effect. Mittr keeps its side of the contract for a host that has it on: it registers a stable active user ID and target-home readiness callback without opening stored credentials, and each mutation settles only the token its own `beforeAccountMutation()` returned, in `finally`. Failed storage, repair no-ops and cancelled sign-ins release their own token. Queued reconciliation uses the current active account rather than reactivating a superseded mutation.

## Catalog refresh contract

`POST /api/mittr/catalog/sync` uses the host's existing UI authentication. No body, `{}`, or `{ "force": true }` forces a platform fetch. `{ "force": false }` allows the server to reuse a successfully stored and applied sync for 60 seconds. Freshness is in memory only and belongs to the active account generation. A cached file alone is not evidence of freshness. This endpoint adds no server polling loop.

Success remains HTTP 200 with `{ "bundleVersion": 7 }`. Bundle version is metadata, not a model-list identity: changed aliases are applied even when the version stays the same. Aliases remain opaque platform-issued identifiers.

A failed model or managed-config application returns HTTP 500 with `{ "error": "Cannot apply the Mittr catalog", "bundleVersion": 7, "stored": true, "applied": false }`. The new catalog stays on disk, but the failure does not establish freshness. A subsequent request can retry the same version. The model application must succeed before the remaining catalog application runs.

An omitted or null models collection preserves that account's prior configured models, matching MCP and skills. An explicit `models: []` removes the models. Fetch, refusal, parsing, and storage failures do not replace a usable cache with empty data.

Syncs use the existing serial queue. Waiting requests for the same account generation coalesce; a forced waiter upgrades a waiting automatic request. Automatic requests queued behind a successful sync can reuse its freshness without another platform call. Queued work captures its owner and cannot start against another account. An account change during a fetch may still store the response under its original account, but returns HTTP 409 and does not apply it or mark the current account fresh. A generation fence also covers switching away and back to the same account.

The internal `syncStored()` entrypoint intentionally resolves after durable storage, before application, or when the sync ends without storing. Model-refusal handling depends on this early result. It is not an application-success signal.

## Quota refresh contract

`GET /api/mittr/quota/me` and the Mittr Usage provider share an in-flight platform sample for the active account generation. There is no settled-value cache or new polling loop. Account changes, including switching away and back, fence both session refresh and quota completion. An obsolete raw read answers HTTP 409 with `reasonCode: 'account_changed'`; Usage reports a failed refresh rather than another account's values.

Usage captures the catalog before reading quota. Each catalog alias resolves its chat bucket by explicit `agentStatus[alias].modelKey`, then `lines[].agents[].key` membership, then the direct alias key for older responses. An explicit mapping never falls through to a different bucket. Ambiguous memberships are not guessed. Shared buckets appear once, named with the matching catalog labels. Internal chat lines and image lines stay hidden. Speech lines retain their existing display. The overall weekly value remains the maximum consumption among displayed buckets.

A successful current sample can lift a known speech block when every reported line for that speech kind has positive remaining quota. Missing, malformed, exhausted and failed reads preserve blocks. Each read captures the speech revision before fetching; a refusal received afterwards, even with the same reset time, survives that sample. Recovery uses the existing speech-state long-poll notification.

## Failed request diagnostics

The shim writes one `[mittr] request-failed` JSON record to the existing server logger for failed requests, independently of `MITTRCRAFT_SHIM_LOG`. Successful completions do not produce these records. Existing host log storage and retention apply; no separate file or remote telemetry is added.

Records contain a locally generated UUID, start time and elapsed milliseconds, requested `maxTokens` and `maxCompletionTokens`, upstream `httpStatus`, an allowlisted `finishReason` and failure `outcome`, and numeric `inputTokens`, `outputTokens`, `reasoningTokens` and `cachedInputTokens` when observed. Missing or invalid numbers are null. `usageAvailable` means at least one valid usage count was received, not that all counts are present. Output counts are the upstream completion total, which may include reasoning.

Diagnostics select fields explicitly. They omit chat content, tool data, model and session identifiers, upstream request IDs, headers, credentials, URLs and raw error text. This contract applies to the new structured records, not unrelated pre-existing logs.

The budget is what the engine submitted, not proof of how it calculated that budget or of the gateway's private cap. Output equal to that budget is consistent with exhausting it, not conclusive attribution. The shim still stops at a length finish: usage in a later frame can be unavailable, even when the gateway supplied it. Null usage is insufficient evidence to assign the limit to either side. Diagnostics do not change limits, retries or stream delivery.

## Provider lock placement

The lock (`policies.js`) is written in two places. The managed config file (`OPENCODE_CONFIG`) carries it always. OpenCode 2.3 decides a `provider.use` rule by the first config file that names the provider, and it loads the global engine config folder before `OPENCODE_CONFIG` (order: system folder and macOS managed preferences, the global folder's `opencode.json` then `opencode.jsonc`, `OPENCODE_CONFIG`, project files, `OPENCODE_CONFIG_CONTENT`). An allow in the global `opencode.json` therefore outranked the managed lock; `scripts/mittr/probe-engine-v2.mjs --only P7` shows it on the real engine. So whenever the managed config is built with the switch off, the server also puts the lock (`deny *`, then `allow mittr`) as the last rules of the global `opencode.json`, where the later rule wins inside the file.

With other providers shown, the global file gets no rule: the server takes its lock out of it, and removes `policies` when nothing is left. An allow there would undo the person's own choices in the same file, because Settings > provider on/off writes `disabled_providers` (and `enabled_providers` may be set by hand), which the engine turns into denies placed before `policies`, and it would beat their own `provider.use` denies too. The managed file keeps `allow *`, which ranks below the global file. It still ranks above a project file, so a deny in a project's `opencode.json` has no effect while other providers are shown.

Our rules are removed wherever they are in the list, so another writer that appends rules after them (a skill switched off) never makes locks stack. What counts as ours: each `deny *` directly followed by `allow mittr`, and an `allow *` that no other `provider.use` rule follows, which builds before 24 Nov 2026 wrote. Only rules with exactly the three keys count. A lone `deny *`, a lone `allow mittr`, an `allow *` before the person's other provider rules, and any rule with another key are the person's and stay. A pair or a final `allow *` the person wrote themselves cannot be told apart and is removed; with the switch off the lock takes its place, and with it on the managed file allows every provider.

The global file is touched only when the server's user config is the file the engine reads (`ownsEngineUserConfig`, the same condition as the default model); otherwise the server warns that the global file outranks the lock. When it cannot be read or written, the managed config still goes out, and the provider switch answers 500 with the stored value, as it does when the managed config could not be rewritten; the next config build tries again.

The system folder (`/Library/Application Support/opencode`) and the managed preferences plist (`/Library/Managed Preferences/ai.opencode.managed.plist`) outrank the global folder, but both need an administrator or MDM, and `@opencode/server` 2.3.2 exposes no setting that moves the system folder. Documents that connected integrations and organisation (well-known) sign-ins supply also load before the global folder; this was not probed. An allow written into the global `opencode.json` after the last managed-config build stays effective until the next build rewrites the lock.

## First start on OpenCode 2.3

`engine-upgrade.js` runs before every managed engine start, once per engine data home, so a second account is checked when it first becomes active.

OpenCode 2.3 imports 1.x sessions only in its Bun build: `@opencode/core` 2.3.2 ships a no-op importer for Node, and the desktop's bundled server runs on Node. There, a 1.x database gets an empty `session_v2` and the import is reported as completed. The bundled engine therefore does not start while the database holds 1.x sessions without a 2.x twin and no finished import. MittrCraft 2.1.1 (OpenCode 2.0.22) still imports them, also after 2.3 migrated the database, and the recovery screen tells the person to open it once. A finished import is never refused, because a session deleted in 2.x leaves its 1.x row behind; neither is one that upstream's `v1-migration-topup` reopened, which it marks with a cursor ending in U+FFFF. 1.x sessions made after a finished import stay hidden.

The refusal does not apply to an engine that can import. The server settles which engine it runs before it asks for the engine environment, and names it in `OPENCODE_BINARY` unless it is the bundled server (from `settings.opencodeBinary`, the environment, PATH or a policy). `engine-import.js` counts a native executable or a known npm launcher (`opencode-ai`, `@opencode/cli`) as importing. The bundled `serve.mjs`, any other script, a missing file and an unset `OPENCODE_BINARY` count as not importing, so an unknown engine is refused.

A locked database (`SQLITE_BUSY` or `SQLITE_LOCKED`) is tried again for about two seconds. One that stays locked is refused with `MITTR_ENGINE_DATABASE_BUSY`, because another copy of the app is most likely using it. A database that cannot be read for any other reason is left to the engine, after a first backup. The check opens the database read-only. SQLite then leaves an empty `opencode.db-wal` and an `opencode.db-shm` beside a database in write-ahead-log mode; that is accepted, since removing them could hit a copy of the app that just opened it. `opencode.db` and pending writes never change.

Before a 2.3 start the database and its write-ahead log are copied into their own folder beside them, as a clone where the file system can. The bundled engine gets a copy whenever the database has tables but lacks the newest migration that engine ships (`NEWEST_MIGRATION`, pinned to the installed engine by the upstream contract), so going back to 2.1.1 and upgrading again makes another copy. A standalone engine, whose version and migrations are unknown, gets one copy, the first time. The folder is `opencode/pre-2.3-backup-<time>-<id>`: the time (UTC) the chats were last written and an id of the files' size and time. The same state of the files therefore has one name: a start that failed without changing anything makes no second copy, and a copy another process finished first counts as done. Each process copies into a `.partial-<pid>-<random>` folder and renames it; a partial folder whose process is gone is removed. A copy taken while the files change is taken again. If no copy can be made the engine does not start. Finished backups are never replaced or removed. An early build's `pre-2.3-backup` folder, without a time, is a backup too.

To go back to 2.1.1: quit the app, open the `opencode` folder, choose the `pre-2.3-backup-…` folder to return to (the newest time is the last state before the latest update), delete `opencode.db-wal` and `opencode.db-shm`, copy `opencode.db` from the backup over the one in the folder, and copy `opencode.db-wal` too if the backup has one. Keep the backup folder. Chats made after that backup are not in it.

## Switching to an account the engine would refuse

`POST /api/mittr/auth/accounts/activate` asks `engineUpgrade.check` about the target account's data home before anything changes. When a start there would be refused, it answers 409 `{ "error": "<why>", "code": "MITTR_ENGINE_V1_HISTORY" }` (or `MITTR_ENGINE_DATABASE_BUSY`) and the current account and its engine stay as they are. A sign-in to such an account while another one is active keeps the sign-in, stays on the active account and answers 200 with `switchRefused: { code, message }`. The check makes no backup.

Where the switch goes on and the engine does not come up, the answer carries `engineRestarted: false` and `engineError: { code, message }`, the error of the engine start (`code` is null for an error without one). This covers what the check cannot see, such as a backup that could not be made, and changes with no account left to stay on, such as a sign-out.

With no managed engine running, no account is on target, so the next switch, the way back included, starts the engine. An engine start that failed counts as not running until the next ready, whatever data home the host still reports. An engine that became ready with no launched data home is one MittrCraft does not manage, and counts as on target. Answers stay open while no engine runs; they close only while an engine runs on another account's home.

## Agent task completion guidance

The existing engine identity plugin adds task-completion guidance on normal context and generation hooks, once per prompt. It asks the agent to continue authorized execution rather than finish with a progress-only answer, and to investigate recoverable obstacles before reporting a blocker. It preserves user approval, scope, safety and stop requests. The compaction handler itself does not add this guidance; it does not remove guidance already present in the supplied prompt. The complete engine compaction lifecycle has not been validated for this change.

This is model guidance, not a completion detector or a guarantee that the model will follow it. No automatic continuation request, retry loop, or new background job is added. Existing installations need the updated server bundle and plugin materialization before the instruction can take effect.

## Goal loop guard and checkpoints

The plugin answers goal mode's continuation review (`goalContinuation`) through `src/goal-guard/`. Before each automatic continuation of an active goal it checks the turn that just ended for loop signs, puts a warning in the next continuation on the first such turn and has the goal settled as `blocked` with a readable reason when the turn that warning opened loops again; the existing settlement notification tells the person. It also saves the goal folder's uncommitted changes, new files included, in `refs/mittrcraft/goal/<sessionId>/<n>` without touching files or the index, names the newest checkpoints to the agent, and deletes a session's checkpoints when its goal completes or is cleared. Thresholds, restore steps and what is not covered are in `src/goal-guard/DOCUMENTATION.md`.

## Focused validation

The package test script uses Node's test runner. For catalog work, run:

```sh
node --test packages/mittr-server/src/mittr/catalog-cache.test.js packages/mittr-server/src/mittr/catalog-routes.test.js packages/mittr-server/src/mittr/index.test.js packages/mittr-server/src/mittr/model-refusal.test.js
```

These tests exercise HTTP behavior, account ownership, cache preservation, managed-config writes, and refusal storage ordering. They do not prove a packaged desktop engine's live model discovery or the later UI refresh coordinator.
