# Mittr goal: work until the job is really done

Status: implemented on `feat/mittr-goal` (MittrCraft) and `feat/mittr-goal` (Mittr platform); not released
Date: 2026-09-26

## 1. Context

The problem Mittr goal solves: an agent stops before the job is finished, and
often says it is finished when it is not. From an analysis of CLI coding-agent
trajectories ([arXiv 2607.09510](https://arxiv.org/pdf/2607.09510)):

- 71% of successful runs hit at least one error; what separates them from
  failed runs is acting on error signals (92% vs 37%).
- 26% of failed runs fabricate success — a claim with fake evidence — and 84% of
  that fabrication starts at or after the step where the failure locked in.
- 28% of failures never surface an observable signal at all.

Prior art:

- A `/goal` command in a widely used commercial coding agent: after every turn a separate small model reads the
  transcript and answers yes/no against the person's condition; "no" starts
  another turn with the reason as guidance. The evaluator runs nothing itself,
  so it judges only what the working agent chose to surface.
- MittrCraft already has a session goal loop (`packages/web/server/lib/session-goal`)
  with the same shape: server-side, event-driven on `session.status: idle`, a
  small-model audit of the objective against the **last assistant message's
  text**, auto-continuation, pause/resume, token budget, a continuation cap.

Mittr goal is that loop, rebuilt around three weaknesses of text-only judging:

1. The judge reads the agent's words. A confident "all tests pass" is evidence
   to it. The engine keeps an authoritative record of every tool call — the
   command, its exit code, the file written, the URL fetched — and that record
   is what should be judged.
2. "Done" is one fuzzy question about the whole objective. Split into small
   factual questions per acceptance criterion it becomes a job a fast decision
   model (Jev) answers accurately in well under a second, and some criteria
   need no model at all.
3. When the judge says "not done", the agent gets a generic "continue". It
   should get exactly what is missing and why.

## 2. Goals

- The person states requirements. The agent asks only what it truly needs, once
  and briefly; clear requirements get no questions.
- The agent then works autonomously through the full loop — investigate,
  research on the web, plan, act, verify, fix — on any kind of task: code,
  research, writing, data, browser work.
- An independent judge decides whether the goal is really done, per acceptance
  criterion, from the engine's tool record: Jev through the Mittr platform, a
  deterministic script check where the criterion is machine-checkable, and the
  session's small model when the platform cannot be reached.
- "Not done" sends the agent back with the missing criteria and the reasons.
- A fabricated "done" is caught.

## 3. Non-goals

- A new engine feature. Everything uses what OpenCode 1.18.18 already ships:
  `question`, `todowrite`, `webfetch`, `websearch`, `task`, `skill`, the sessions
  API and its event stream. The engine patch set is untouched.
- The judge running commands. Script checks read the workspace and the tool
  record; they never execute anything (§6.3).
- Time budgets. Limits are counts and policy, never model speed (§7).

## 4. UX flow

1. **Enter goal mode.** The composer target button arms "the next message is a
   Mittr goal" (unchanged mechanism: `useSessionGoalArmStore`). Scheduled tasks
   and `mittrcraft session create --goal` reach the same state.
2. **Brief.** The armed send attaches the Mittr goal method as a synthetic
   system reminder (UI `session-ui-store.ts` and server `create.js` share the
   text). It tells the agent to investigate first — workspace, files, the web —
   and to ask the person only for what decides the outcome and cannot be found
   or safely defaulted, in one short batch through the engine's `question` tool.
   Clear requirements: no question, start working. The question tool keeps the
   turn open, so the loop never judges or continues while a question waits.
3. **Work.** The same method asks for a plan in `todowrite`, research with
   `websearch`/`webfetch` (cite only pages actually opened), verification with
   real checks, and a closing goal report per requirement with its evidence.
4. **Contract.** At the first idle tick the server derives the acceptance
   contract (§6.1) and stores it on the goal. The goal strip shows
   `met/total`; the goal dialog lists every criterion with its state, how it
   was checked, and the reason when it is not met.
5. **Judge.** Every idle tick checks every criterion (§6.2–6.4).
6. **Not done.** The strip shows the first missing criterion. The continuation
   prompt that appears in the transcript lists each criterion with its verdict
   and the reason, so the person reads exactly what the agent was sent back to
   do.
7. **Done.** Every criterion met: the goal settles `complete`, the desktop
   notification fires (existing path).
8. **Stop.** Pause (also aborts the running turn), the stop button (pauses the
   goal), Remove goal. Resume grants a fresh continuation allowance. All
   existing behaviour.

## 5. What lives where

| Concern | Owner |
|---|---|
| Arm/send, strip, dialog, criteria display | MittrCraft `packages/ui` (`sessionGoal*`) |
| Loop, evidence, contract, script checks, continuation feedback, local fallback judge | MittrCraft `packages/web/server/lib/session-goal` |
| Outbound call to the platform judge | MittrCraft `packages/web/server/lib/mittr-goal-judge` |
| `goal.criterion` decision, `POST /desktop/goal/judge`, Jev fast path, admin toggle | Mittr platform `apps/api/src/desktop`, `DecisionService`, Studio "Fast decisions" card |

The platform owns the decision model and its credential; the desktop never holds
a model key. This mirrors `POST /desktop/browser/next-step`.

## 6. Loop mechanics

The runtime still re-prompts the agent (`prompt_async` with the session's own
provider/model/agent). The working agent has no channel to settle its own goal.

### 6.1 Contract (once per goal)

At the first tick with no stored criteria, the session's small model turns the
objective into 1–8 acceptance criteria with a closed JSON schema. It also reads
the person's answers to the brief questions and a digest of the first turn's
tool activity — only to learn concrete names (the repository's test command,
the output path). The criteria come from the requirements, never from the
agent's plan. Each criterion is one observable outcome with one check:

| Check | Meaning | Decided by |
|---|---|---|
| `file` | a file in the workspace exists, is not empty, optionally contains a literal text | script |
| `command` | the tool record holds a run of this command that exited 0 **after the last file edit**, and the command decides that exit code (it is the last command on its line, or joined by `&&`) | script |
| `sources` | every URL cited in a file (or the final report) was actually fetched or returned by a search in this goal | script |
| `judge` | anything else | Jev (platform) → small model fallback |

The contract is stored on the goal (`criteria`) and frozen. Editing the
objective clears it so it is derived again. If derivation fails the tick judges
one criterion — the objective itself — and derivation is retried next tick.

### 6.2 Evidence

Built by the server from the engine's messages since the goal started, never
from the agent's prose: per tool call the tool, status, the input that matters
(command, path, URL, query), the exit code, and the tail of the output; the
newest entries win when the digest is capped. The agent's closing text is passed
separately and labelled as the agent's report, a claim.

### 6.3 Script checks

Deterministic, run first, no model. They only read: the workspace (paths are
resolved inside the session directory; anything outside fails the check) and
the tool record. They never execute commands, so a model-written contract can
never run anything on the machine. `command` catches the classic fabrication
("tests pass" with no run, a failed run, or edits after the last green run);
`sources` catches invented citations.

### 6.4 Judged criteria

`POST /desktop/goal/judge` with the objective, the judged criteria, the evidence
and the report. The platform asks one `goal.criterion` decision per criterion,
in parallel, through `DecisionService`: options `met` / `missing` /
`needs_person`, `askStance: decide`. With the fast path on, Jev answers each in
~0.3 s and the default model takes over below the threshold; with it off the
default model answers. This follows the Jev findings: small factual questions,
narrow non-overlapping criteria, full content rather than a preview, no
extraction asked of Jev.

Fallback: when the desktop is not signed in, the platform is unreachable, or a
criterion comes back undecided, the session's small model judges the remaining
criteria in one structured call with the same three verdicts. The goal records
which judge answered (`judgedBy`: `script`, `mittr`, `model` per criterion).

### 6.5 Verdict → action

| Result | Action |
|---|---|
| every criterion `met` | settle `complete` |
| every unmet criterion `needs_person` | continue once telling the agent to ask through `question`; settle `blocked` after 3 consecutive such rounds (existing streak) |
| some `missing` | continue with the feedback |
| judge unavailable (platform and small model) | one unaudited continuation, then `blocked` (existing streak) |

### 6.6 Continuation feedback

The continuation prompt carries the objective (as data), every criterion with
its verdict and reason, and the method rules: work on what is missing, act on
error signals rather than around them, verify with real tools, never claim a
criterion without evidence in the tool record, ask through `question` only for
what only the person can give.

## 7. Limits

- Continuation cap (existing, 20 per goal id; Resume resets it) and optional
  token budget (existing).
- **No-progress stop:** when the number of met criteria has not grown for 5
  consecutive judged rounds the goal settles `blocked` with the criteria still
  missing, so the person sees where it is stuck instead of the agent looping to
  the cap.
- No time budgets. The quiet windows that debounce idle events are unchanged.

## 8. Tool coverage

The loop is tool-agnostic: evidence is every tool part the engine records,
including MCP tools such as `mittrcraft`, `mittrcraft_web` and `mittrcraft_chrome`.

| Work | Typical criteria |
|---|---|
| Software | `command` (tests, build, lint), `file`, `judge` for behaviour |
| Research | `sources`, `judge` for coverage/answer quality |
| Documents | `file` with `contains`, `judge` for content requirements |
| Data | `file` for outputs, `command` for the script that produced them |
| Browser | `judge` over the browser tool record (pages read, actions taken) |

## 9. Failure and stop behaviour

- Platform down or signed out: small-model judge; the loop keeps working.
- Small model down too: one unaudited continuation, then `blocked`, resumable.
- Contract derivation fails: whole-objective criterion this tick, retry next.
- Turn error: `blocked` (existing). User abort: `paused` (existing).
- Every runtime write re-reads the session and drops the write if the goal id
  changed (existing stale-write guard); the new fields ride the same write.

## 10. Validation (2026-09-26)

Walked on the real engine (1.18.18) and server, in an isolated home, with a free
engine model (`opencode/big-pickle`):

- **Brief, through the UI.** Goal armed with the composer button, requirements
  that leave the customer's name open: the agent searched the workspace first,
  then asked one question through `question`; after the answer it wrote the
  file, re-read it, reported with evidence. Strip `Complete 2/2 done`; the
  dialog lists both criteria as met, checked by script.
- **Sent back, then done.** A four-criterion goal (file, file, command,
  sources). Round 1: the agent verified with `node --test 2>&1; echo
  "EXIT=$?"`; the command check refused it (echo decides that exit code) and
  the continuation listed `[NOT MET] The tests pass …` with the reason. Round 2:
  the agent ran `node --test` on its own; every criterion met, `complete`.
  The first version of that rule was fooled by a command name inside an echo
  string; both cases are now tests.
- **Fabrication.** A prompt telling the agent to claim success without tools:
  the method in the goal intro made the agent refuse and do the work.
- **Contract and judge prompts** on a real model, over the real record: the
  contract came back as five criteria (file, judge, file, command, sources);
  the judge accepted the real record with reasons that cite tool call numbers
  and rejected the same claims with an empty record (3/3 missing, "only the
  agent's own claim").
- **Judge unavailable.** Signed out and no usable small model: one unaudited
  continuation, then `blocked` ("progress audit unavailable").

Not walked: the Mittr judge (needs a signed-in desktop and a platform with
`goal.criterion`), and the direct small-model call (the free engine models
refuse calls made outside the engine, so the prompt check above went through
an engine session instead).

## 11. Decisions to confirm

1. **Surface.** MittrCraft first, reusing the composer goal button (relabelled
   "Mittr goal"). Studio later, on the same platform decision.
2. **Contract visibility.** Criteria are derived automatically and shown after
   the first turn; the person is not asked to approve them. Alternative: a
   confirm card before the first turn (one extra click, but the person sees
   "done means…" up front).
3. **Criteria are read-only in the dialog.** Editing the objective re-derives
   them. Editing individual criteria is left out of this version.
4. **No command execution by the judge.** A `command` criterion is met only by
   the agent's own recorded run after its last edit. Running the check
   ourselves would be stronger but executes a model-written command without the
   engine's permission rules; not done without the owner's decision.
5. **No-progress limit of 5 rounds** and the existing cap of 20 continuations.
6. **`goal.criterion` fast path** ships off, like `browser.step`; turn it on in
   the Studio "Fast decisions" card to use Jev (the platform default model
   answers until then).
