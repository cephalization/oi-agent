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
  session.json                                 where and when the session began
  traces/<trace-id>/                           one folder per user turn
    <start-ns>-<span-id>.json                  a finished span; never modified
    <start-ns>-<span-id>.open.json             a span still running
    <start-ns>-<span-id>.stream.jsonl          text streaming into a running span
  annotations/<id>.json                        evaluator verdicts
  inbox/<id>.json                              prompts sent by people sharing the session
```

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
   (`source/engine/src/redact.ts`) before it is written. `bash` kills a
   command after two minutes unless the model asks for longer, and says
   so in the result; the commands it runs see `OI_AGENT=1`.
5. **Back to step 2.** The loop keeps no variables holding the conversation.
   Each pass re-derives it from disk, which is why killing the process
   mid-turn loses nothing: restarting takes the same path.
6. **When a reply has no tool calls, the turn ends.** The root span gets its
   `output.value` and is written as a finished file.

The link between "a span" and "a file" is `source/engine/src/tracer.ts`: an
Effect tracer whose `span()` writes the open file and whose `end()` writes the
finished one. The agent loop only ever calls `Effect.withSpan`; persistence is
a side effect of tracing.

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
| The system prompt                                | `source/engine/src/prompt.ts`                                        |
| Finding AGENTS.md, CLAUDE.md and skills          | `source/engine/src/instructions.ts`                                  |
| Queueing turns, approvals                        | `source/engine/src/engine.ts`                                        |
| Evaluators, feedback, learned rules              | `source/engine/src/evals.ts`, `eval-tool.ts`, `judge.ts`, `rules.ts` |
| Learning evaluators from the user's corrections  | `source/engine/src/steering.ts`, `judge.ts`, `detectors.ts`          |
| Export to Phoenix (OTLP protobuf)                | `source/engine/src/export/`                                          |
| Reading sessions back from Phoenix, storage      | `source/engine/src/remote/`, `source/cli/src/storage.ts`             |
| Sharing a session with other people              | `source/engine/src/peer/`                                            |
| The terminal interface                           | `source/cli/src/tui/`                                                |
| Slash commands and their tab completion          | `source/cli/src/tui/commands.ts`                                     |
| Commands and setup                               | `source/cli/src/main.ts`, `onboarding.ts`                            |
| Restarting on new code (`/reload`), the fallback | `source/cli/src/launcher.ts`, `reloadInto` in `main.ts`              |

## Things worth showing someone

These work best on the session you are in, because the evidence is right there.

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
- **"How do you learn from my corrections?"** Two ways. The system prompt
  tells the agent to call `create_eval` when asked for something to always or
  never do. And after each turn, `detectSteering`
  (`source/engine/src/steering.ts`) sends the prompt, the previous turn and
  the existing evaluators to the configured steering model (`modelDetector`
  in `judge.ts`, or `llmDetector` in `detectors.ts`),
  which says whether the prompt is a correction that applies beyond the
  current task, and proposes an evaluator. Above 0.7 confidence, and when no
  existing evaluator covers it, it is saved with an `origin` naming the turn,
  Every verdict becomes a `steering` annotation on the turn (`learned`,
  `durable` or `one-off`, with the confidence as score); the terminal shows
  only `learned` ones (`shownInTerminal`). Each detection is also an
  `EVALUATOR` trace with the prompt as input and the verdict as output, so
  you can read why it did or did not learn something. `steering_model` can
  name any configured `provider/model`, or `decision:<model>`: the latter
  calls System One to screen each prompt, then the judge model (or the
  agent's own model) writes an evaluator only for a durable correction.
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
- **"How does resuming work?"** There is nothing to load. `/resume` (or
  `oi -s <id>`) points the terminal at another session folder: the screen is
  rebuilt by reading its root spans, and the next model request comes from
  `contextFor` reading that session's latest `LLM` span, exactly as for the
  next step of a running turn. `/resume` lists sessions from their root spans
  (`source/cli/src/sessions.ts`) and hides ones with no turns.
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
- **"What happens when I switch model or effort mid-session?"** `/model` and
  Shift+Tab call `Engine.configure` (`source/engine/src/engine.ts`), which
  builds a new model for the next turn; nothing stored changes. Each `LLM`
  span records the model in `llm.model_name` and the effort in
  `llm.invocation_parameters`, so the switch is visible span by span. The
  history is replayed verbatim to the new model, and the API drops thinking
  blocks a different model cannot read. The levels offered come from the
  Models API's `capabilities.effort` (`listModels` in
  `source/engine/src/model.ts`).
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
  against fake CLIs in `packages/cli/test/launcher.test.ts`. `/reload` waits for a running turn. Continuing a turn that a restart
  cut short is not built yet: the next turn folds it in as interrupted.
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
- **"How do two people share one agent?"** `peer/server.ts` serves a list of
  files and a stream of events; `peer/client.ts` copies what is missing.
  Finished spans never change, so there is nothing to merge.

## Further reading

- `README.md`: what it does and how to use it.
- `PLAN.md`: the design decisions and what was measured.
- `spec-gaps.md`: what OpenInference could not express, found by building this.
