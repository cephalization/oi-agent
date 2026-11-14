# oi-agent

[![npm](https://img.shields.io/npm/v/oi-agent)](https://www.npmjs.com/package/oi-agent)

A coding agent whose entire runtime state is OpenInference spans on disk.

There is no conversation database and no in-memory history. Every model call,
tool call and evaluation is a span file, and the agent derives each request
from those files. The same files export to Phoenix, sync to other machines by
copying, and stream to anyone you share a session with.

Experimental. See [PLAN.md](PLAN.md) for the design and
[docs/spec-gaps.md](docs/spec-gaps.md) for what OpenInference could not express.

## Try it

Requires Node 24+ and one of: an Anthropic API key, an OpenAI API key, a
ChatGPT plan, or any OpenAI-compatible server (Ollama, vLLM, LM Studio,
OpenRouter, …).

```sh
npm install -g oi-agent    # installs the `oi` command
oi                         # first run walks you through setup, then starts a session
```

Or run it once without installing: `npx oi-agent`.

Setup asks for your name, a provider and its key (or a ChatGPT sign-in), a
model, reasoning effort, whether tools need approval, an optional Phoenix
server and where sessions live. It lists the provider's models, checks the
key, and looks for Phoenix on `localhost:6006`. Settings are saved to
`~/.config/oi-agent/config.json`; keys and sign-ins go to the system
keychain. Run `oi setup` to change them.

Environment variables override the file: `OI_AGENT_MODEL` (a model id, or
`provider/model`), `OI_AGENT_PROVIDER`, `OI_AGENT_EFFORT`, `OI_AGENT_USER`,
`OI_AGENT_HOME`, `OI_AGENT_STEERING`, `PHOENIX_COLLECTOR_ENDPOINT`, `PHOENIX_PROJECT_NAME`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. `ANTHROPIC_BASE_URL` and
`OPENAI_BASE_URL` send model requests somewhere else, such as a proxy.

| Command                        | What it does                                                              |
| ------------------------------ | ------------------------------------------------------------------------- |
| `oi`                           | Interactive session. `-c` continues the latest, `-s <id>` a specific one. |
| `oi resume <id or URL>`        | Continue a session from disk or from Phoenix (see below).                 |
| `oi setup`                     | Run setup again.                                                          |
| `oi run "<prompt>"`            | One prompt, headless. Add `--yolo` to let tools run unasked.              |
| `oi join <link>`               | Join a session shared with `/share`.                                      |
| `oi sessions` / `oi show <id>` | List sessions; print one.                                                 |
| `oi export [id]`               | Send sessions to Phoenix. Safe to repeat.                                 |
| `oi auth login [provider]`     | Store a provider's key; `oi auth login chatgpt` signs in with ChatGPT.    |
| `oi where`                     | Print the sessions directory.                                             |

Inside a session, type `/` for a menu of commands: Tab completes, ↑↓ pick,
Enter runs. `/resume` switches to an earlier session, picked from a list you
can filter by its first prompt or directory; `/new` starts a fresh one.
With Phoenix connected, the list also has the sessions in your Phoenix
project, and Tab on a session moves it between this disk and Phoenix-only
storage. `/model` switches model, or provider, from the next turn on, picked
from every provider's models (`anthropic/claude-opus-5-5`,
`openai/gpt-5.1`, `ollama/qwen3`, …). `/provider` opens a menu of
Anthropic, OpenAI and OpenAI-compatible servers. Under each are its options:
an API key (hidden as you type, kept in the keychain), signing in with a
ChatGPT plan in the browser, or adding a server by name, base URL, optional
key and a comma-separated list of models. A server's models go straight into
`/model`, with the name and output limit the server reports for each. Switching provider mid-session works: the conversation carries over
as text, tool calls and tool results. With the menu closed, Tab toggles between asking before tools
and running them unasked (yolo), and Shift+Tab cycles reasoning effort
through the levels the current model accepts. The others are `/share`,
`/share local`, `/unshare`, `/evals`, `/rules`, `/revert`, `/export`,
`/yolo`, `/tour`, `/help` and `/quit`.

### From source

Requires Node 26+ and pnpm.

```sh
pnpm install
pnpm dev                   # builds the CLI and links `oi` into ~/.local/bin
```

`pnpm dev` bundles the CLI, copies the build to
`~/.local/share/oi-agent/builds/` (keeping the last five) and links it onto
your PATH; run it again after changing the code. Since `oi` runs a copy,
rebuilding the repo never changes an `oi` that is already installed or
running, and `pnpm dev` refuses to run from inside oi itself unless given
`--force`. `bin/oi` runs the TypeScript sources directly without building.

`oi` is a small launcher that starts the CLI and starts it again on
`/reload`, keeping the session. Under `bin/oi` that means edits to the
sources take effect without leaving the session. If they break startup, the
launcher falls back to the last `pnpm build`.

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

**Or just correct it.** You don't have to ask for a check. After each turn a
small model reads your prompt, and when it corrects the agent in a way that
applies beyond the task at hand ("hmm, var? this codebase is const/let only",
not "call it msg here"), oi learns it as an evaluator by itself and notes it
under the turn (`◆ steering: learned`). The evaluator records the prompt it
came from. Set `"steering": "off"` in the config (or `OI_AGENT_STEERING=off`)
to stop it. It needs an Anthropic key, like the other evaluators. How it was
measured, and what went wrong in measuring it: [docs/experiments/steering.md](docs/experiments/steering.md).

Evaluators can also put a limit on something the harness measures. Each turn's
root span records the session's size on disk (`metadata.oi_agent.session_bytes`),
so "warn me when this conversation is larger than 100 MB" becomes a threshold
evaluator: once the session is over the limit, the agent is told at the start
of its next turn and warns you.

**Bring your agent files.** In a project set up for other coding agents, oi
reads the nearest `AGENTS.md`, `AGENT.md` or `CLAUDE.md` (up to the repository
root, plus `~/.claude/CLAUDE.md` and `~/.config/AGENTS.md`) at the start of a
session and follows it. Skills in `.agents/skills/` and `.claude/skills/`, in
the project or your home directory, are listed by description and read in full
only when a task calls for one.

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

**Resume it from Phoenix.** Phoenix ends up holding everything a session needs
to continue, so any session traced there can be picked up again, on any
machine: `oi resume <session id>`, or paste a session URL from the Phoenix UI.
A trace URL continues from that turn instead of the latest one, forking the
session there. The spans are written back to disk, and new turns go to the
same Phoenix session.

To save space, a session can live only in Phoenix: press Tab on it in the
`/resume` list. Its files are deleted once Phoenix is confirmed to hold every
span and annotation. Opening it fetches it again, and leaving moves it back
out. A session from another machine opens with tools asking before they run,
and the opening notes say if your checkout differs from the one it last ran
in.

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
title becomes the commit. Releases use [Changesets](https://github.com/changesets/changesets):
each pull request that changes something users see adds a `.changeset/*.md`
file (`pnpm changeset`) naming the bump and a release note. On each push to
`main`, a "version packages" pull request collects them into versions and
`CHANGELOG.md`; merging it publishes `oi-agent` to npm with provenance,
using the `NPM_TOKEN` repository secret, and tags a GitHub release.

```sh
pnpm dev        # build and install the `oi` command
pnpm check      # format, lint and type-check (Vite+)
pnpm fix        # same, applying fixes
pnpm test       # Vitest
pnpm e2e        # end-to-end scenarios against the real CLI (packages/e2e)
node packages/engine/bench/resume.ts 100 4000   # disk and resume cost
```
