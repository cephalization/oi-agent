# oi-agent plan

An agent harness whose entire runtime state is OpenInference span JSON on disk.
State is a fold over span files; nothing else is authoritative.

## Decisions

| Topic          | Decision                                                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Stack          | TypeScript + Effect for the engine. Rust/GPUI later, as a second reader of the same folder.                                        |
| Scope          | Coding agent first. Engine lives in its own package with a clean boundary so an SDK can be extracted later; no public SDK API yet. |
| Span files     | Self-contained. Each `LLM` span repeats full history. Measure disk and sync cost; no blob store yet.                               |
| File shape     | Readable JSON (the `traces.md` shape). Lossless projection to OTLP on export.                                                      |
| First provider | Anthropic.                                                                                                                         |
| Spec gaps      | Fit the spec as-is. Anything it cannot express goes in the `metadata` attribute. Every gap is logged in `docs/spec-gaps.md`.       |
| Phoenix        | Optional. Harness and local evals work offline.                                                                                    |
| Sharing        | Multi-user driving from the first `/share` version.                                                                                |
| Subagents      | A session of its own per subagent, linked to the tool call that delegated it. Not a nested span: it outlives the turn (issue #46). |
| Eval feedback  | Fully automatic, including standing prompt changes. Every change is versioned and revertible.                                      |

## Layout

```
sessions/<session-id>/
  session.json                        immutable header (id, created, cwd, origin device)
  traces/<trace-id>/                  time-sortable id; one trace per user turn
    <start-ns>-<span-id>.json         ended span, written atomically, never modified
    <start-ns>-<span-id>.open.json    in-flight span (owner device only)
    <start-ns>-<span-id>.stream.jsonl streaming deltas for the open span
  annotations/<id>.json               eval results, labels, names, human feedback
  inbox/<id>.json                     queued inputs (peer prompts, results of background work), consumed by a trace
  attachments/<sha256>.json           an image attached to a prompt, named by its content; prompts refer to it
```

Not synced, rebuildable: a local index for session lists and search, and
per-collector export cursors.

## Mapping

| Concept                             | Representation                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session                             | folder; `session.id` on every span                                                                                                                            |
| User turn                           | trace; root `AGENT` span with `input.value` / `output.value`                                                                                                  |
| Model call                          | `LLM` span. Raw request and response bodies in `input.value` / `output.value` (JSON) for lossless replay; flattened `llm.*` attributes as the normalized view |
| Tool call                           | `TOOL` span                                                                                                                                                   |
| Compaction                          | `CHAIN` span; details in `metadata`                                                                                                                           |
| Subagent                            | its own session: `session.json` names the `TOOL` span that delegated it (`parent`) and the task; its result returns through the delegator's `inbox/`          |
| Background work (a command, a task) | `metadata.job` or `metadata.task` on the `TOOL` span that started it; the turn that delivers its result names that span in `metadata.delivers`                |
| Turn order, forks                   | previous turn's trace and span id in `metadata` on the root span. Two turns naming the same predecessor are a fork                                            |
| Who sent the turn                   | `user.id` on the root span, derived from the peer's key                                                                                                       |
| Evals, labels, names                | annotation files using the spec's span / trace / session scopes                                                                                               |
| Eval feedback injected into context | a span, so it is part of the fold                                                                                                                             |
| Standing prompt change              | a span plus a versioned prompt file (and a Phoenix prompt version when connected)                                                                             |

## Rules

1. Ended span files are immutable. Sync is a union of files.
2. A trace has one writer: the device that started it. Open spans carry a
   heartbeat so a crashed turn is distinguishable from a running one.
3. Resume reads the latest `LLM` span on the active branch, not the session.
4. Secrets never enter the session tree. Keys live in the OS keychain with an
   environment fallback. Tool output is scrubbed at write time.
5. Export only ended spans. Phoenix ignores a span id it already has, so
   duplicate exports are safe and updates are impossible.

## Architecture

A headless engine owns the store and the agent loop. Every interface is a peer
speaking one protocol: send the spans I lack, tail the open ones, accept inputs.

- Local TUI: peer over loopback.
- `/share`: bundled `tailcat` sidecar exposes the same port; prints a `tc…` address.
- Remote peers: viewer or driver. A driver's prompt lands in `inbox/` and the
  host runs it as a trace. Tool approvals stay with the host.
- Write access is granted per peer key (`tailcat --allow`); read-only by default.
- Browser viewer via tailcat's WebAssembly client is a later option.

## Phoenix loop

- Export: watcher on span end for realtime, sweep with cursor for async.
- Evals run locally with `phoenix-evals` on span or trace end; results become
  annotation files and are exported. Human annotations are polled back down.
- "Prompt an eval into existence": the agent writes an evaluator file into the
  project; the engine runs it from then on.
- Feedback, all automatic:
  1. Inline: a failed eval is injected into the next step.
  2. Accumulated: failing turns collect into a dataset and distil into a
     versioned prompt section, applied without review.
  3. Experiments: replay past `LLM` spans against a candidate prompt or model.
- Safety net for automatic changes: every prompt version is kept, each change
  is a span, `/revert` restores any version, and eval scores are tracked per
  prompt version so a regression is visible.
- Full-trajectory replay re-runs tools and needs a sandbox; out of scope at first.

## Phases

1. **Spike.** Hand-written session folder; the fold; lossless resume against
   Anthropic including thinking and tool use; tailcat round trip with two
   clients. Stop and fix the format if resume is lossy.
2. **Engine and TUI.** Store, Effect tracer, agent loop with read / edit / shell
   tools, provider config, keychain, peer protocol over loopback. One-day
   benchmark of TypeScript terminal renderers before choosing one.
3. **Phoenix export and local evals** with inline feedback.
4. **`/share`.** Peer identity, viewer and driver roles, inbox, host approvals.
5. **Automatic learning.** Datasets, prompt distillation, experiments, revert.
6. **Forks, compaction, subagents, GPUI viewer.**

## Open items for the spike

- Does every field Anthropic needs to continue a conversation survive the raw
  request/response round trip?
- How does one tailcat server behave with many simultaneous clients?
- Can provider calls be routed through Phoenix so keys stay on the server?
- Disk and parse cost of self-contained spans on a long real session.

## Status (2026-11-12)

Built and verified against the live Anthropic API and a Phoenix 21 server:

- Phases 1 to 5: format, fold, engine, terminal UI, Phoenix export, local
  evaluators with feedback and learned rules, `/share` with driver and viewer
  roles over tailcat.
- Manual `/compact` now records a CHAIN/LLM checkpoint and explicit activation;
  resume from disk and Phoenix is verified. `/handoff <query>` reuses the
  summarizer and writes a self-contained destination seed before switching
  threads; restart pickup, branch isolation and Phoenix restore are verified.
  Automatic compaction is not built. Compaction replaces the whole preceding
  context; handoff submits the query separately from the generated brief.
- Built since: background commands and subagents (issues #49, #46): work
  that outlives its tool call, delivered back through the inbox.
- Not built: forks in the UI (the format supports them), the GPUI viewer, pulling human annotations back from Phoenix,
  experiments over past spans, a browser viewer.

Spike answers:

- **Lossless resume:** yes for text, tool use and signed thinking blocks.
- **tailcat with several clients:** one viewer and one driver were tested
  over a real tunnel; many simultaneous clients were not.
- **Routing provider calls through Phoenix:** not investigated.
- **Cost of self-contained spans:** resume stays fast (deriving the next
  request took 4 ms after 100 turns and 7 ms after 300), but disk grows
  quadratically: 95 MB after 100 turns and 848 MB after 300 in the benchmark
  (`packages/engine/bench/resume.ts`). History is stored twice per `LLM`
  span, once raw and once flattened. This decision needs revisiting.
  Images attached to prompts make it more pressing: an image is base64 in
  every later request of its conversation, so a 1 MB screenshot adds about
  2.7 MB to each `LLM` span that follows it (raw and flattened).
