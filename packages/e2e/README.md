# End-to-end scenarios

These run the real `oi` CLI against real models (or recordings of them) and
check what happened by reading the span files it wrote. Spans are oi's only
state, so they are also the test oracle: a scenario asserts which model
served a turn, which tools ran and what was approved, not what a model
happened to say.

```sh
pnpm e2e                                  # every scenario that can run here (2 to 3 minutes live)
pnpm e2e scenarios/tui.e2e.ts             # one file
pnpm e2e:scored                           # the scored experiments (see "Scored live samples")
OI_E2E_PENDING=12 pnpm e2e                # also the scenarios written for issue #12
OI_E2E_MODELS=replay pnpm e2e             # from recordings: no keys, no model calls
```

Scenario files run side by side, four at a time (`OI_E2E_WORKERS`), and the
scenarios in a file run in order. Each has its own sandbox, model proxy and
Rex sessions, so they share nothing by default. One that does touch
something outside its sandbox says so with `exclusive`: the scenarios that
rebuild or run the repo's `packages/cli/dist` are `exclusive: "bundle"`, and
take turns across files. The runner prints each scenario's duration, and the
total at the end.

The harness sets `"delegation": "off"`, so the agent does the work a
scenario asks for itself and never hands it to a subagent. Scenarios about
delegation (`scenarios/tasks.e2e.ts`) turn it back on.

## What each scenario gets

`scenario(name, options, body)` in `src/scenario.ts` wraps a Vitest test:

- **A sandbox** (`src/sandbox.ts`): its own config directory, session home,
  `TMPDIR` and a git checkout of a fixture repo (`fixtures/repos/<name>`),
  under one temp directory. On macOS the CLI runs under `sandbox-exec`: it
  cannot write outside that directory, or read the real `~/.oi-agent` or
  `~/.config/oi-agent`, even with `--yolo`. `scenarios/sandbox.e2e.ts`
  checks this. It also hides your own agent instructions and skills
  (`~/.claude`, `~/.agents`, `~/.config/AGENTS.md`), so oi sees only the
  fixture's. Elsewhere they are not hidden: run on a machine without them.
- **Terminals** (`src/term.ts`): `tui()` starts the interactive CLI in a
  headless Rex session (80×24) to type into and read. Every Rex session is
  closed when the scenario ends.
- **`run()`** for `oi run`, `oi export` and anything else without a terminal.
- **Span queries** (`src/spans.ts`): turns, tool calls with their input,
  output and approval, the model and effort of each call, the system prompt,
  and the process that owns an in-flight turn (for crash tests).
  `settledTurns()` waits for turns to finish, and fails at once if a tool
  call is left waiting for an approval nobody will give.
- **Fakes** (`src/fakes.ts`): a fixture website (`fixtures/web`) and a
  System One decision server, which record what they were sent.

When a scenario fails, its error includes an outline of every session (turns,
model calls, tool calls) and the last screen of each terminal. Set
`OI_E2E_KEEP=1` to keep the sandbox of a failed scenario.

## Models

| Variable                 | Default                      | Used for                                     |
| ------------------------ | ---------------------------- | -------------------------------------------- |
| `OI_E2E_MODEL`           | `chatgpt/gpt-5.6-luna`       | everything (fast, on a ChatGPT sign-in)      |
| `OI_E2E_SECOND_MODEL`    | `anthropic/claude-haiku-5-5` | switching between providers and dialects     |
| `OI_E2E_ANTHROPIC_MODEL` | `anthropic/claude-haiku-5-5` | what only Anthropic offers (built-in search) |

A scenario whose model has no credentials (keychain or environment) is
skipped, not failed.

`OI_E2E_MODELS` picks where replies come from:

- `live` (default): the real APIs.
- `record`: the real APIs through a local proxy that saves every exchange to
  `cassettes/<scenario>.json.gz`.
- `replay`: the proxy answers from the cassette, so no keys are needed and
  nothing leaves the machine.

The proxy sits in front of the CLI through `ANTHROPIC_BASE_URL` and
`OPENAI_BASE_URL`. It stores response bodies byte for byte, streams
included, and never stores request headers. OpenAI's Responses API is also
proxied over a WebSocket, which the CLI uses by default; a socket exchange is
stored in the same form as an HTTP one, so one cassette replays over either
transport. Replies are matched in order per
method, path and model, so after changing a scenario's prompts, record it
again. Replay serves the ChatGPT model as `openai/`, since a ChatGPT
sign-in cannot be faked. Scenarios marked `liveOnly` (scored ones, real web
search, prompts that name per-run paths) are skipped in replay.

CI runs the replayable scenarios that need neither Rex nor `sandbox-exec`
(the `e2e` job in `.github/workflows/ci.yml`, with Phoenix as a service).

## Phoenix

With Phoenix at `OI_E2E_PHOENIX` (default `http://localhost:6006`), each
scenario sends one `CHAIN` span about itself (verdict, notes, scores) to the
`oi-agent-e2e` project, carrying the `session.id` of the first oi session it
drove. Scenarios with `phoenix: true` also have the CLI export there. Set
`OI_E2E_TRACE=0` to turn the reporting off.

## Pending scenarios

A scenario for an issue that is not built yet is written from the issue's
acceptance list and marked `pending: <issue>`. It is skipped unless
`OI_E2E_PENDING` names the issue (or is `all`). Building the feature means
making its scenarios pass, then removing `pending`.

| Issue | File                            | Notes                                               |
| ----- | ------------------------------- | --------------------------------------------------- |
| #9    | `scenarios/instructions.e2e.ts` | fixture `agents`: a CLAUDE.md marker and two skills |
| #13   | `scenarios/web.e2e.ts`          | fixture website; built-in search needs the real web |

## Writing a scenario

- Assert on spans first and on the screen second. Never assert on a model's
  exact wording; ask for something checkable ("reply with just the number").
- Tell the model to call a tool rather than ask whether it may: some models
  ask in prose, and oi does the asking. `src/steps.ts` has `callBash()` for
  the prompt and `awaitApproval()`, which fails at once, with the model's
  answer, if the turn ends without the tool call.
- Wait on spans (`settledTurns`) rather than sleeping.
- Keep secrets out of fixtures. Use `FAKE_SECRET`, which is built at run
  time.

## Real decision service

`pnpm e2e scenarios/typesafe.e2e.ts` uses a real TypeSafe key (keychain account
`typesafe`, or `TYPESAFE_API_KEY`) and the cheap default chat model. It checks
auto approval, hard-rule denial, steering screen/writer routing, and absence
of the key from spans. It reports decision latency and estimated cost.
The harness hides TypeSafe credentials from unrelated scenarios, so installing
a key cannot change their Tab cycle or make replay call the real decision API.
Without a key this scenario skips with `no TypeSafe credentials`; it is live-only and
has no replay cassette. `scenarios/decisions.e2e.ts` continues to use the
local fake, including an explicitly empty key override for its no-key case,
so installing a real key does not change that test's meaning.

## Scored live samples

A scored experiment judges a rate over many live samples and takes minutes,
so it is not part of `pnpm e2e`. It lives in a `scenarios/*.scored.ts` file
and runs with `pnpm e2e:scored` (`OI_E2E_SCORED=1`). Run it when a change
touches what it scores: `steering.scored.ts` covers steering detection,
learning from corrections and the evaluators they become. Its cases and the
single-case scenarios in `steering.e2e.ts` share `src/steering.ts`.

Declare `liveOnly: true, samples: true`, then call `s.samples(jobs, body)`.
Each job **and retry** receives its own fixture checkout, config, session home,
`Spans` and headless `run()`. Child sandboxes inherit the scenario's settings
and environment and are closed/disposed with it (`OI_E2E_KEEP=1` retains them
on failure). No Rex or recording proxy is allowed in this mode.

`OI_E2E_CONCURRENCY` defaults to 4; set it to 1 for an isolated serial control.
`OI_E2E_SAMPLES` controls repetitions in the steering experiment (default 3).
Both must be positive integers. Workers drain before a failure is reported,
so cleanup cannot delete an in-flight worker's sandbox. A sample failing with
`The ChatGPT user is temporarily unavailable` gets one fresh-sandbox retry;
other errors are not retried. Retries are reported in notes and result rows.

`s.results(rows)` saves scored results as JSON in `OI_E2E_RESULTS_DIR`
(default: `$TMPDIR/oi-e2e-results`), outside disposable sandboxes. The runner
prints one results table, even on assertion failure, and attaches those same
rows to its Phoenix span's `metadata.oi_e2e.results`. Steering rows identify
case, repetition, learned outcome, evaluator filenames and their producer
(agent or detector), retries, duration and session IDs. Evaluator files remain
available until cleanup, or afterwards when a failed sandbox is kept.
