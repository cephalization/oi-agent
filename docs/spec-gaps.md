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

| #   | Need                                                                    | Workaround                                                                                                        | Notes                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Say which turn a turn continues, so order and forks are derivable       | `metadata.previous = { trace_id, span_id }` on the root span                                                      | OTel span links could carry this, but neither the spec nor Phoenix gives links a meaning.                                                                             |
| 2   | A span that has started but not ended                                   | `.open.json` file with the same shape and `end_time: null`; file mtime is the heartbeat                           | OTel exports ended spans only. Never exported.                                                                                                                        |
| 3   | Streaming output of an in-flight span                                   | `.stream.jsonl` of deltas, deleted when the span ends                                                             | Nothing in OTel or OpenInference models partial output.                                                                                                               |
| 4   | A prompt submitted but not yet started as a trace                       | `inbox/<id>.json`; the turn that runs it records `metadata.inbox_id`                                              | Needed as soon as a second person can drive.                                                                                                                          |
| 5   | A tool call waiting for approval, and the decision                      | `metadata.awaiting_approval`, `metadata.approval = { decision, by, answers?, asked_because? }` on the `TOOL` span |                                                                                                                                                                       |
| 6   | A tool call that ran but returned an error to the model                 | span status `ERROR` plus `metadata.is_error`                                                                      | `TOOL` spans have no error-result attribute; status alone conflates "tool reported failure" with "tool crashed". The flattened tool message has no `is_error` either. |
| 7   | Link an evaluator run to the trace it judged                            | `metadata.evaluates = <trace_id>` on an `EVALUATOR` root span in its own trace                                    | Annotations describe the result; nothing ties the evaluator's own span to its target.                                                                                 |
| 8   | Whether an evaluation result is a pass or a failure                     | `annotation.metadata.failed`                                                                                      | The spec says score direction is evaluator-defined, so a consumer cannot tell failure from success without out-of-band knowledge.                                     |
| 9   | Which version of the standing prompt a turn ran under                   | `metadata.prompt_version` (content hash of the rules file)                                                        | `llm.prompt_template.version` is about templates, not an evolving system prompt.                                                                                      |
| 10  | Who a turn is from, with any assurance                                  | `user.id` as claimed by the peer                                                                                  | Self-asserted. Role comes from the share token, not identity.                                                                                                         |
| 11  | Request fields that are not messages (cache control, effort, fallbacks) | raw request body in `input.value`                                                                                 | The flattened attributes cannot reproduce a request; the raw body is what the fold replays.                                                                           |
| 12  | How much storage a session occupies                                     | `metadata.session_bytes` on each turn's root span, measured at turn start and end                                 | Nothing in the spec describes the cost of keeping a trace or session.                                                                                                 |
| 13  | Where a session ran (directory, repository, commit)                     | `metadata.workspace` on each turn's root span                                                                     | The spec has no session-level attributes, so facts about the session are repeated per turn. Needed to resume a session from Phoenix on another machine.               |
| 14  | A stable id for an annotation across systems                            | the local id in the annotation's own `metadata.oi_agent.id`                                                       | Phoenix assigns annotation ids on ingest; the spec does not say whether a producer's id survives.                                                                     |
| 15  | The wire format of an `LLM` span's raw bodies                           | `metadata.api` (`anthropic-messages`, `openai-chat`, `openai-responses`) on the `LLM` span                        | `input.mime_type` says JSON, not which API's JSON; `llm.system` / `llm.provider` name a vendor, and one vendor has several APIs. Replay needs to know which.          |
| 16  | Which configured endpoint served a call                                 | `metadata.provider`, also put in `llm.provider`                                                                   | `llm.provider` has well-known values (`openai`, `anthropic`, …); a self-hosted or third-party OpenAI-compatible server has none, so its configured name is used.      |

| 17 | Which harness policy asked a decision model | `metadata.purpose` on the `DECISION` span | `approval` or `steering`; the standard attributes describe the model and usage, not the requesting policy. |

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

- `operation = "handoff"` and `handoff_target` on the source command's `AGENT`
  root. The destination id is derived from this trace id. No checkpoint is
  activated in the source context.
- `handoff = { source_session_id, checkpoint: { trace_id, span_id } }` on the
  destination seed, linking back to the real source summarization operation.
- `handoff_seed = { trace_id, span_id }` on the first destination agent turn,
  recording consumption of its local seed. `previous` is null: this is a new
  conversation, not a continuation edge across sessions.

The seed is an ended span so it exports/imports through Phoenix even if no
model call has started in the destination. Query and brief remain distinct in
the first model request. The fold never fetches source-session files. A seed
is picked up only while the destination has no agent turns; interrupted turns
are not automatically rerun because tools may have had effects. This policy
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
