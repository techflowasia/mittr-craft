# Response length recovery

## Status: off

`responseRecoveryActivationVerified` in `server/runtime.ts` is `false`, so nothing in this module runs in the app. `server/runtime.ts` then creates no owner: the proxy and the base routes mount no recovery middleware, every sender uses plain `fetch`, no reservation or fence is ever consulted, no event is read, an engine restart and an account mutation wait for nothing, shutdown drains nothing, and `response-recovery.json` is neither read nor written, so a journal left by a build that had it on cannot reserve or interrupt a chat. The plugin context still carries `beforeAccountMutation`, `accountMutationSettled` and `registerRecoveryAccount`; they do nothing. `off.test.js` starts the real server against a fake engine and holds this: it fails as soon as the constant is `true`. A reply that stops at the response limit shows its error and the person's own Retry.

The rest of this document describes the dormant code as it would behave when on. "Production", "the server" and "supplied" below mean that composition, not the app that ships.

### What must be fixed before turning it on

A review of the composed gate found that it can lock the whole app until it is relaunched, so it stays off until each of these is fixed and proven against the real server:

1. **Permanent fences.** One uncertain POST (a 5xx, a 408, a refused or reset connection, a client that gave up) adds the session to `fenced` and nothing ever removes it. Every later send to that session answers 409, and every engine restart and account switch rejects.
2. **The `'*'` ticket covers unrelated paths.** Any mutation whose path does not start with `/api/session/<id>` takes the global ticket, so one uncertain response on an unrelated route fences every chat.
3. **`/api/experimental/session/:id/wait`.** A worktree scheduled task holds this POST open as long as the run lasts. It takes the `'*'` ticket, makes other sends wait and, at 120 seconds, fences everything.
4. **MCP OAuth start routes never finish the ticket.** `registerStartRoutes` can answer the request itself, after the gate has opened its ticket. The proxy's `proxyRes` never runs, so the ticket expires into a `'*'` fence 120 seconds later.
5. **One 120-second deadline covers the whole continuation.** Admission and the full generated reply share it, and `fenced = !drained` then treats a long but healthy continuation as uncertain and fences the session.
6. **`event-gap` interrupts healthy runs on OpenCode 2.3.2.** A durable sequence number is missing on the wire before `session.renamed`, so a run that is fine is treated as ambiguous and interrupted; 1 of the 3 isolated engine cases in `engine.test.js` fails on 2.3.2 for this reason.
7. **The drain runs first on quit.** Shutdown waits for it before the cleanup steps that follow, so an uncertain or slow drain delays quitting.
8. **Senders added in OpenChamber 2.7.3 bypass the gate.** Auto-review, workflows, extension services and the other new senders reach the engine without a ticket, so a drain proves less than it claims.

`error.ts` matches only structured JSON `error.code === "response_length_limit"` inside `response.body`. It does not classify text mentions or a generic token-limit finish as this provider error.

## Runtime contract

`createSessionResponseRecoveryRuntime` accepts:

- `store`, created with `createResponseRecoveryStore({ filePath })`.
- `client()`, an installed `OpenCode.make` client bound to the captured upstream and existing auth. No feature-local fetch transport is created.
- `getIdentity()`, synchronous `{ owner, generation, account }`. Owner is a durable upstream namespace. Generation and account must invalidate pending work before upstream or account mutation.
- `readGuard(sessionID, directory, { signal }, capturedClient)`,  authoritative `{ known: true, archived: false, deleted: false, liveChildren: false }`. Unknown and failed reads refuse admission. Successful session lookup proves existence; deletion events cancel pending work.
- Optional `broadcast({ revision, entry })` and fixed-deadline timer seams.

Returned methods are `processEvent`, `isReserved`, `cancelSession`, `cancelAll`, `snapshot`, and async `stop`. `processEvent` takes raw v2 events and reserves synchronously. Call it before other automatic senders. A step failure waits for terminal execution failure before fresh idle checks. A terminal event resolves the latest failed assistant from fresh history. Both paths require the exact structured body.

The runtime owns one consumed recovery per original human, independently of UI mounts: a window opening or closing neither starts nor repeats a recovery. It consumes the original human's allowance durably before prompt admission. It sends a short continuation instruction, never the original prompt. It does not call compaction, restore pinned context, change the model or increase token limits. Own continuation IDs come from the journal, not text or caller-controlled metadata. A second failure cannot consume another allowance for that original human.

The result waiter is armed before mutation and carries a no-op rejection handler, because admission can fail before anything awaits the waiter; the awaiting path still observes the rejection. One fixed 120-second deadline covers admission and result settlement. Durable sequence gaps, reversed unknown events, conflicting starts and mismatched delivery fail closed. An exact replay of an event already seen is harmless and returns the existing work; a reversed or unknown event is ambiguous and rejects the waiter. Success requires execution start, exact inbox delivery and terminal success; HTTP admission alone does not settle it. Uncertain admission gets best-effort inbox cancellation and interruption on the captured client, never the current upstream after a switch, and is never retried. Aborting the request stops only the local SDK call and is not an upstream fence, so a positive admission response still needs cleanup after admission. Cleanup makes at most one post-admission pass, with no retries and no loop; a drain that times out may finish later but never releases an uncertain fence.

Cancellation aborts local waits immediately, then attempts captured inbox cancellation and interruption. It cannot undo already-executed work. An in-memory cancelled-turn tombstone rejects a late terminal failure until delivery of another input. Shutdown cancels work, drains cleanup and attempts to flush the journal within a separate 120-second deadline. A journal-flush timeout permanently invalidates the store and rejects stop. Host teardown logs a fixed warning and continues, without claiming persistence succeeded.

## Server composition helper

`owner.ts` hashes the upstream namespace, which names the upstream and never its credentials, together with `account()`, a stable account key supplied by server composition. The default account is only suitable for a single-account upstream. Generation invalidates pending work but is never used as durable account identity. Reused session IDs in different accounts have separate allowances; switching back and restarting preserves consumption. Account changes discard obsolete in-memory session state only after captured work drains. Same-account invalidation retains stopped-turn tombstones.

Guard reads use the transaction's captured client. Archive authority requires `load()` to return both `ok: true` and `authoritative: true`. The captured store's awaited `getAll()` supplies current overrides, not the cached initial-load snapshot: a number archives, explicit null restores, and no entry preserves the upstream archive timestamp supplied by the runtime. Corrupt-file recovery is non-authoritative even if quarantine succeeds; recovery refuses it without changing other archive consumers' empty-recovery behavior. The runtime wraps the complete guard in its cancellation and identity check before accepting the result. Every child page carries `parentID` and the SDK cursor; child and message parsers accept the engine's terminal `next: null`. The owner also supplies archive-load gating and generation invalidation. `beforeRequest` cancels synchronously before yielding to session mutation routing. When on, it must be installed after authentication but before prompt rewriting and every applicable mutation route; the server frame's bootstrap installs it after the auth middleware so that unauthenticated requests never trigger cancellation, routing or proxy admission. `suspend()` closes recovery admission synchronously and drains invalidated transactions; `resume()` reopens admission after composition has established a ready upstream and stable account. Production supplies these helpers. Resume waits for the entire transition drain. Failed drains keep admission closed.

The queue and goal runtimes accept an optional `responseRecovery` owner. Queue enqueue cancels pending recovery; dispatch checks reservations both at tick entry and before each upstream mutation. Goal checks reservations at tick entry, before accounting and immediately before prompt dispatch. Structured provider errors already block the goal rather than granting an extra retry. Production supplies both dependencies and the shared admission transport.

### Admission and account composition

The authenticated request scope captures its admission generation before route awaits. The generic proxy preserves it through readiness waits and path canonicalization. Before forwarding a mutation it captures the upstream target and auth headers, opens an admission ticket, and tracks the upstream response through complete body receipt. Truncation, transport failure, server error or a 120-second deadline leaves sticky uncertainty. Aborting a socket does not prove upstream cancellation. Tickets abort outstanding local transport on timeout, release drain waiters and reject the drain. Host shutdown still continues teardown on rejection.

The generic proxy covers session prompt, command, skill, shell, synthetic, inbox, interrupt, compact, model, agent, move, revert and deletion routes, plus credential and integration mutations. App-owned alternate senders are explicit session send/archive services, message queue, goals, dispatch-result delivery, context obligations and scheduled task session creation/context/command/prompt. Those senders share the gate or captured SDK transport. Global mutations use a conservative global ticket. Reads do not acquire tickets.

`transitions.ts` gives each account mutation its own token. Readiness and another mutation cannot settle that token. Auth routes settle in `finally`, including failed storage, cancelled sign-in, repair no-op/failure, revocation and retry-switch. Failed drains remain closed. Queued account reconciliation reads the current active account at execution rather than reactivating a superseded request. Engine and cache target readiness still gate reopening.

The durable namespace hashes the managed engine data home or normalized external endpoint with the stable account ID. Endpoints and credentials are not logged or journaled. Generation fences old work but does not reset allowances. Readiness notification covers managed start, external re-probe, external bootstrap and healthy HMR reuse. External bootstrap owns one notification after its final authoritative readiness check, for both skip-start and auto-detected attachment. It does not infer external notification eligibility from a null process handle: HMR can retain a stale managed handle during external attachment. The generic waiter suppresses its own notification for that bootstrap check to avoid duplicate callbacks. Branch tests start with a suspended real recovery owner and verify that bootstrap reopens admission, with and without a stale handle. These tests do not establish full-server continuation acceptance; that requires an independent structured-length failure run.

The isolated V2.0.22 test compares raw SSE durable sequences with the SDK projection. Both contain the same gap on successful provider output. The missing sequence is already absent on the wire, not dropped by application event filtering. Settlement remains fail-closed on that gap. Exactly one continuation and terminal engine success are verified separately; provider success is not claimed as verified recovery settlement. No authoritative success shortcut was added.

Direct-engine clients remain outside application admission coordination. Fresh inbox reads and raw events observe their inputs, but there is no atomic exclusion between the final read and continuation admission for those external clients.

Authenticated POST session `interrupt` and `abort` are safety actions, not new work. The owner starts recovery cancellation synchronously and forwards Stop without awaiting cleanup or ordinary admissions. The generic proxy bypasses admission reservation, suspension and uncertainty checks for these exact Stop routes only. Existing admission tickets remain tracked and an uncertain fence stays set, even if Stop succeeds. New prompts still await cancellation and drain, then recheck reservations before routing.

After awaiting cancellation, middleware and archive, explicit-send and queue services recheck `isReserved`. An uncertain admission or cleanup leaves a sticky in-memory fence. Middleware answers HTTP 409, and account transition drains reject. Do not recreate the owner to bypass a fence while the same upstream might still admit the pending request. An ordinary account separation test must use known admission and terminal evidence, not simulate an unknown transport outcome and expect its fence to disappear.

## Journal

Version 1 stores IDs, owner/generation, consumed original human, phase and bounded reason codes only. It stores no error bodies, prompts, credentials or account values. Serialized writes use a same-directory temporary file, fsync and atomic rename. Only a missing file is empty. Invalid data and read/write uncertainty disable admission for the process, and a flush that times out counts as durability uncertainty even if its I/O finishes later. Unfinished entries become `interrupted` on restart and are persisted before the store is returned. No mutation resumes on restart.

Older version-1 entries with `compactID`, `compacting` or `continuing` remain readable and consume their allowance. New entries omit `compactID`; no new compaction is dispatched. Cancellation and uncertain responses never restore the allowance. Entries have no timer eviction. `deleteSession(owner, sessionID)` is reserved for authoritative deletion.

## Runtime coverage

While it is off, every runtime keeps normal error display and manual Retry, as extension-only VS Code always does. When on, Web, Electron, hosted mobile and Capacitor would share the server's owner. The module sends only through the existing session provider, opens no listener and adds no external destination.

## Verification

`off.test.js` proves the app runs without it. The other suites cover the dormant code. Run `bun run --cwd packages/web test server/lib/session-response-recovery server/lib/message-queue server/lib/session-goal server/lib/dispatch-results server/lib/context-obligatory server/lib/opencode/lifecycle.test.js server/lib/server-frame/shutdown-runtime.test.js`. Set `RESPONSE_RECOVERY_TEST_ENGINE` to a V2 executable to include the three isolated-engine cases; otherwise those cases are skipped. The fixture tests cover request serialization, authenticated Stop before admission, fresh guard reads, captured clients, account separation across owner recreation, no compaction and a second structured failure without another prompt. Runtime tests cover duplicate events, uncertain admissions, cancellation across awaited reads, owner/configuration changes, deadlines and consumed allowances. Full server composition and platform validation are still required.
