# Superpowers consent domain

This is an unwired server domain, not a shipped activation path. It uses Node built-ins and the workspace's existing Zod parser. It does not discover configuration, start the engine, register skills, expose routes or authenticate a human decision.

## Authority and storage

`createConsentStore({ root, fs? })` requires an absolute, explicitly injected private consent root. The host must provision that root durably before mutations, including syncing its entry in its parent directory. The store never creates the root or its ancestors. A missing root makes mutations unavailable. The host owns this directory and must not let untrusted users replace its directories with symlinks. Runtime and account identifiers are independently SHA-256 namespaced below it. Neither a missing account nor a shared logged-out owner is valid authority.

Store methods are synchronous:

- `read({ accountID, runtimeID })`
- `claimOffer(owner, { sessionID, turnID, expectedRevision })`
- `answerOffer(owner, { sessionID, offerID, decision, expectedRevision })`, with `remember`, `chat` or `decline`
- `setDefault(owner, { enabled, expectedRevision })`
- `deleteSession(owner, { sessionID, expectedRevision })`

Successful results contain `status: 'ok'` and a version 1 `document`. Claim results also contain `outcome: 'claimed' | 'already-claimed' | 'answered'`. Only `claimed` authorizes first display. An outstanding claim can be restored for its owning session from the trusted state read. Another window must not treat `already-claimed` as permission to display a new offer.

Failures are `invalid` with `httpStatus: 400`, `conflict` with `httpStatus: 409`, or `unavailable` with `httpStatus: 503`. They carry no grant. Missing data is initially off/unseen; corrupt, unsupported and unreadable data is unavailable and never repaired automatically. No error includes document contents or filesystem paths.

Each mutation ensures the runtime directory and syncs the root, then ensures the account directory and syncs the runtime directory, before writing consent. Both parent syncs run even when the child entries already exist, so retrying after a failed sync cannot skip their durability. A parent-sync failure returns unavailable before modifying any consent document. Each mutation then exclusively creates `consent.lock` in the account/runtime directory, reads current authority and compares revisions before changing it. Writes use an exclusive private temporary file, file sync, rename and directory sync. The lock serializes processes as well as windows. Lock contention fails closed without retry. A crashed lock is deliberately not stolen on a timer. An administrator must recover it after verifying that no writer remains. Rename failures preserve the old file; a failure after rename can leave a committed decision despite an unavailable response, so a trusted reread is necessary before retrying. No failed response is consent to execute or display.

The claim is committed before returning. It has no expiry. All three answers mark the offer answered; chat-only persists just the owning engine session. Remember enables future root sessions in the same account/runtime. Settings disable revokes every chat grant there. Session deletion removes only that session's grant, without resetting the answered or abandoned claimed offer. Compaction has no consent transition.

## Trusted runtime integration

`createSuperpowersRuntime({ store, resolveOwner, resolveSession })` accepts server-owned dependencies, never model inputs. `resolveOwner()` synchronously returns `{ accountID, runtimeID, generation }` or null. Generation must change on every sign-out, account change and runtime change, including A to B to A. `resolveSession(owner, sessionID)` asynchronously returns a verified `{ sessionID, kind: 'root' | 'child' }` or null in that owner/runtime. The runtime checks the generation before and after lookup, immediately before synchronous store access, and before returning.

The asynchronous methods are `effectiveGrant(sessionID)`, `claimOffer(sessionID, input)`, `answerOffer(sessionID, input)`, `setDefault(input)` and `deleteSession(sessionID, { expectedRevision })`. Session IDs must come from trusted execution or authenticated user context. Inputs must not include account, runtime or session overrides. Deletion runs from an authoritative session-deletion event and does not look up a session already removed.

`effectiveGrant` returns `enabled` or `disabled` with a revision on successful reads. Missing principal/session and child sessions are disabled. Lookup/read failure is unavailable; a superseded generation returns `scope-changed` with `httpStatus: 409`. Grants are read afresh on every call, not cached from history. The caller must recheck current authority at each actual bootstrap/load boundary.

**Child delegation is not implemented.** Until verified parent relationships and execution-only delegation are integrated and tested, children receive neither remembered nor inherited session grants, nor a new offer. A fork is a separate root session and does not inherit a chat-only grant. This restriction does not alter the approved remembered-default policy for future root chats.

Consent mutation methods are internal capabilities. A later adapter must authenticate a human decision, bind account/runtime/session server-side, validate the current user turn for offer suitability, and enforce CSRF/replay protections. Do not expose them as model tools or infer consent from prose/native form settlement alone. Neutral resource loading and session hooks are the feasible Task 1 direction; global `skill.transform` registration is not.

## Coverage and limits

Focused Node tests cover transitions, restart, claimed-offer restoration, revisions, corrupt files, atomic replacement failure, lock contention, account/runtime/session isolation and pending lookup generation fencing. Run each test file only inside the approved OS sandbox with temporary HOME/XDG/data roots and the passing sibling write canary.

There are no new reachable behaviors on web, Electron, VS Code, hosted mobile or Capacitor. No engine, UI, route, bundle, packaging or source-acquisition integration is included here. Human authorization, original-turn resume, child delegation and packaged runtime verification remain separate gates.
