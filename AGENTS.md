# Notes for agents

Read [README.md](README.md) for what this is and [PLAN.md](PLAN.md) for the
design. This file is what you would otherwise have to rediscover.

## How Tony works

- Maintainer of OpenInference and Phoenix at Arize. This repo is an
  experiment in using OpenInference spans as an agent's only state; gaps in
  the spec are a result worth recording, in [docs/spec-gaps.md](docs/spec-gaps.md).
- Gives broad latitude and checks back later. Make decisions, keep going,
  commit in logical steps, and report what was verified and what was not.
- Wants things proven live, not just type-checked: run the real CLI against
  the real API and Phoenix before calling something done.
- Use a cheap model for live tests: `OI_AGENT_MODEL=claude-haiku-5-5`.
- Test terminal UIs with Rex (the `rex` skill), not tmux. Outside a Rex
  terminal the CLI is at
  `/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`.
  Create your own session, and close it when done.
- Decisions already made are in the table at the top of PLAN.md. Do not
  reopen them without new evidence. One is flagged for revisiting: disk cost
  of self-contained spans (see "Status" in PLAN.md).

## Invariants

- **Spans are the state.** The agent loop derives every model request from
  disk through `contextFor` in `packages/engine/src/fold.ts`. Do not add an
  in-memory conversation or a second persistence path.
- **Ended span files are immutable.** Sync is a union of files. Anything
  mutable must be a new append-only file or live outside the session tree.
- **Fit the OpenInference spec.** What it cannot express goes in the
  `metadata` attribute under `oi_agent` (`EngineMetadata` in `format.ts`),
  and gets a row in docs/spec-gaps.md.
- **No secrets in the session tree or config.** Keys live in the keychain
  (service `oi-agent`); tool output is scrubbed before it reaches a span.
- **Raw request and response bodies are replayed verbatim.** Never edit a
  stored message; the API rejects altered thinking blocks.

## Toolchain

pnpm, Vite+ (`vp`), Node 26 running TypeScript directly, Effect 4, Vitest.

```sh
pnpm check     # format + lint + type-check; run before every commit
pnpm fix       # same, applying fixes (it rewrites files: re-read before editing)
pnpm test
pnpm dev       # bundle the CLI and relink ~/.local/bin/oi; rerun after changes
bin/oi         # run from source without building
```

- Only erasable TypeScript syntax: no enums, no constructor parameter
  properties.
- Effect 4 differs from 3. Its docs ship in the package:
  `node_modules/.pnpm/effect@*/node_modules/effect/ai-docs/`.
- Tests import from `vite-plus/test`.

### Lint rules that shape the code

The vendored anti-slop rules (`tools/oxlint/anti-slop`) are strict. Write
this way from the start instead of fixing afterwards:

- Parse at the boundary with an Effect `Schema`; no `typeof` narrowing, no
  `unknown` parameters, no `Record<string, unknown>`.
- No `as` without a `// SAFETY:` comment stating the invariant; no chained
  assertions. There are three justified suppressions in the engine; do not
  add more casually.
- No `...(cond ? {} : { key })`. Build the object, then assign the optional
  field in a statement.
- No explicit open-dictionary or anonymous-object annotation on a literal.
  Use a named interface, a `Map`, or let it infer.
- No `_tag` comparisons or literal `_tag` objects: use `Option.match`,
  `Exit.match`, `Match`.
- Do not import functions named `make*` across modules (treated as service
  constructors).
- Blank lines around multi-line statements are enforced and auto-fixed.

## Local environment

- Phoenix runs unauthenticated at `http://localhost:6006`; the `oi-agent`
  project there holds test data. The Phoenix repo is at `~/repos/phoenix`.
  Span ingest is protobuf-only and ignores a span id it already has.
- Config: `~/.config/oi-agent/config.json`. Sessions: `~/.oi-agent/sessions`.
  For tests, point `OI_AGENT_CONFIG_DIR` and `OI_AGENT_HOME` at temporary
  directories so the real ones are untouched.
- `tailcat` is installed for `/share`. `/share local` avoids the tunnel.
- When capturing command output, keep it short: a failing test can print an
  entire span file.
