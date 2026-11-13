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
- Use a cheap, fast model for live tests: `chatgpt/gpt-5.6-luna` (Tony's
  ChatGPT sign-in), with `claude-haiku-5-5` where Anthropic is needed.
- End-to-end checks belong in `packages/e2e` (`pnpm e2e`; read its README).
  It runs the real CLI in a sandbox, through Rex, and asserts on spans. A
  feature from an issue gets a scenario there; until it lands, mark it
  `pending: <issue>` and run it with `OI_E2E_PENDING=<issue>`.
- Test terminal UIs with Rex (the `rex` skill), not tmux. Outside a Rex
  terminal the CLI is at
  `/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex`.
  Create your own session, and close it when done.
- Decisions already made are in the table at the top of PLAN.md. Do not
  reopen them without new evidence. One is flagged for revisiting: disk cost
  of self-contained spans (see "Status" in PLAN.md).

## Commits and releases

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `ci:`, `chore:`). PR titles are checked, since PRs are squash-merged.
- Every PR gets a changeset unless Tony says otherwise: a
  `.changeset/<name>.md` file naming the package and bump
  (`"oi-agent": minor`) above a release note written for users. Changesets
  turns them into the version, the CHANGELOG and the npm release; see
  `.github/workflows/release.yml`. Write it by hand (`pnpm changeset` is
  interactive). Before 1.0, use `minor` for features and breaking changes and
  `patch` for fixes. A PR with nothing user-facing (CI, internal refactors,
  tests) gets an empty one: `pnpm changeset --empty`.
- Only the CLI is published, as one bundled file. The engine is private and
  bundled into it, so runtime dependencies belong to the engine package and
  the CLI package has none.

- The package also ships `self/`: the source, README, PLAN, spec gaps and
  `docs/how-it-works.md` (as `GUIDE.md`), assembled by `scripts/self.ts`. The
  system prompt points the agent at it so it can explain itself. When you
  change how something works, update `docs/how-it-works.md` in the same
  commit; it is what the agent teaches from.

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
  Evaluators and learned rules: `~/.config/oi-agent/projects/<name>-<hash>/`.
- The CLI will be published to npm. Never write into the project the agent is
  working on or into the installed package; user data goes under the config
  or sessions directory.
  For tests, point `OI_AGENT_CONFIG_DIR` and `OI_AGENT_HOME` at temporary
  directories so the real ones are untouched.
- `tailcat` is installed for `/share`. `/share local` avoids the tunnel.
- When capturing command output, keep it short: a failing test can print an
  entire span file.
