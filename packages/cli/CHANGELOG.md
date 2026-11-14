# oi-agent

## 0.4.0

### Minor Changes

- [#19](https://github.com/cephalization/oi-agent/pull/19) [`59279a1`](https://github.com/cephalization/oi-agent/commit/59279a11961190625d4a6745a35946d1b15ba395) Thanks [@cephalization](https://github.com/cephalization)! - `/reload` restarts oi on its current code without leaving the session. The `oi` command is now a small launcher that runs the CLI and starts it again when asked to, carrying over the session, model, effort and approval mode. Before restarting, it checks that the new code loads, and keeps the current build running if it does not. If code started by a reload fails to start or crashes, oi falls back to the bundled build on the same session and says why, and a later `/reload` tries the fixed code again. If oi dies abnormally, the launcher restores the terminal's settings. Run from a checkout with `bin/oi`, this means edits to oi's own sources take effect in place. Also new: `--effort <level>`, and `--check`, which loads every module and exits.

- [#18](https://github.com/cephalization/oi-agent/pull/18) [`ce8b4dc`](https://github.com/cephalization/oi-agent/commit/ce8b4dcc4324b2e1ffe05158b1a9afb736131047) Thanks [@cephalization](https://github.com/cephalization)! - Switching to a session with `/resume`, or opening one with `oi resume` or `oi -s`, now continues on the model, provider and effort that session last used, read from its spans. An explicit `-m` still wins. If the session's model is no longer available (its provider was removed, or there is no key), oi stays on the current model and says so. New sessions keep the current model.

- [#21](https://github.com/cephalization/oi-agent/pull/21) [`268688c`](https://github.com/cephalization/oi-agent/commit/268688c06156d7da034e868ece96652c68135eff) Thanks [@cephalization](https://github.com/cephalization)! - oi learns from your corrections. After each turn a small model (the judge model, which needs an Anthropic key) reads your prompt, and when it corrects the agent in a way that applies beyond the current task, oi saves it as an evaluator, with a note under the turn and a link back to the prompt it came from. Corrections that only concern the task at hand are left alone. Turn it off with `"steering": "off"` in the config or `OI_AGENT_STEERING=off`. Also fixed: an evaluator created with `create_eval` could fail on the turn that created it, because its own definition contained the pattern it checks for.

## 0.3.0

### Minor Changes

- [#17](https://github.com/cephalization/oi-agent/pull/17) [`c8ba77d`](https://github.com/cephalization/oi-agent/commit/c8ba77d33768d40080c2487b7f39fb6c8c56d3ae) Thanks [@cephalization](https://github.com/cephalization)! - oi now follows the instruction files and skills you keep for other coding agents. At the start of a session it reads the nearest `AGENTS.md`, `AGENT.md` or `CLAUDE.md` (from the working directory up to the repository root, plus `~/.claude/CLAUDE.md` and `~/.config/AGENTS.md`). Skills in `.agents/skills/` and `.claude/skills/`, in the project or your home directory, are listed by description, and a skill is read in full only when a task calls for it. Each read shows up as a tool call in the session's spans.

- [#15](https://github.com/cephalization/oi-agent/pull/15) [`3c8cfa1`](https://github.com/cephalization/oi-agent/commit/3c8cfa1f3e0ba60f5643b46552e5625614cfefe9) Thanks [@cephalization](https://github.com/cephalization)! - - **Point model requests at a proxy:** `OPENAI_BASE_URL` now overrides the API root for the OpenAI and ChatGPT providers, as `ANTHROPIC_BASE_URL` already did for Anthropic.
  - **See pending approvals in the trace:** a tool call waiting for you to allow or deny it is now marked `awaiting_approval` on its in-flight `TOOL` span. Viewers and anything else reading the session can tell it apart from a tool that is running.
  - **A bad value in `config.json` no longer resets everything:** a value oi does not accept (a typo, or a setting from a newer version) used to make it ignore the whole file silently, so every setting went back to its default, model included. Now only that key is ignored, and oi says which one, under the banner or on stderr for `oi run`.

### Patch Changes

- [#17](https://github.com/cephalization/oi-agent/pull/17) [`5a7ea88`](https://github.com/cephalization/oi-agent/commit/5a7ea888e93096b6f538e881383b441c4ff259bd) Thanks [@cephalization](https://github.com/cephalization)! - The bash tool now says when it killed a command for running past its time limit, and how to give the command longer, instead of leaving the model to read the kill as a failure. Commands it runs see `OI_AGENT=1`, so scripts can tell they run under oi.

## 0.2.0

### Minor Changes

- [#6](https://github.com/cephalization/oi-agent/pull/6) [`6346b98`](https://github.com/cephalization/oi-agent/commit/6346b98442ffb16214de73392f20fee8f6540675) Thanks [@cephalization](https://github.com/cephalization)! - oi-agent now runs on OpenAI and OpenAI-compatible APIs, not only Anthropic's.
  
  - **Pick any provider's model:** `/model` lists every provider's models (`anthropic/claude-opus-5-5`, `openai/gpt-5.1`, `ollama/qwen3`, …), and `-m provider/model` does the same from the command line. You can switch provider in the middle of a session: the conversation carries over as text, tool calls and tool results.
  - **Manage providers with `/provider`:** a menu of Anthropic, OpenAI and OpenAI-compatible servers, each with its own options. Keys are typed into a hidden prompt and stored in the system keychain. To add a server such as Ollama, vLLM, LM Studio or OpenRouter, give it a name, a base URL, a key if it needs one, and a comma-separated list of models. Those models appear in `/model` right away, with the names and output limits the server reports. A server's models, URL and key can be changed later, or the server removed.
  - **Sign in with ChatGPT:** `/provider` → OpenAI (or `oi auth login chatgpt`) signs in with your ChatGPT plan in the browser, so you can use the plan's allowance instead of an API key. OpenAI allows this for open-source tools that run locally.
  - **Setup:** `oi setup` now starts by asking which provider to use, and `oi auth login <provider>` stores a key for any provider.
  
  Claude subscriptions are not supported, because Anthropic does not allow third-party tools to offer claude.ai login. Evaluators still judge with Claude, so they run only when an Anthropic key is set.

- [#4](https://github.com/cephalization/oi-agent/pull/4) [`6a8162d`](https://github.com/cephalization/oi-agent/commit/6a8162d607dbe8eb6868e0b013060c702327dac9) Thanks [@cephalization](https://github.com/cephalization)! - Resume any session traced to Phoenix, on any machine: `oi resume <session id>`, or paste a session URL from the Phoenix UI. A trace URL continues from that turn instead, forking the session there. The `/resume` list now includes the sessions in your Phoenix project.
  
  Sessions can also live only in Phoenix to save disk space: press Tab on one in the `/resume` list. Its local files are deleted only once Phoenix is confirmed to hold all of it. Opening it fetches it again, and leaving moves it back out. Tab again keeps it on disk.
  
  A session from another machine opens with tools asking before they run, even with `--yolo`. If your checkout differs from the one the session last ran in, oi tells you when it opens. Each turn now records its directory, git remote, commit and whether there were uncommitted changes.

- [#2](https://github.com/cephalization/oi-agent/pull/2) [`18d5377`](https://github.com/cephalization/oi-agent/commit/18d5377b2448038c3de15c3d792e5cd0495796f0) Thanks [@cephalization](https://github.com/cephalization)! - Slash commands get a completion menu: type `/` to browse, tab to complete, enter to run. New commands: `/resume` switches to a previous session, `/new` starts a fresh one, and `/model` switches model from a picker of the models your key can use. With the menu closed, tab toggles asking before tools, and shift+tab cycles reasoning effort through the levels the model supports. The status line shows both. API errors now show the API's own message.

### Patch Changes

- [#6](https://github.com/cephalization/oi-agent/pull/6) [`6b5fd8d`](https://github.com/cephalization/oi-agent/commit/6b5fd8d2be076239af564fffe8d299f61bea4366) Thanks [@cephalization](https://github.com/cephalization)! - Code blocks in a streaming reply no longer flicker between code and plain text styling while a line is still arriving.

## 0.1.0

### Minor Changes

- package the CLI for npm and add release automation ([c5a1e30](https://github.com/cephalization/oi-agent/commit/c5a1e30d03d66aa028cb34e4d0fa8b9a2936ba71))
- ship source and a guide so oi can explain how it works ([e78a234](https://github.com/cephalization/oi-agent/commit/e78a234e89dc771c5537244de75fb2686a96530d))
