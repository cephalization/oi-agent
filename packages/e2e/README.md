# End-to-end scenarios

These run the real `oi` CLI against real models (or recordings of them) and
check what happened by reading the span files it wrote. Spans are oi's only
state, so they are also the test oracle: a scenario asserts which model
served a turn, which tools ran and what was approved, not what a model
happened to say.

```sh
pnpm e2e                                  # every scenario that can run here
pnpm e2e scenarios/tui.e2e.ts             # one file
OI_E2E_PENDING=11 pnpm e2e                # also the scenarios written for issue #11
OI_E2E_MODELS=replay pnpm e2e             # from recordings: no keys, no model calls
```

## What each scenario gets

`scenario(name, options, body)` in `src/scenario.ts` wraps a Vitest test:

- **A sandbox** (`src/sandbox.ts`): its own config directory, session home,
  `TMPDIR` and a git checkout of a fixture repo (`fixtures/repos/<name>`),
  under one temp directory. On macOS the CLI runs under `sandbox-exec`: it
  cannot write outside that directory, or read the real `~/.oi-agent` or
  `~/.config/oi-agent`, even with `--yolo`. `scenarios/sandbox.e2e.ts`
  checks this.
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
included, and never stores request headers. Replies are matched in order per
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

| Issue | File                            | Notes                                                       |
| ----- | ------------------------------- | ----------------------------------------------------------- |
| #8    | `scenarios/reload.e2e.ts`       | expects `packages/cli/src/launcher.ts` and `OI_AGENT_ENTRY` |
| #9    | `scenarios/instructions.e2e.ts` | fixture `agents`: a CLAUDE.md marker and two skills         |
| #10   | `scenarios/steering.e2e.ts`     | scored over `OI_E2E_SAMPLES` runs (default 3)               |
| #11   | `scenarios/models.e2e.ts`       |                                                             |
| #12   | `scenarios/decisions.e2e.ts`    | fake System One server; `approvals: "auto"`                 |
| #13   | `scenarios/web.e2e.ts`          | fixture website; built-in search needs the real web         |

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
