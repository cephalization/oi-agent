# How oi works

A guided map of oi-agent's internals, written to be read by the agent itself
when someone asks how it works, and by anyone curious.

Paths under `source/` are the agent's real source code, shipped with it. A
session's files are the other half of the picture: every claim below can be
checked against the span files of the conversation you are in.

## The one idea

Most agents keep the conversation in memory or a database and emit telemetry
on the side. oi has only the telemetry. Each model call, tool call and
evaluation is an OpenInference span written to disk, and the agent works out
what to send the model next by reading those files back.

So "what is the agent's state?" has a literal answer: a folder.

```
<sessions>/<session-id>/
  session.json                                 where and when the session began (and, for a subagent, who delegated it)
  traces/<trace-id>/                           one folder per user turn
    <start-ns>-<span-id>.json                  a finished span; never modified
    <start-ns>-<span-id>.open.json             a span still running
    <start-ns>-<span-id>.stream.jsonl          text streaming into a running span
  annotations/<id>.json                        evaluator verdicts
  inbox/<id>.json                              prompts that no turn has started yet (queued, said to a running turn, or from people sharing the session), and results of background work
```

Beside the sessions, and never synced, are the logs of shell commands that
were left running in the background: `<home>/jobs/<session-id>/<job-id>/`.

## A turn, step by step

Follow along in `source/engine/src/agent.ts`.

1. **The user sends a prompt.** `runTurn` starts a root span of kind `AGENT`.
   Its `input.value` is the prompt. Starting the span writes an `.open.json`
   file.
2. **The loop asks "what do I send?"** It calls `contextFor` in
   `source/engine/src/fold.ts`. This is the fold: it finds the most recent
   model call in the turn, takes the messages that call sent, appends the
   model's reply, and appends the results of any tools the reply asked for.
   If the turn has not reached the model yet, it takes the previous turn's
   context and adds the new prompt.
3. **The model is called** (`modelStep`, and `source/engine/src/model.ts` for
   Anthropic or `source/engine/src/openai.ts` for OpenAI-style APIs).
   The exact request body is stored in the `LLM` span's `input.value` and the
   exact response in `output.value`, with `metadata.oi_agent.api` saying
   which wire format they are in. Token counts, model name and the
   flattened messages are stored beside them as `llm.*` attributes.
   The system prompt lists the instruction files (`AGENTS.md`, `AGENT.md`,
   `CLAUDE.md` from the working directory up to the repository root, plus
   `~/.claude/CLAUDE.md` and `~/.config/AGENTS.md`) and the skills
   (`.agents/skills`, `.claude/skills`, in the project and the home
   directory) by path and description only. The model reads them itself
   with `read_file`, so each read is a `TOOL` span, and the prompt stays
   identical from request to request for the prompt cache.
4. **If the reply contains tool calls, each runs in a `TOOL` span**
   (`toolStep`, and `source/engine/src/tools.ts`). Tools that change the
   machine wait for approval first, with `metadata.oi_agent.awaiting_approval`
   set on the in-flight span until the decision is recorded beside it.
   Output is scrubbed of secrets
   (`source/engine/src/redact.ts`) before it is written. The commands
   `bash` runs see `OI_AGENT=1`. A command still running after two minutes
   (or the `timeout_ms` the model asked for) is not killed: the call ends
   with its output so far, and the command carries on as a background job
   (see "What happens to a slow command?" below).
5. **Back to step 2.** The loop keeps no variables holding the conversation.
   Each pass re-derives it from disk, which is why killing the process
   mid-turn loses nothing: restarting takes the same path.
6. **When a reply has no tool calls, the turn ends.** The root span gets its
   `output.value` and is written as a finished file.

The link between "a span" and "a file" is `source/engine/src/tracer.ts`: an
Effect tracer whose `span()` writes the open file and whose `end()` writes the
finished one. Normal agent, model and tool execution uses `Effect.withSpan`;
persistence is a side effect of tracing. Handoff bootstrap copies use the
synchronous span writer in `source/engine/src/handoff.ts`, shared by initial
creation and crash recovery.

## Concept to file

| Concept                                          | Where                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| The on-disk format, as schemas                   | `source/engine/src/format.ts`                                        |
| Reading and writing span files, the event stream | `source/engine/src/store.ts`                                         |
| Spans become files                               | `source/engine/src/tracer.ts`                                        |
| State derived from spans (the fold)              | `source/engine/src/fold.ts`                                          |
| The loop                                         | `source/engine/src/agent.ts`                                         |
| Talking to the model                             | `source/engine/src/model.ts`, `openai.ts`, `chatgpt.ts`              |
| Wire formats, and translating between them       | `source/engine/src/dialect.ts`, `source/engine/src/dialects/`        |
| Providers, keys, model lists                     | `source/engine/src/providers.ts`, `source/cli/src/providers.ts`      |
| The tools the model can call                     | `source/engine/src/tools.ts`                                         |
| Commands that outlive their tool call            | `source/engine/src/jobs.ts`, `jobEnded` in `engine.ts`               |
| Subagents: delegating, steering, approvals       | `source/engine/src/tasks.ts`, `task-tools.ts`, `serve` in `main.ts`  |
| Watching a session another process writes        | `follow` in `source/engine/src/store.ts`                             |
| The system prompt                                | `source/engine/src/prompt.ts`                                        |
| Finding AGENTS.md, CLAUDE.md and skills          | `source/engine/src/instructions.ts`                                  |
| Queueing turns, approvals                        | `source/engine/src/engine.ts`                                        |
| Evaluators, feedback, learned rules              | `source/engine/src/evals.ts`, `eval-tool.ts`, `judge.ts`, `rules.ts` |
| Learning evaluators from the user's corrections  | `source/engine/src/steering.ts`, `judge.ts`, `detectors.ts`          |
| Where a session's time went (`/metrics`)         | `source/engine/src/metrics.ts`                                       |
| Export to Phoenix (OTLP protobuf)                | `source/engine/src/export/`                                          |
| Reading sessions back from Phoenix, storage      | `source/engine/src/remote/`, `source/cli/src/storage.ts`             |
| Sharing a session with other people              | `source/engine/src/peer/`                                            |
| Terminal status (OSC 7501)                       | `source/cli/src/program-status.ts`, `source/cli/src/tui/ansi.ts`     |
| The terminal interface                           | `source/cli/src/tui/`                                                |
| Slash commands and their tab completion          | `source/cli/src/tui/commands.ts`                                     |
| Commands and setup                               | `source/cli/src/main.ts`, `onboarding.ts`                            |
| Restarting on new code (`/reload`), the fallback | `source/cli/src/launcher.ts`, `reloadInto` in `main.ts`              |

## Things worth showing someone

These work best on the session you are in, because the evidence is right there.

- **"Where did the time go?"** `/metrics` (or `oi metrics [session]`, with
  `--json` for scripts). Nothing was recorded for it: every span file has a
  start and an end time, and `sessionMetrics` in
  `source/engine/src/metrics.ts` adds them up. A turn's wall time is its
  root `AGENT` span; its model time is the sum of its `LLM` spans and its
  tool time the sum of its `TOOL` spans (calls that ran side by side both
  count, so tools can exceed the wall time; a tool's span also covers the
  time it waited for your approval). Traces that are not turns
  (evaluators, learning, steering detection) run after a turn and are
  reported apart, as judge time. A span still open in a running turn counts
  up to now; one left open by a crash counts up to the last thing its trace
  recorded, and the turn is marked interrupted. Tool time is grouped by
  tool, and for `bash` by what the command ran: the command is split into
  steps (`commandSteps`), and the step that took the time is a build or
  test runner if there is one (`pnpm e2e`, `git commit`), else the last
  step that is not setup, waiting or reading a log. Nothing about any one
  repository is built in. A task's work is in its own session, so tasks
  are listed separately with their own totals. In Phoenix the same sums
  are a query over the session's spans: latency by `openinference.span.kind`,
  grouped by trace.

- **"What happens to a slow command?"** Every `bash` call is a job
  (`source/engine/src/jobs.ts`): its output goes to a log file and a small
  wrapper writes its exit code beside it, in `<home>/jobs/<session>/<job>/`,
  so the command needs nothing from the oi process once started. A call that
  finishes in time reads the log back and deletes the job. One that reaches
  its time limit, or was started with `background: true`, is left running:
  the `TOOL` span ends with the output so far and
  `metadata.oi_agent.job = { id, log, reason }`. The model can look with
  `job_status` or stop it with `job_kill`, but does not have to wait.
  When the job ends, `jobEnded` in `source/engine/src/engine.ts` writes its
  result (state, command, end of the log, scrubbed) to the session's
  `inbox/` as `job-<id>.json`, with `delivers` naming the job and the `TOOL`
  span that started it. The engine then runs one turn for every result
  waiting, after whatever turn is running: its root span has `user.id`
  `oi`, the results as `input.value`, and `metadata.oi_agent.delivers`
  listing each job, its inbox entry and its `TOOL` span. That is how you get
  from a result back to the call that started the work, in the files alone.
  The terminal shows such a turn as a notice, not as a prompt, and counts
  running jobs in the status line. Jobs survive `/reload` and quitting:
  the next process to open the session follows them again (`attend`), and
  results that arrived while nobody was there are delivered then. `oi run`
  waits for the jobs it started unless given `--no-wait`. The log lives
  outside the session tree because it is raw output that grows; the session
  tree holds only scrubbed, immutable files. If the shell cannot start (for
  example, its working directory was deleted), the tool reports failure,
  removes the incomplete job and handles Node's later spawn-error event
  without crashing the process.
- **"What is a subagent?"** Another oi agent with a session of its own
  (`source/engine/src/tasks.ts`). `delegate` creates the session with a
  header that names the `TOOL` span which delegated it (`parent`) and the
  task (`task`: id, title, isolation, model, worktree), writes the brief
  into the new session's `inbox/` with `origin` pointing at that span, and
  starts a _runner_: a background job of the delegating session whose
  command is `oi serve <session>`. `serve` (`source/cli/src/main.ts`) is a
  headless process that runs what is in the session's inbox and exits when
  nothing is left: no turn, no job, no unread prompt. So the brief is the
  subagent's first turn, word for word, and that turn's root span carries
  `metadata.oi_agent.origin`.
  Because the runner is a job, a task outlives the turn and the process
  that started it, and its end is delivered like a job's: `jobEnded` writes
  a result to the delegator's inbox, built from the subagent's last turn,
  and the delivery turn's `metadata.delivers` names the delegate span and,
  as `result`, the subagent's turn. Both directions can be walked from the
  files. On export the same relations are also written as OTel span links
  (`linksOf` in `source/engine/src/export/otlp.ts`).
  With `isolation: "worktree"` the task works in `git worktree` at
  `<home>/worktrees/<task>` on branch `oi/<title>-<task>`, started from the
  delegator's commit. When a task ends having changed nothing (no commit, no
  uncommitted change), its worktree and branch are removed as its result is
  written (`Tasks.tidy`): there is nothing to merge or look at. One with
  work in it stays until you remove it. A follow-up to a task whose worktree
  is gone recreates it first, on its branch if that still exists and from
  the same starting commit otherwise (`Tasks.restore`). `task_message`
  writes another prompt to the task's inbox and starts a new runner if the
  last one has left, so a follow-up continues with
  everything the task knew. `task_cancel` kills the runner's process group
  and the task's own jobs. A subagent's session has no delegate tools.
  A tool call a subagent needs a person for cannot be asked in a process
  with no terminal: the request is written to
  `<home>/approvals/<session>/` and the delegating session's engine, while
  someone attends it, shows it through the usual approval prompt and writes
  the decision back (`ApprovalDesk`, `relayApprovals`). The decision is
  recorded on the subagent's `TOOL` span as always.
  The system prompt differs by role (`source/engine/src/prompt.ts`): a
  session with the delegate tools is told to prefer delegating and how to
  write a brief; a subagent is told what to report and where it is working.
- **"What do /attach and the status panel read?"** The same files. The panel
  above the status line is `Engine.background`: the session's running jobs,
  and for each task the tool call open in its session. `/attach` switches
  the terminal to the task's session without making this process its
  writer: `Store.follow` polls the session's files and emits the events a
  writer in this process would, and what you type goes to the task's inbox
  (`Tasks.say`). A span's stream file is removed when the span ends, so a
  follower can miss the end of a reply, or a quick one entirely; when an
  `LLM` span ends it emits whatever reply text it had not yet shown, read
  from the span's output message attributes. The delegating session stays attended, so results and
  approval requests still arrive. Opening a task directly with
  `oi -s <task-session>` answers its approval requests too
  (`Engine.watch`), but does not serve the delegating session: results and
  queued prompts wait in that session's inbox until it is opened, here with
  `/detach` or anywhere else, because it may be open and mid-turn in another
  terminal. The terminal never runs the task's turns locally. Switching
  between the parent and its tasks keeps the same owner, while switching to
  unrelated work releases it. Unanswered task approvals remain available
  when the terminal is reopened.
- **"What will Enter do?"** The line under the prompt says, from the
  conversation's own state (`enterHint` in `source/cli/src/tui/app.ts`):
  idle, Enter starts a new turn, and says so even while tasks and background
  commands run, because they do not occupy the conversation. While a turn
  runs, Enter **steers** it, and ctrl+t switches to **queueing** for the
  next turn and back. Both are files in `inbox/`, so neither lives only in
  the terminal. A steering message has `steers: true`
  (`Engine.steer`). The running turn looks for one after each round of tool
  calls, and again when the model stops without asking for a tool, in which
  case the turn goes on instead of ending (`steer` in the loop,
  `source/engine/src/agent.ts`). It records the message on its root span as
  `metadata.oi_agent.steered = [{ inbox_id, after, user_id, text }]`, where
  `after` is the `LLM` span whose reply and tool results the message follows.
  `contextFor` adds it, wrapped by `renderSteer`, as a user message after
  those results when it builds the next request, so the request is the same
  if another process builds it after a crash; later calls of the turn carry
  it in their stored request body. If the turn ends before reading it, the
  entry is still pending, and the inbox drain that follows every turn runs
  it as an ordinary next turn; the terminal says that happened. A queued
  prompt is a plain inbox entry (`Engine.queue`): the running turn never
  sees it, it runs after, in the order sent, and it survives quitting:
  leaving a session stops its turn without starting what is queued
  (`interrupt(sessionId, true)`: the session is marked as left, so nothing
  already read from its inbox starts either), and the queue runs when the
  session is next opened. A `/compact` or `/handoff` reads nothing said to
  it, so Enter queues while one runs. A turn only takes messages sent while it runs, so one that
  an earlier turn never read is not also picked up by the turn before its
  own. What is waiting is listed above the status line, read back from
  the inbox.
- **"Why did my result not interrupt me?"** Results are held while you are
  in the middle of something. The terminal sets `Engine.calm`, which
  `drainInbox` asks before queueing a delivery turn: an empty prompt, no
  question on screen and a second and a half without a key. `/inbox`
  delivers regardless. All results waiting are delivered in one turn.
- **"How does the terminal know you need attention?"** On a TTY,
  `source/cli/src/program-status.ts` projects root AGENT open/end events into
  OSC 7501 working, done, error or idle reports; the TUI's approval callbacks
  report blocked/permission and return to working when answered. Shared peers
  use the same root span events for working and completion; approvals stay
  with the host. The next key acknowledges done/error; leaving the TUI clears
  the record. `oi run` leaves completion visible after exit and sends no OSCs
  to redirected stdout. `programStatus` in `source/cli/src/tui/ansi.ts` encodes
  scrubbed messages as base64, removes controls and caps UTF-8 bytes. This is
  only a terminal projection, not new session state or a heartbeat.
- **"What did you actually send the model?"** Open the latest `LLM` span in
  the current turn's folder and show `input.value`: the system prompt, the
  tool definitions and every message. This is the whole of what a model
  "knows" in a turn.
- **"Where is your memory?"** There is none beyond those files. Show that the
  second `LLM` span of a turn contains the first one's reply and the tool
  result, and point at the lines in `fold.ts` that assembled them.
- **"Why is the history resent every time?"** The API is stateless. Compare
  `llm.token_count.prompt` across spans to show the cost growing, and
  `llm.token_count.prompt_details.cache_read` to show prompt caching
  absorbing most of it.
- **"What is a tool call, really?"** Show a `tool_use` block in an `LLM`
  span's `output.value`, the `TOOL` span that ran it, and the `tool_result`
  block in the next request. The model only ever emits text; the harness does
  the work.
- **"What is thinking?"** If a reply has a `thinking` block, show it and its
  `signature`, and explain that it must be sent back unmodified.
- **"How does an eval change your behaviour?"** Show an annotation file, then
  the `<eval-feedback>` block at the start of the next turn's first request,
  then the rules file if a rule was learned.
- **"Do evaluators run on every turn?"** Only when they apply. A definition
  can carry `applicability` (`EvalDefinition` in
  `source/engine/src/evals.ts`): `any` predicates (one must hold) and `all`
  predicates (every one must). `writes` and `commit` come from
  `metadata.evidence` on `TOOL` spans: before and after each mutating tool
  call, `observeWorkspace` (`source/engine/src/evidence.ts`) hashes the Git
  worktree's tracked and non-ignored files and reads `HEAD`'s reflog, so a
  commit made from bash counts, and a failed commit or a no-op edit does not.
  `tool:<name>` means the tool was called; `always` is every turn. Evidence
  that cannot be determined (no Git, a bound exceeded) is `unknown`, and an
  unknown predicate runs the check rather than skip it. A skip is an
  annotation labelled `skipped` with the trigger and evidence in its
  metadata, made without calling a judge, and it never gives feedback or
  learns a rule. A definition without `applicability` runs every turn, as
  before. A failed result is an open obligation: on a later turn the check
  would skip, `runEvals` reruns it (an LLM judge sees the failing turn and
  the correction), so a turn that opens the missing PR without committing
  again can resolve it.
- **"How do evals judge background work?"** Evals run after both launching
  turns and result-delivery turns, not when a job exits. LLM judges distinguish
  calls initiated in the reviewed turn from results delivered from earlier
  work. Direct provenance links provide bounded launch/result excerpts without
  loading child histories into the judge prompt. Delegating forbidden work can
  fail immediately; accurately reporting or acknowledging that earlier work is
  not a fresh launch. Regex targets remain literal. An LLM outcome check can
  opt in with `wait_for_background: true`: applicable launch turns get a
  `pending` annotation with no score, failure feedback or learned rule. The
  obligation is recovered from spans and annotations, and judged once all
  directly launched background results have durable delivery links on the
  active branch. Partial deliveries remain pending; separate launch turns keep
  independent obligations. Waiting is recorded once, on the launch turn:
  turns in between are evaluated as usual and add no further `pending`
  record. Each outcome result names its launch turn (`deferred_from`, and
  `oi-agent:deferred:<trace>` as the annotation identifier, so several on
  one turn stay distinct in Phoenix). A result that was delivered on another
  branch of the session can never arrive on this one: that obligation ends
  as `skipped`, saying so. Polling a finished job or cancelling a job/task also
  persists completion on the observing TOOL span before claiming the result,
  so pending checks resolve without a duplicate automatic delivery. A task
  follow-up that starts a new runner creates its own launch obligation;
  messages to an already-running task remain part of the existing runner's
  work. Launch prohibitions should leave this option off (the default), so
  forbidden work is checked immediately.
- **"How many tokens are in context?"** The status line's `N context` is
  the latest agent `LLM` span's `llm.token_count.total` (prompt, cached
  tokens included, plus reply, which the next request also sends):
  `contextTokens` in `source/cli/src/tui/transcript.ts`. Evaluator,
  steering and decision calls are separate traces and do not count.
  `Transcript.replay` restores these counts from the stored spans when a session
  is reopened. `/session` also prints the session's total across every model
  call, with cached history counted again on each call.
- **"Where do eval results show up?"** `Transcript.annotation`
  (`source/cli/src/tui/transcript.ts`) prints a failed verdict, and a
  `steering` note that something was learned, in the transcript. A pass is
  only counted: the status line shows `◆ N evals passed` for the latest
  turn reviewed. `/verdicts` (`verdicts` in `source/cli/src/tui/app.ts`)
  reads that turn's annotation files from disk and prints every field,
  passes included.
- **"How do you learn from my corrections?"** Two ways. The system prompt
  tells the agent to call `create_eval` when asked for something to always or
  never do. And after each turn, `detectSteering`
  (`source/engine/src/steering.ts`) sends the prompt, the previous turn and
  the existing evaluators to the configured steering model (`modelDetector`
  in `judge.ts`, or `llmDetector` in `detectors.ts`),
  which says whether the prompt is a correction that applies beyond the
  current task, and proposes an evaluator. Reports of defects in the product
  being developed are not standing preferences for the coding agent, even
  when the product is itself an agent harness. Application authorization
  dialogs and runtime mode changes are product behavior, not conversational
  habits to reward or punish. Above 0.7 confidence, and when no
  existing evaluator covers it, it is saved with an `origin` naming the turn
  and the trigger the detector chose (shown in the `learned` note),
  Every verdict becomes a `steering` annotation on the turn (`learned`,
  `durable` or `one-off`, with the confidence as score); the terminal shows
  only `learned` ones (`shownInTerminal`). Each detection is also an
  `EVALUATOR` trace with the prompt as input and the verdict as output, so
  you can read why it did or did not learn something. `steering_model` can
  name any configured `provider/model`, or `decision:<model>`: the latter
  calls System One to screen each prompt, then the judge model (or the
  agent's own model) writes an evaluator only for a durable correction.
  The writer can veto the screen's durable verdict; its non-durable answer
  is not overwritten by the screen's probability.
  `decisionDetector` in `source/engine/src/detectors.ts` records the screen
  as a `DECISION` span under the `EVALUATOR` span and the writer as an `LLM`
  child beside it. If the screen fails, the writer decides alone. An unset
  steering model defaults to the judge with an Anthropic key, else the
  agent's model. `oi setup` offers these choices; `inactiveFeatures` in
  `source/cli/src/main.ts` warns about missing credentials. LLM judging and
  distillation still require the Anthropic judge key. Why a detector and not
  a wider prompt: `docs/experiments/steering.md` (in the repository).
- **"How does auto mode decide whether tools may run?"** `Engine.autoApprove`
  in `source/engine/src/engine.ts` checks hard rules first (`mustAsk` in
  `decision.ts`): dangerous deletes, force pushes, sudo, discarding work and
  file writes outside the working directory always ask. Then `askDecision`
  calls the configured System One endpoint with the tool, input, working
  directory, current user prompt and learned project rules. Four Nouls
  assess irreversible damage, effects outside the workspace, secrets, and
  whether the user requested it. Requested read-only service queries and
  normal authentication are not counted as external changes or secret
  exposure. `clearsThresholds` allows only when every risk is low and
  relevance high. Failure, invalid probabilities or no key
  asks a human, never auto-denies; headless `oi run` denies anything that
  would ask. `TOOL` metadata records `approval.by = "auto:<model>"` and the
  answers, or why it asked. `approvalConcerns` formats failed thresholds;
  the engine includes the reason in the host's `ApprovalRequest`, and the
  TUI shows it as `Auto asked`. The dialog accepts only `y`/`n` in auto
  mode, leaving that mode unchanged (`source/cli/src/tui/approvals.ts`). In
  ask mode, `a` is explicitly labelled "enable yolo for this session".
  `decisionSpan` records the exact bodies (secrets
  scrubbed) and `decision.*` usage under that tool. No `llm.*` attributes are
  set, and `kindOf` recognizes `DECISION`; the fold ignores these spans.
  The TUI reports their usage separately at an estimated TypeSafe rate.
  This is not an OS sandbox: the model can be wrong, and hard rules are not
  a complete shell parser. `/auto` enables it, or use `approvals: "auto"`.
- **"Why does oi start in the approval mode I last picked?"** Tab, `/auto`
  and `/yolo` call `chooseApprovals` in `source/cli/src/tui/app.ts`, which
  sets the engine's mode and writes it to the config file with
  `saveApprovals` (`source/engine/src/config.ts`), touching only that key.
  It is a preference, not session state, so it is not in the spans. Modes
  oi sets itself are not saved: `--approvals`, the dialog's `a` ("yolo for
  this session"), and the drop to ask for a session from another machine.
- **"How does resuming work?"** There is nothing to load. `/resume` (or
  `oi -s <id>`) points the terminal at another session folder: the screen is
  rebuilt by reading its root spans, and the next model request comes from
  `contextFor` reading that session's latest `LLM` span, exactly as for the
  next step of a running turn. `/resume` lists sessions from their root spans
  (`source/cli/src/sessions.ts`) and hides unused sessions, but includes a
  pending handoff seed even before its first agent turn. The status bar in
  `source/cli/src/tui/app.ts` keeps an 18-character session-id prefix ahead of
  optional model/usage details, so it survives status-line crowding. `/session`
  prints the full copyable ID and resume command for both hosts and joined
  peers. On `/new`, `/resume`, or `/handoff`, the old app calls
  `Screen.freshViewport` before the new app draws its banner and replays its
  own spans. The method scrolls a full viewport of blank lines, then homes the
  cursor; it does not erase scrollback or alter model context. Quit and reload
  retain their existing terminal behavior.
- **"What does /compact do?"** `runTurn` in `source/engine/src/agent.ts`
  records the command as an `AGENT` root with `metadata.oi_agent.operation =
  "compact"`. Its `context.compact` `CHAIN` child records the exact source
  head, manual trigger and policy version; an `LLM` child of that chain
  records the real summarization request and response, using the current
  model with no tools. It receives a normalized text/tool transcript as data,
  not a continuation of old tool calls or signed reasoning blocks; the
  original raw wire bodies remain untouched. The chain's `output.value` is
  the generated brief.
  Only after that chain ends does the root record `metadata.oi_agent.checkpoint`
  pointing at it. `contextFor` activates it only when the root has ended
  successfully, returning the brief explicitly labelled as lossy generated
  context, not new user instructions. Failed/interrupted roots instead return
  their predecessor's context. Old span files and other branches never change.
  The fold only treats direct `LLM` children of an agent root as continuation
  calls, so it cannot accidentally replay the summarizer's conversation.
  Compaction does not consume pending evaluator feedback or run turn judges.
  The terminal hides the summarizer's text stream, counts its tokens, takes
  the brief's size as the new context size, and
  displays the root's completion notice. This first version replaces the
  whole preceding context; it does not retain a verbatim suffix, compact
  automatically.
- **"What does /handoff do?"** The TUI submits a `handoff` operation with
  your query unchanged. `runTurn` reuses the `context.compact` CHAIN/LLM
  summarizer, then creates a destination session whose id is derived from
  the source operation's trace id. Unlike `/compact`, this does not activate
  the checkpoint in the source thread: `contextFor` returns its predecessor's
  context. The source root records `handoff_target` for recovery.
  A root `CHAIN` span named `handoff.seed` in the destination stores the exact
  query in `input.value`, the brief in `output.value`, and source session and
  checkpoint references in `metadata.oi_agent.handoff`. These are provenance,
  not edges the fold follows. Only after this span ends does the terminal
  switch sessions. Both `Engine.submit` and `Engine.resumeHandoff` serialize
  pickup with the turn queue, before ordinary prompts or inbox inputs, and
  submit the seed only if the destination has no agent turns.
  The first turn has `previous: null` and `handoff_seed` pointing at the local
  seed. Its first model request contains a labelled generated brief and a
  separate user message with the exact query. Later requests follow the usual
  fold. Restart and Phoenix restore work without source-session files. A
  pending seed is listed in `/resume` even before it has an agent turn.
  Pickup never automatically retries an interrupted first turn: its tools may
  already have run. Source summarization bypasses turn judges and does not
  consume source evaluator feedback; the actual destination turn runs normal
  tools, approvals, system instructions and evaluators. Only the host can run
  `/handoff`, and there is no natural-language trigger yet.
- **"Can I resume from Phoenix?"** Yes, because the raw request and response
  bodies the fold replays reach Phoenix byte for byte. `oi resume <id or URL>`
  (`source/engine/src/remote/`) reads a session's spans and annotations back
  through Phoenix's REST API and writes them to disk as span files; from
  then on it is an ordinary local session. Phoenix changes three things on
  the way: it splits JSON-string attributes like `metadata` into dotted keys
  (re-nested on import), rounds times to the microsecond (so the store
  matches spans by id, not file name), and gives annotations its own ids
  (the exporter sends the local id in annotation metadata to restore it). A
  trace URL continues from that turn by passing it as `previous`, which
  forks the session. Each turn's root span records its workspace (directory,
  git remote, commit, dirty), so a resume can say how the checkout differs.
- **"What does keeping a session only in Phoenix do?"** Tab in the `/resume`
  list calls `moveToPhoenix` (`source/engine/src/remote/storage.ts`): send
  anything unsent, query Phoenix until it has every span and annotation,
  then delete the folder and leave a marker in `<home>/remote/`, outside the
  session tree. Opening it imports it again; leaving moves it back. The fold
  never reads Phoenix directly: a session is always run from local files.
  Moving out is blocked by open spans, unread inbox entries, or background
  jobs (including task runners) still running or awaiting a report. A task
  session also checks its runner in the delegator's jobs. These blockers are
  checked again after export and remote verification, immediately before
  deletion, so a result arriving during export stays on disk for delivery.
- **"What happens when I switch model or effort mid-session?"** `/model` and
  Shift+Tab call `Engine.configure` (`source/engine/src/engine.ts`), which
  builds a new model for the next turn; no span changes. `/model` also
  calls `saveModel` (`source/engine/src/config.ts`), which writes the
  `provider` and `model` keys (and `effort`, if the switch had to change
  it) into the config file, so new sessions start on it; `/model --temp`
  skips that, and Shift+Tab never saves. Each `LLM`
  span records the model in `llm.model_name` and the effort in
  `llm.invocation_parameters`, so the switch is visible span by span. The
  history is replayed verbatim to the new model, and the API drops thinking
  blocks a different model cannot read. The levels offered come from the
  Anthropic Models API's `capabilities.effort` (`listModels` in
  `source/engine/src/model.ts`). OpenAI and ChatGPT use the model list's
  `supported_reasoning_levels`, keeping the levels oi understands (including
  `xhigh` and `max`). When that field is absent, `openaiEfforts` in
  `source/engine/src/openai.ts` offers low/medium/high for GPT-5 and later,
  o-series and Codex models. The provider catalog is refreshed in memory;
  the same discovered levels constrain both Shift+Tab and the next request
  (`source/cli/src/providers.ts`). Effort names are sent unchanged.
- **"Which model does a resumed session use?"** The one it last used, read
  back from its spans rather than saved anywhere: `lastModelOf`
  (`source/engine/src/fold.ts`) takes the newest agent turn's `LLM` span
  (evaluator traces are skipped, as their judge is a different model), its
  configured provider from `metadata.oi_agent.provider`, `llm.model_name`,
  and the effort from the stored request body, which each dialect reads
  (`effort` in `source/engine/src/dialect.ts`). `restoreModel` in
  `source/cli/src/main.ts` passes it to `Engine.configure` whenever a session
  is opened, and says so when the model changes. An explicit `-m` wins for the
  session the process starts with. A model that can no longer be built
  (provider removed, no key) leaves the current one, with a note. A new
  session keeps whatever model is current.
- **"How do you pick up changes to your own code?"** `/reload`. The `oi`
  command is a small launcher (`source/cli/src/launcher.ts`, Node built-ins
  only) that runs the CLI as a child process: `OI_AGENT_ENTRY` when set
  (`bin/oi` sets it to the checkout's sources), else the bundled build
  beside it. `/reload` first runs that code with `--check`, which loads every
  module and exits, and refuses if that fails. Otherwise the CLI writes
  `reload` and its arguments (`-s <session> -m <model> --effort <level>
  --approvals <mode>`) to
  a pipe the launcher gave it, and exits with 75. The launcher starts the
  code again with those arguments. Nothing is handed over in memory: the new
  process folds the same span files. If code started by a reload exits
  before its terminal is up (it writes `ready` once it is), or crashes later,
  the launcher starts the bundled build on the same session, with a note
  saying why; a child killed by a signal is not restarted. After any abnormal
  exit the launcher puts the terminal's settings back. The protocol is tested
  against fake CLIs in `packages/cli/test/launcher.test.ts`. `/reload` refuses while a turn is running (press esc first), as `/new` and `/resume` do. Continuing a turn that a restart
  cut short is not built yet: the next turn folds it in as interrupted.
- **"Why are calls to OpenAI sent over a WebSocket?"** For the prompt cache.
  OpenAI finds a cached prefix only on the machine that wrote it, and plain
  HTTP requests land on different machines: measured on a ChatGPT plan, even
  an identical request repeated back to back usually read nothing from the
  cache. `source/engine/src/openai-socket.ts` keeps one connection per
  conversation, which stays on one machine, so calls after the first reuse
  the prefix. Nothing else changes: each call still sends the whole
  conversation derived from the spans, `previous_response_id` is never used,
  and the request stored on the span is the same HTTP body either way. Show
  `network.protocol.name` on an `LLM` span (`websocket` or `http`) next to
  `llm.token_count.prompt_details.cache_read`. A connection is replaced
  before OpenAI's 60-minute limit and after an interrupt, which costs one
  uncached call; if a socket cannot be opened the call goes over HTTP.
  `OI_AGENT_OPENAI_TRANSPORT=http` turns it off.
- **"How do you talk to OpenAI or a local model?"** Each API is a dialect
  (`source/engine/src/dialect.ts`): Anthropic Messages, OpenAI Chat
  Completions (what "OpenAI-compatible" servers speak) and OpenAI
  Responses (OpenAI and ChatGPT plans). A dialect knows how to read its
  stored bodies, continue a conversation, and convert to and from a neutral
  transcript of text, tool calls and tool results. The fold continues in the
  dialect of the turn's last call, replaying it verbatim; when `/model` moves
  to a provider with another dialect, `contextFor` translates through the
  transcript, so reasoning blocks, signatures and other provider-specific
  parts stay behind. Responses requests use `store: false` and carry
  reasoning forward as `encrypted_content`, so OpenAI holds no state either.
  Providers are config entries without secrets
  (`source/engine/src/providers.ts`). An OpenAI-compatible entry can name
  its `models`; then `/model` offers those rather than the server's own
  list, and requests ask for no more than each model's `max_output`. Keys are
  keychain accounts named after the providers, and a ChatGPT sign-in (OAuth with PKCE, `source/engine/src/chatgpt.ts`)
  is a keychain entry holding a refreshable token.
  A provider is a way of reaching models, not a vendor: `chatgpt` and
  `openai` both reach OpenAI. So an `LLM` span has the vendor in
  `llm.provider` (`vendorOf`: `openai`, `anthropic`, a compatible entry's
  optional `vendor`, else its id), oi's provider id in
  `metadata.oi_agent.provider`, which is what oi itself reads, and
  `metadata.oi_agent.billing`: `plan` for the ChatGPT sign-in, whose calls
  are not billed per token, and `api` otherwise. Phoenix prices every call
  from its model name, so plan calls still show a list-price cost there;
  `billing` is how to tell them apart.
- **"How do two people share one agent?"** `peer/server.ts` serves a list of
  files and a stream of events; `peer/client.ts` copies what is missing.
  Finished spans never change, so there is nothing to merge.

## Further reading

- `README.md`: what it does and how to use it.
- `PLAN.md`: the design decisions and what was measured.
- `spec-gaps.md`: what OpenInference could not express, found by building this.

### Scored experiment isolation

The repository's e2e harness runs opted-in, live-only headless samples in
independent sandboxes (`packages/e2e/src/scenario.ts`). Bounded workers
(`samples.ts`, default concurrency 4) cannot share learned rules or evaluator
files. The steering experiment records one JSON outcome per case/repetition,
including whether the agent or steering detector created each evaluator,
and attaches those rows to the scenario's Phoenix span. Ordinary Rex/proxy
scenarios run sequentially within a file and concurrently across files. All Rex
terminals, including independent concurrent suite processes and worktrees, use
one persistent session named `oi e2e`, with a separate tab/pane per terminal.
A machine/user-wide directory lock serializes exact-name discovery and session
creation because Rex has no atomic get-or-create. Cleanup closes only the owned
pane IDs, never the shared session; interrupted runs require targeted pane
cleanup, not killing the session. See `packages/e2e/README.md` for controls and
fail-closed lock recovery.
