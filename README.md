# oi-agent

[![npm](https://img.shields.io/npm/v/oi-agent)](https://www.npmjs.com/package/oi-agent)

A terminal coding agent you can inspect, resume and share. oi reads and edits
code, runs commands, and helps you work through software engineering tasks.

Its runtime state is [OpenInference](https://github.com/Arize-ai/openinference)
spans on disk—not a separate conversation database. You can see what the model
was sent, pick up a session later, or explore it in Phoenix. Experimental.

## Get started

Requires Node 24+ and an Anthropic or OpenAI API key, a ChatGPT plan, or an
OpenAI-compatible server such as Ollama, vLLM or LM Studio.

```sh
npm install -g oi-agent    # installs the `oi` command
cd your-project
oi                        # first run walks you through setup
```

Or try it without installing: `npx oi-agent`.

Ask it to explain some code, fix a bug, or run your tests. Tools ask for
approval by default. Type `/` for commands, use `oi -c` to continue your latest
session, and run `oi setup` to change your provider or settings.

## What you can do

- **Work with your models.** Use Anthropic, OpenAI, a ChatGPT plan or local
  models, and switch providers during a session.
- **Keep working while tasks run.** Background commands and subagents report
  back when finished. Set `"delegation": "off"` in config if you prefer work
  in one conversation.
- **Teach it your preferences.** Durable corrections can become checks on
  later work, with feedback and reversible learned rules.
- **Pick up and share work.** Resume from disk or Phoenix, compact context,
  hand off to a new thread, or invite someone to a live session.
- **Look inside.** Inspect every model and tool call. oi ships with its own
  source and guide; ask how it works or try `/tour`.

## Learn more

- [Using oi](docs/how-it-works.md#using-oi): configuration, commands, approvals,
  learning, delegation and sharing.
- [How oi works](docs/how-it-works.md#the-one-idea): the span-based design and
  a map to the bundled source. This guide ships with oi as `self/GUIDE.md`.
- [Contributing](docs/how-it-works.md#contributing): run from source, checks
  and release workflow.
- [Design and status](PLAN.md) · [OpenInference spec gaps](docs/spec-gaps.md)

## License

[MIT](LICENSE)
