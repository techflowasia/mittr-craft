# Phase 1: how OpenCode 2 carries 1.x sessions

Date: 2026-10-16. Script: `scripts/mittr/prove-session-carryover.mjs`.

## What was run

- Engine: the binary `bun run --cwd packages/electron prepare:opencode-cli` stages from upstream v2.1.1. It reports `opencode v2.0.22`. That matches `opencodeCli.version` and the `@opencode/client` pins in this base. The plan says 2.0.23, but upstream 2.1.1 pins 2.0.22. Every number below is from 2.0.22.
- 1.x engine today: MittrCraft 1.22, bundled OpenCode `1.18.18`.
- Sources, untouched: by default the script copies each `opencode*.db` byte for byte together with its `-wal` and `-shm` into a temp `HOME` under `$TMPDIR`, and keeps their mtimes. SQLite never opens a source file. The script reads each trio's size and mtime before and after the copy and retries if the running app wrote in between. Every count and the engine run use only the copies.
  - The numbers below are from this mode.
  - `stat` (size and mtime) of all 18 real `opencode*.db*` files was identical before and after the runs, and `shasum` of every file except the 574 MB prod `opencode.db` was identical too.
  - An earlier run used `VACUUM INTO` from a read-only SQLite open of the source. That changed the mtime of the idle sources' `-shm`, so it is now only the opt-in `--snapshot` mode.
- Each run started `opencode serve` against the copy:
  - all four XDG bases inside the temp `HOME`;
  - prod layout: four bases; Dev layout: one root (`--one-root`);
  - a random free port (never 57123/57133) and a random password;
  - no inherited shell env, no `auth.json` or config copied.

  The script then waited for `GET /api/info` and for `kv['migration.v1-v2']` to read `completed`. It paged `GET /api/session` with `x-opencode-directory` to the end of the cursor and killed the engine. Which file the engine opened comes from `lsof` on the engine pid and the mtime change.

## Which file holds the live 1.x sessions

`opencode.db`, in both layouts. The running 1.18.18 engines of the installed app hold `~/.local/share/mittrcraft/engine/opencode/opencode.db` (+`-wal`/`-shm`) open (`lsof`). Their env sets only the four `XDG_*` bases; there is no `OPENCODE_DB`. The newest `session.time_updated` is in `opencode.db` in both dirs.

`opencode-.db` and `opencode-mittr-desktop.db` are leftovers of older channel-named engine builds. 1.22's `migrateEngineHome` carried them from the shared `~/.local/share/opencode`. 1.18.18 does not open them, so their sessions are already invisible in 1.22.

2.0.22 picks its database the same way. From the binary: `OPENCODE_DB ?? (channel in latest/dev/beta/next/prod ? "opencode.db" : "opencode-<channel>.db")`, resolved against `<XDG_DATA_HOME>/opencode`. The channel of the npm build is `latest`.

## Does 2.0.22 migrate it with no help?

Yes. With `OPENCODE_DB` unset, it opens `<XDG_DATA_HOME>/opencode/opencode.db` and runs its own V1→V2 import in place:

- it copies `session` into `session_v2` and `message`/`part` into `session_message`;
- it writes `{"phase":"completed"}` before `/api/info` answers;
- it takes about 2 s on the 574 MB prod copy;
- it leaves the 1.x tables untouched (`session`/`message` counts are unchanged afterwards);
- it never opens or changes the other two files.

`OPENCODE_DB` is honoured exactly:

- `OPENCODE_DB=opencode-mittr-desktop.db` migrates only that file, and the API then lists its 2 sessions, not the 18.
- A pre-start copy plus env (`--copy-as opencode.db:opencode-copy.db --db opencode-copy.db`) migrates the copy with the same 18/18.
- `OPENCODE_DB=opencode.db` gives the same result as unset, in both layouts.

Neither is needed.

## Counts

"v1∉v2" means 1.x sessions in the opened file that have no `session_v2` row after the migration.

| Layout | File | 1.x sessions (root) | 1.x messages | after: `session_v2` (root) | v1∉v2 | API `/api/session` |
|---|---|---|---|---|---|---|
| Dev (`~/.config/mittrcraft-dev/engine/opencode`, one root) | `opencode.db` | 18 (16) | 168 | 18 (16) | 0 | 18 (16 with `parentID=null`) |
| | `opencode-mittr-desktop.db` | 2 (2) | 0 | not opened | – | – |
| | `opencode-.db` | 0 | 0 | not opened | – | – |
| prod (`~/.local/share/mittrcraft/engine/opencode`, four bases) | `opencode.db` | 236 (210) | 3425 | 236 (210) | 0 | 236 (210 with `parentID=null`) |
| | `opencode-mittr-desktop.db` | 2 (2) | 0 | not opened | – | – |
| | `opencode-.db` | 0 | 0 | not opened | – | – |
| account dir | none exists | – | – | – | – | – |

On the account dir:

- The only prod account has `home: null`, and Dev has no `mittr-accounts`.
- The `--account-dir` path was exercised on a synthetic `accounts/0123456789abcdef` built from a Dev copy. The engine ran with data and state under the account, opened only `accounts/<home>/opencode/opencode.db`, and migrated 18/18.
- The shared `opencode.db` is not visible to that engine. Each account home is its own migration.

The global session list needed no per-project fan-out: one paged `GET /api/session` returned every session, children included.

Message carry-over, per session. The script compares each session's 1.x messages by `role` with its 2.x `session_message` entries by `type`. 2.x adds `system` and `synthetic` entries, which are not compared.

- Dev: all 17 sessions with messages match. 22 user + 146 assistant became 22 `user` + 146 `assistant`. 2.x added 14 `system` and 9 `synthetic`.
- prod: 233 of the 234 sessions with messages match exactly. Totals went from 278 user + 3147 assistant to 277 `user` + 3146 `assistant` + 1 `compaction`. 2.x added 105 `system` and 4 `synthetic`.
- The one prod session that differs is `ses_f38c2c4baffeHsM3apJk7BDiaX`.
  - 1.x: 8 user and 921 assistant messages. One user message carries a `compaction` part; one assistant message is its `summary: true` reply.
  - 2.x: 7 `user`, 920 `assistant` and 1 `compaction`. OpenCode's V1 transform turns that pair into the single `compaction` entry.
  - The entry's `summary` holds the reply's text in full: 6988 characters in 1.x, 6988 in 2.x.
  - The script reports it as "compaction pair x1" and finds 0 unexplained differences.
- No message is dropped.

Three samples per layout (1.x `message` → 2.x `session_message` → API `/api/session/{id}/message`, paged):

| Layout | Session | Why | 1.x message (part) | 2.x session_message | API |
|---|---|---|---|---|---|
| prod | `ses_f38c2c4baffeHsM3apJk7BDiaX` | most messages | 929 (3096) | 929: 920 assistant, 7 user, 1 compaction, 1 system | 929 |
| prod | `ses_ec1cba6a6ffeRx7mTgUvPZh8z0` | newest | 2 (4) | 2 | 2 |
| prod | `ses_f71ccfac3ffeICX2FuG6WmDH0X` | oldest | 2 (4) | 2 | 2 |
| Dev | `ses_f22f4eb78ffeTKJ1wlzJmY5dXn` | most messages | 20 (69) | 22: 18 assistant, 2 user, 1 synthetic, 1 system | 22 |
| Dev | `ses_f0502384bffew3UGb299mpGweb` | newest | 7 (19) | 8: 6 assistant, 1 user, 1 system | 8 |
| Dev | `ses_f0500f01affenmVqHuPHvf69hT` | a subagent session | 4 (14) | 5: 3 assistant, 1 user, 1 system | 5 |

## Not carried, and why that is not a loss

`opencode-mittr-desktop.db` holds the same 2 sessions in both dirs:

- `ses_000160435ffeofnouJEPssuZxB` and `ses_ffb06b4a2ffejLgJc6aLiNEVid`;
- both titled "New session - …", from 2026-08-14/15, in a `test` directory;
- 0 messages each.

They are not in `opencode.db`, and 1.22 does not show them today. Bringing them over would need a merge of two databases, which neither `OPENCODE_DB` nor a copy can do. They carry no content. Every session a 1.22 user can see today (Dev 18/18, prod 236/236), and every message in it, reaches 2.x.

## For Task 6 to keep in mind

- The engine env must win over the shell. The managed env is merged last (`{...shellEnv, ...process.env, ...managedEnv}`). A user's own `OPENCODE_DB` or `XDG_DATA_HOME` in the shell would otherwise point 2.x at another file. Setting `OPENCODE_DB=opencode.db` explicitly blocks a shell `OPENCODE_DB`, and it was proven to give the identical result.
- `v1-migration-topup.js` must resolve `<XDG_DATA_HOME>/opencode/` + `OPENCODE_DB` from the engine env (Task 6 hook). Today it hard-codes `~/.local/share/opencode/opencode.db`, a real dir outside MittrCraft.
- `git/service.js` `getOpenCodeDataPath()` reads the server's own `process.env.XDG_DATA_HOME` for managed worktrees (`<XDG_DATA_HOME>/opencode/worktree/…`). The engine env alone does not move that. Without a hook, OpenChamber worktrees land in `~/.local/share/opencode/worktree`, which this programme must never write.
- Migration is per database file. Each `accounts/<home>` needs one engine start against its own data dir (§7).
- The 2.x schema migrations write into `opencode.db`. Going back to 1.22 after a 2.x start is a restore from `.pre-2x-backup`, not a downgrade. Opening a 2.x-migrated file with 1.18.18 was not tested.

## Rule for Task 6

Keep the engine on the existing 1.22 database file and let OpenCode migrate it in place. `engineEnv` sets the same four bases 1.22 sets:

- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`;
- prod: `~/.config/mittrcraft/engine`, `~/.local/share/mittrcraft/engine`, `~/.local/state/mittrcraft/engine` and `~/.cache/mittrcraft/engine`;
- Dev: all four on `MITTRCRAFT_ENGINE_HOME` = `~/.config/mittrcraft-dev/engine`;
- with an account home, data and state go under `accounts/<16-hex>`.

It also sets `OPENCODE_DB=opencode.db`, merged after the shell and `process.env`. Nothing is copied or renamed before the start. The legacy `opencode-.db` and `opencode-mittr-desktop.db` are left in place, untouched; they are in the one-time `.pre-2x-backup` like everything else. The V1 top-up then reads `<XDG_DATA_HOME>/opencode/opencode.db` from that same env.
