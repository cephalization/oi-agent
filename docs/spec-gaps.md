# OpenInference spec gaps

What the harness needed that the spec could not express, found by building
it. Every gap is worked around in the `metadata` attribute under the
`oi_agent` key (see `EngineMetadata` in `packages/engine/src/format.ts`) or
in a file beside the spans. These are observations to bring to the
OpenInference team, not proposals.

## Where the spec was enough

- **Replay of reasoning.** `message_content.type = "reasoning"` with
  `message_content.signature`, and `tool_use` content parts for ordering,
  cover Anthropic thinking blocks. Verified live: a turn with a signed
  thinking block and a tool call was continued from span files alone.
- **Evaluator results.** Trace-scoped annotations map directly onto Phoenix's
  annotation endpoints.
- **Token detail.** `prompt_details.cache_read` / `cache_write` were enough
  for Phoenix to compute cost. Note the convention differs from Anthropic's:
  OpenInference counts cached tokens inside the prompt total.

## Gaps

| #   | Need                                                                    | Workaround                                                                                                                                                                                                                                                                | Notes                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Say which turn a turn continues, so order and forks are derivable       | `metadata.previous = { trace_id, span_id }` on the root span                                                                                                                                                                                                              | OTel span links could carry this, but neither the spec nor Phoenix gives links a meaning.                                                                                                                    |
| 2   | A span that has started but not ended                                   | `.open.json` file with the same shape and `end_time: null`; file mtime is the heartbeat                                                                                                                                                                                   | OTel exports ended spans only. Never exported.                                                                                                                                                               |
| 3   | Streaming output of an in-flight span                                   | `.stream.jsonl` of deltas, deleted when the span ends                                                                                                                                                                                                                     | Nothing in OTel or OpenInference models partial output.                                                                                                                                                      |
| 4   | A prompt submitted but not yet started as a trace                       | `inbox/<id>.json`; the turn that runs it records `metadata.inbox_id`                                                                                                                                                                                                      | Needed as soon as a second person can drive.                                                                                                                                                                 |
| 5   | A tool call waiting for approval, and the decision                      | `metadata.awaiting_approval`, `metadata.approval = { decision, by, answers?, asked_because? }` on the `TOOL` span                                                                                                                                                         |                                                                                                                                                                                                              |
| 6   | A tool call that ran but returned an error to the model                 | span status `ERROR` plus `metadata.is_error`                                                                                                                                                                                                                              | `TOOL` spans have no error-result attribute; status alone conflates "tool reported failure" with "tool crashed". The flattened tool message has no `is_error` either.                                        |
| 7   | Link an evaluator run to the trace it judged                            | `metadata.evaluates = <trace_id>` on an `EVALUATOR` root span in its own trace                                                                                                                                                                                            | Annotations describe the result; nothing ties the evaluator's own span to its target.                                                                                                                        |
| 8   | Whether an evaluation result is a pass or a failure                     | `annotation.metadata.failed`                                                                                                                                                                                                                                              | The spec says score direction is evaluator-defined, so a consumer cannot tell failure from success without out-of-band knowledge.                                                                            |
| 9   | Which version of the standing prompt a turn ran under                   | `metadata.prompt_version` (content hash of the rules file)                                                                                                                                                                                                                | `llm.prompt_template.version` is about templates, not an evolving system prompt.                                                                                                                             |
| 10  | Who a turn is from, with any assurance                                  | `user.id` as claimed by the peer                                                                                                                                                                                                                                          | Self-asserted. Role comes from the share token, not identity.                                                                                                                                                |
| 11  | Request fields that are not messages (cache control, effort, fallbacks) | raw request body in `input.value`                                                                                                                                                                                                                                         | The flattened attributes cannot reproduce a request; the raw body is what the fold replays.                                                                                                                  |
| 12  | How much storage a session occupies                                     | `metadata.session_bytes` on each turn's root span, measured at turn start and end                                                                                                                                                                                         | Nothing in the spec describes the cost of keeping a trace or session.                                                                                                                                        |
| 13  | Where a session ran (directory, repository, commit)                     | `metadata.workspace` on each turn's root span                                                                                                                                                                                                                             | The spec has no session-level attributes, so facts about the session are repeated per turn. Needed to resume a session from Phoenix on another machine.                                                      |
| 14  | A stable id for an annotation across systems                            | the local id in the annotation's own `metadata.oi_agent.id`                                                                                                                                                                                                               | Phoenix assigns annotation ids on ingest; the spec does not say whether a producer's id survives.                                                                                                            |
| 15  | The wire format of an `LLM` span's raw bodies                           | `metadata.api` (`anthropic-messages`, `openai-chat`, `openai-responses`) on the `LLM` span                                                                                                                                                                                | `input.mime_type` says JSON, not which API's JSON; `llm.system` / `llm.provider` name a vendor, and one vendor has several APIs. Replay needs to know which.                                                 |
| 16  | Which configured way of reaching a model served a call                  | `metadata.provider` (oi's provider id: `chatgpt`, `openai`, `ollama`, …). `llm.provider` names who served it: `openai` for both an OpenAI API key and the ChatGPT plan sign-in, a compatible server's declared `vendor`, and the provider id only when no vendor is known | `llm.provider` has well-known values for vendors. It has no place for the account or endpoint a call went through, and two of those can share a vendor. A self-hosted server has no well-known value at all. |

| 17 | Which harness policy asked a decision model | `metadata.purpose` on the `DECISION` span | `approval` or `steering`; the standard attributes describe the model and usage, not the requesting policy. |
| 18 | What a tool call did to the workspace | `metadata.evidence` (`writes`, `commit`: `yes`/`no`/`unknown`) on the `TOOL` span | A `TOOL` span records input and output, not observed side effects; a shell command's text does not say whether it changed files or made a commit. |
| 19 | An evaluation that did not apply | annotation label `skipped`, with `metadata.skipped`, `metadata.applicability` (trigger and evidence) and, for a recheck, `metadata.rechecks` | Annotations have a label and a score but no notion of "not applicable"; a skip is a label by convention, never counted as a pass or a failure. |
| 20 | A tool call whose work continues after its span ends | `metadata.job = { id, log, reason }` on the `TOOL` span, which ends with the output so far; the command's log and exit code are files outside the session tree | A span has one end. OTel's answer for work that outlives its initiator is a new span linked to it, but a shell command has no span of its own to link from, and Phoenix does not store links. |
| 21 | The result of background work arriving later, and which call it answers | an `inbox/` entry with `delivers = { kind, id, trace_id, span_id }`; the turn that hands it to the model has `user.id` `oi` and `metadata.delivers`, each item naming the inbox entry and the `TOOL` span that started the work; polling/cancellation records the same link on the observing `TOOL`, with `metadata.observed_results` on its turn indexing consumed inbox ids | The consumer side of the same gap: this is what a span link from the delivering turn to the initiating span would say. Kept in `metadata` until links are stored end to end. Extends gap 4, which covers prompts waiting in the inbox. |
| 22 | A session that another session started, and why | `parent = { session_id, trace_id, span_id }` and `task = { id, title, isolation, model, worktree? }` in `session.json`; `metadata.task = { id, session_id, started_runner? }` on the delegating/follow-up `TOOL` span | `session.id` groups traces; nothing says one session came from a span in another. A subagent is a session, not a nested span, because it outlives the turn that starts it and has its own writer. |
| 23 | A prompt sent by a tool call in another session (a brief, a follow-up) | `origin = { session_id, trace_id, span_id }` on the `inbox/` entry and in `metadata` on the root span of the turn that runs it | The producer side of gap 21, across sessions. `user.id` says whose turn it is, not which call sent it. |
| 24 | How a model call was paid for | `metadata.billing` on the `LLM` span: `plan` (a subscription's allowance, as with the ChatGPT sign-in) or `api` (per token) | `llm.cost.*` holds amounts, and backends compute them from the model name and token counts at list price. Nothing says a call was covered by a flat-rate plan, so its list price reads as spend. |

Decision models use OpenInference's `DECISION` span kind and `decision.*`
model/token attributes without any `llm.*` attributes. The harness-specific
purpose (`approval` or `steering`) is stored as `metadata.oi_agent.purpose`:
the spec says what model answered, not which harness policy requested it.
Approval answers and the reason a human was asked extend gap 5 above; the
model's answer is not the same thing as permission to run a tool.

## Context checkpoint semantics

A `CHAIN` span with an `LLM` child accurately describes summarization, but
OpenInference does not say which context it replaces or when it becomes
active. The manual compaction implementation records:

- `metadata.oi_agent.operation = "compact"` on the command's `AGENT` root.
- `metadata.oi_agent.compaction = { source: { trace_id, span_id }, trigger,
  policy_version }` on the `context.compact` chain. Its output is the brief.
- `metadata.oi_agent.checkpoint = { trace_id, span_id }` on the successful
  root: explicit activation of that ended chain, not "use the latest summary".

The source head identifies the whole replaced context on that branch. Failed
or open roots do not activate a checkpoint. Summarizer model calls are nested
under the chain, not treated as agent continuation calls. This is harness
replay policy, not a standard meaning of `CHAIN`. Live testing verified that
the new fields and brief survive Phoenix export/import with identical folded
context. No historical request or response is rewritten.

## Handoff between sessions

A root destination `CHAIN` (`handoff.seed`) records the actual bootstrap
operation: input is the user's exact query, output is the generated brief.
OpenInference has no context-transfer or durable-prompt-consumption semantics.
The harness records these under `metadata.oi_agent`:

- `operation = "handoff"`, `handoff_target`, and `checkpoint` on the source
  command's `AGENT` root, flushed before destination initialization. Together
  with the exact query on the root and the ended summary child, this is a
  durable intent to repair a missing destination seed after a crash. The
  destination id is derived from this trace id. The checkpoint is not activated
  in the source context.
- `handoff = { source_session_id, checkpoint: { trace_id, span_id } }` on the
  destination seed, linking back to the real source summarization operation.
- `handoff_seed = { trace_id, span_id }` on the first destination agent turn,
  recording consumption of its local seed. `previous` is null: this is a new
  conversation, not a continuation edge across sessions.

The seed is an ended span so it exports/imports through Phoenix even if no
model call has started in the destination. Query and brief remain distinct in
the first model request. The fold never fetches source-session files. A seed
is picked up before ordinary queued or inbox prompts, only while the destination
has no agent turns; interrupted turns are not automatically rerun because tools
may have had effects. This policy
is harness-specific, not a standard meaning of `CHAIN` or `session.id`.

## Round trip through Phoenix

Checked by importing a session back from Phoenix's REST API
(`/v1/projects/{project}/spans/otlpv1`, `/v1/sessions/{id}`) and comparing
files and the fold's output:

- `input.value` and `output.value` come back byte for byte, so the model
  context rebuilt from Phoenix was identical for every turn checked.
- JSON-string attributes (`metadata`, `tool.parameters`,
  `llm.prompt_template.variables`, `document.metadata`) are parsed on ingest
  and returned flattened into dotted keys, even by the OTLP-shaped endpoint.
  They can be re-nested, but `null` values, empty objects and empty arrays are
  lost, and a key that contains a dot is ambiguous.
- Times come back at microsecond precision, as nanoseconds computed from a
  float. Span file names embed the start time, so an imported copy of a span
  has a different name from the original.
- An empty status message comes back as `null`; ids, parents, names, status
  codes and span kinds are unchanged.

## Not yet checked

- A field-by-field diff between a raw Anthropic request and one rebuilt from
  the flattened `llm.*` attributes. This would list exactly what gap 11 loses.
- Images, documents, server-side tool blocks and compaction blocks.
- Providers other than Anthropic.

## Relations as span links

Gaps 1, 21 and 23 are relations between spans that are not parent and child:
the turn a turn continues, the tool call whose background work a turn
delivers (and the subagent turn that produced the result), and the tool call
in another session that sent a turn's prompt. OpenTelemetry states these as
span links, and its guidance for work that outlives its initiator is a new
trace linked to it, not a long-lived child. Span files keep the relations in
`metadata`, since readers of the folder need them and Phoenix does not store
links yet. The OTLP projection (`linksOf` in `export/otlp.ts`) also writes
each one as a real link, with an `oi_agent.relation` attribute naming the
metadata field it restates, so nothing is lost when a backend does keep them.
