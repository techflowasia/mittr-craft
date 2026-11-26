# Goal guard

Mittr's answer to the goal runtime's continuation review and goal end notice (`goalContinuation` and `goalEnded` on the server plugin, see *Server plugins* in `packages/web/server/DOCUMENTATION.md`). Before goal mode sends a continuation, the guard looks at the turn that just ended, warns the agent or stops the goal when the turn loops, and saves the goal folder's uncommitted work in a git checkpoint.

## Ownership

The guard owns loop signs, the per-goal warning state and the checkpoint refs under `refs/mittrcraft/goal/<sessionId>/<n>`. The goal runtime owns when it is asked, settling the goal and the settlement notification; OpenCode owns the message records the guard reads.

## Invariants

- The guard never changes the person's files, index or stash list. A checkpoint copies the index (keeping its modification time, see below), adds the new untracked files to the copy, runs `git stash create` against it and stores the result with `git update-ref`. Besides that ref, the only writes are the blobs `git add` puts in the object store.
- A turn is every record after the newest `user` record, read newest first in pages of 100, at most 20 pages. A longer turn is judged on what was read.
- The same turn is judged once. A second review of it (a continuation that was dropped) returns the first answer.
- A turn only blocks when the user message that opened it contains the warning the guard gave last, so the warning reached the agent. A review that outlasted the runtime's timeout, or a continuation dropped because the person wrote meanwhile, leaves the next turn opened by other text, and that turn is warned again rather than blocked.
- A resumed goal starts with no warning outstanding and no stalled turns, and the turn that stopped it is not judged again.
- A failed turn read is logged and judges nothing; the HEAD and tree it saw are not kept, so a commit made meanwhile still counts on the next turn. A failed checkpoint is logged and the turn is judged on its own records. The goal goes on either way.
- Only a turn with a `repeat`, `noopEdits` or `failures` sign can block. A `stalled` sign alone warns, every turn it lasts, so a goal that watches CI, researches or works through tools outside the folder is never stopped by it.
- State lives in memory per session, for the newest 200 sessions. A server restart starts every goal's count again.

## Loop signs

Each completed turn of an active goal is checked for four signs (`loop-signs.js`, constants beside them):

| Sign | Fires when |
| --- | --- |
| `repeat` | the same tool with the same input fails the same way `REPEAT_LIMIT` (3) times with no new file state in between |
| `noopEdits` | at least `NOOP_EDIT_LIMIT` (5) edits have equal old and new text, and they are at least `NOOP_EDIT_SHARE` (10%) of the turn's edits |
| `failures` | at least `FAILURE_SHARE` (20%) of the turn's tool calls failed, over at least `FAILURE_MIN_CALLS` (20) calls |
| `stalled` | `STALLED_TURN_LIMIT` (3) turns in a row changed no file and made no commit |

A result is a failure when the call errored, its shell exit code is not 0, or its output reads like a failing run (`FAIL`, `3 failed`, `not ok 1`, `npm ERR!`, `Error: `). A successful call never counts as a repeat, so a CI wait that keeps answering `in_progress` is not one. The result is compared as a digest of the tool's output (or error message) with whitespace collapsed and dates, clock times, durations, UUIDs and hex ids taken out, so a test run that fails the same way in a different time is the same result, and a CI or health check whose answer changes is not.

A new file state is a step whose OpenCode snapshot ends on a tree the turn has not had before. Without snapshots, a successful `edit`, `write`, `multiedit`, `apply_patch` or `patch` counts. For `stalled`, a turn also counts as progress when the goal folder's HEAD or worktree tree differs from the last review.

The first turn with any sign puts a plain warning in the continuation: what the agent repeated, then "change your approach, or stop and report plainly what blocks you". When the next turn, opened by that warning, has a `repeat`, `noopEdits` or `failures` sign, the guard asks the runtime to settle the goal as `blocked` with a reason such as `looping: same command "npx jest lead.spec.ts" 35 times`, cut to 200 characters. A turn with only `stalled` gets a progress reminder that asks the agent to say in its report when it waits on something outside the folder. A turn without a sign clears the warning.

Known limits, from review and not measured: a failing check polled three or more times with the same answer (a health check that keeps answering 503) shows the `repeat` sign. Without OpenCode snapshots (a folder that is not a git work tree, or snapshots switched off), edits made through shell commands such as `sed -i` do not count as a change between repeats.

## Checkpoints

Before each continuation, in a goal folder that is a git work tree with a first commit, the guard records the uncommitted changes, new untracked files included, as a stash-like commit at the next `refs/mittrcraft/goal/<sessionId>/<n>`. New files come from `git ls-files --others --exclude-standard`, so ignored files stay out. Secret-looking names (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*` and the other key files, anything with `credential` or `secret` in its name, `.netrc`, `.npmrc`, `.pgpass`) and single files over 5 MB (`UNTRACKED_FILE_LIMIT_BYTES`) are left out, and the agent's line says how many. Past 2,000 new files (`UNTRACKED_FILE_COUNT_LIMIT`) or 50 MB together, the checkpoint keeps only the tracked changes and the line says the new files were not saved. Names go to `git add` as literal pathspecs, and a file that vanished between listing and adding is dropped and the add tried once more; if that fails too, the checkpoint keeps only the tracked changes and says so. Work identical to the newest checkpoint records nothing new. The newest 20 (`CHECKPOINT_KEEP`) are kept and older refs are deleted. When a goal completes or is cleared, its session's refs are deleted in the folder the guard last saw for it (or the folder the runtime names). The first time a folder is used after the server starts, refs under `refs/mittrcraft/goal/` older than 14 days are deleted there, which also covers sessions the guard no longer remembers. The continuation names the newest three in one line, also when the files have moved on since, and tells the agent to look at one with `git stash show -p` and restore it with `git stash apply` only when work it needs is no longer in the files.

A person restores one from the goal folder:

```sh
git for-each-ref refs/mittrcraft/goal/<sessionId>/      # list
git stash show -p refs/mittrcraft/goal/<sessionId>/7    # look at it
git stash apply refs/mittrcraft/goal/<sessionId>/7      # put it back on top of the current files
```

`git stash apply` merges into the current files and can stop on a conflict, like any stash. A new file comes back staged. Removing all of a session's checkpoints: `git for-each-ref --format='delete %(refname)' refs/mittrcraft/goal/<sessionId>/ | git update-ref --stdin`.

Not covered: ignored, secret-looking and oversized new files, a folder that is not a git work tree or has no commit yet, and a session id with characters outside `[A-Za-z0-9_-]`.

## Decisions

### Why repeats count since the last new file state and not over the whole turn

Measured on 60 local MittrCraft sessions (25 Nov 2026): productive turns of 500–1,000 tool calls run the same test command 15–23 times, each time after real edits. A whole-turn count of three would warn on nearly every long turn and block healthy goals. Counting since the last new snapshot tree keeps tight loops and treats edits that only flip a file back to an earlier state as no progress.

### Why no-op edits need a share and not only a count

Two productive turns had 4 no-op edits among 212 and 373 edits. The looping session of 25 Nov had 5–16 per turn at 12–25% of its edits. A count of 5 together with a 10% share separates them; replaying those sessions through the guard warns on the session of 25 Nov in its second turn and blocks it in its third.

### Why the index copy keeps the index's modification time

Git trusts an index entry whose stat data matches the file unless the entry is as new as the index itself. A fresh copy is newer than every entry, so a same-size edit made in the same second as the last index write looked unchanged and the checkpoint missed it (6 of 40 test runs). With the original time the copy keeps git's own racy-entry check, and 40 of 40 runs pass.

### Why new files go into the index copy and not into `git stash push --include-untracked`

`stash push` changes the person's files and stash list. Adding the new files to the copied index first lets `git stash create` record them as part of a commit a person applies with the stash commands they know, while the real index and files stay as they are. The 5 MB limit keeps recordings and build output that is not ignored out of the object store.

### Why a repeat needs the same result and not only the same call

Polling a CI run or a server that is coming up repeats the call by design, and its changing answer is progress. Comparing a digest of the output with volatile parts taken out keeps the case the guard is for: the 25 Nov jest run failing the same way each time. Replaying the measured sessions gives the same warnings and blocks as before, because none of their blocks rested on a repeat whose answer changed.

### Why a stall only warns

A goal can make real progress without touching the folder: waiting on CI, reading, or working through MCP tools. "No file changed and no commit" is evidence of a stuck agent only next to a sign that it is repeating itself or failing, so on its own it reminds and never blocks.

### Why a block needs a delivered warning

The guard cannot see whether its note went out, but OpenCode stores the continuation as the next turn's opening user message. A warning counts only when that message contains it, so a timeout or a dropped continuation can no longer block a goal that was never warned.
