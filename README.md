# oi-agent

A coding agent whose entire runtime state is OpenInference spans on disk.

There is no conversation database and no in-memory history. Every model call,
tool call and evaluation is a span file, and the agent derives each request
from those files. The same files export to Phoenix, sync to other machines by
copying, and stream to anyone you share a session with.

Experimental. See [PLAN.md](PLAN.md) for the design and
[docs/spec-gaps.md](docs/spec-gaps.md) for what OpenInference could not express.

## Try it

Requires Node 26+, pnpm, and an Anthropic API key.

```sh
pnpm install
pnpm dev                   # builds the CLI and links `oi` into ~/.local/bin
oi                         # first run walks you through setup, then starts a session
```

`pnpm dev` bundles the CLI into one file and symlinks it onto your PATH; run
it again after changing the code. `bin/oi` runs the TypeScript sources
directly without building.

Setup asks for your name, an Anthropic API key, a model, reasoning effort,
whether tools need approval, an optional Phoenix server and where sessions
live. It checks the key and model against the API and looks for Phoenix on
`localhost:6006`. Settings are saved to `~/.config/oi-agent/config.json`;
keys go to the system keychain. Run `oi setup` to change them.

Environment variables override the file: `OI_AGENT_MODEL`, `OI_AGENT_EFFORT`,
`OI_AGENT_USER`, `OI_AGENT_HOME`, `PHOENIX_COLLECTOR_ENDPOINT`,
`PHOENIX_PROJECT_NAME`, `ANTHROPIC_API_KEY`.

| Command                        | What it does                                                              |
| ------------------------------ | ------------------------------------------------------------------------- |
| `oi`                           | Interactive session. `-c` continues the latest, `-s <id>` a specific one. |
| `oi setup`                     | Run setup again.                                                          |
| `oi run "<prompt>"`            | One prompt, headless. Add `--yolo` to let tools run unasked.              |
| `oi join <link>`               | Join a session shared with `/share`.                                      |
| `oi sessions` / `oi show <id>` | List sessions; print one.                                                 |
| `oi export [id]`               | Send sessions to Phoenix. Safe to repeat.                                 |
| `oi where`                     | Print the sessions directory.                                             |

Inside a session: `/share`, `/share local`, `/unshare`, `/evals`, `/rules`,
`/revert`, `/export`, `/yolo`, `/quit`.

## Things to try

**Look at the state.** Run a turn, then open the session folder:

```
sessions/<session-id>/
  session.json
  traces/<trace-id>/<start-ns>-<span-id>.json   one file per span
  annotations/<id>.json                         evaluator results
  inbox/<id>.json                               prompts from peers
```

Kill the process mid-turn and run `oi -c`: it continues from the files.

**Prompt an eval into existence.** Tell the agent something like "from now on,
always run the tests before telling me a change is done; set up a check for
that". It writes an evaluator to
`~/.config/oi-agent/projects/<project>/evals/`. After every later turn the
evaluator runs, its verdict is stored as an annotation and exported to
Phoenix, a failure is shown to the agent at the start of its next turn, and
the failure is distilled into a standing rule in that folder's `rules.md`.
Nothing is written into the project itself. `/revert`
undoes the latest rule.

Evaluators can also put a limit on something the harness measures. Each turn's
root span records the session's size on disk (`metadata.oi_agent.session_bytes`),
so "warn me when this conversation is larger than 100 MB" becomes a threshold
evaluator: once the session is over the limit, the agent is told at the start
of its next turn and warns you.

**Share a session.** `/share` opens a [tailcat](https://github.com/tailscale/tailcat)
tunnel (`brew install tailcat`) and prints two links: one that can send
prompts and one that is view-only. On another machine, `oi join <link>` copies
the session and follows it live. Prompts from a peer run on the host under the
peer's name; tool approvals stay with the host. `/share local` skips the
tunnel for two terminals on one machine.

**Ask it how it works.** oi ships with its own source code and a guide
([docs/how-it-works.md](docs/how-it-works.md)), and it knows where the current
session's span files are. Ask "how do you remember what I said?" or "what did
you actually send the model just now?", or type `/tour`. It answers by reading
its real code and the real spans from your conversation, so using it for
ordinary work doubles as a way to learn how agents work.

**Open it in Phoenix.** With the endpoint set, spans and annotations arrive as
they are written, grouped by session, with model, token and cost data on every
`LLM` span, including the evaluator's own model calls.

## Layout

| Path                     | Contents                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `packages/engine`        | The format, span store, tracer, fold, agent loop, evaluators, Phoenix export, peer protocol. No UI. |
| `packages/cli`           | The `oi` command and the terminal UI.                                                               |
| `tools/oxlint/anti-slop` | Vendored lint rules ([upstream](https://github.com/dmmulroy/anti-slop)).                            |

Key files in the engine, in reading order: `format.ts` (the on-disk format),
`store.ts`, `tracer.ts` (an Effect tracer that writes span files), `fold.ts`
(state derived from spans), `agent.ts` (the loop).

## License

[MIT](LICENSE)

## Development

Commits on `main` follow [Conventional Commits](https://www.conventionalcommits.org).
Pull requests are squash-merged and their titles are checked, because the
title becomes the commit. On each push to `main`, release-please keeps a
release pull request up to date; merging it tags the release and publishes
`oi-agent` to npm with provenance, using the `NPM_TOKEN` repository secret. `feat:` bumps the minor version, `fix:` the
patch, and `feat!:` or a `BREAKING CHANGE:` footer the major.

```sh
pnpm dev        # build and link the `oi` command
pnpm check      # format, lint and type-check (Vite+)
pnpm fix        # same, applying fixes
pnpm test       # Vitest
node packages/engine/bench/resume.ts 100 4000   # disk and resume cost
```
