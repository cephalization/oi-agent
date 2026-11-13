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

| #   | Need                                                                    | Workaround                                                                              | Notes                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Say which turn a turn continues, so order and forks are derivable       | `metadata.previous = { trace_id, span_id }` on the root span                            | OTel span links could carry this, but neither the spec nor Phoenix gives links a meaning.                                                                             |
| 2   | A span that has started but not ended                                   | `.open.json` file with the same shape and `end_time: null`; file mtime is the heartbeat | OTel exports ended spans only. Never exported.                                                                                                                        |
| 3   | Streaming output of an in-flight span                                   | `.stream.jsonl` of deltas, deleted when the span ends                                   | Nothing in OTel or OpenInference models partial output.                                                                                                               |
| 4   | A prompt submitted but not yet started as a trace                       | `inbox/<id>.json`; the turn that runs it records `metadata.inbox_id`                    | Needed as soon as a second person can drive.                                                                                                                          |
| 5   | A tool call waiting for approval, and the decision                      | `metadata.awaiting_approval`, `metadata.approval = { decision, by }` on the `TOOL` span |                                                                                                                                                                       |
| 6   | A tool call that ran but returned an error to the model                 | span status `ERROR` plus `metadata.is_error`                                            | `TOOL` spans have no error-result attribute; status alone conflates "tool reported failure" with "tool crashed". The flattened tool message has no `is_error` either. |
| 7   | Link an evaluator run to the trace it judged                            | `metadata.evaluates = <trace_id>` on an `EVALUATOR` root span in its own trace          | Annotations describe the result; nothing ties the evaluator's own span to its target.                                                                                 |
| 8   | Whether an evaluation result is a pass or a failure                     | `annotation.metadata.failed`                                                            | The spec says score direction is evaluator-defined, so a consumer cannot tell failure from success without out-of-band knowledge.                                     |
| 9   | Which version of the standing prompt a turn ran under                   | `metadata.prompt_version` (content hash of the rules file)                              | `llm.prompt_template.version` is about templates, not an evolving system prompt.                                                                                      |
| 10  | Who a turn is from, with any assurance                                  | `user.id` as claimed by the peer                                                        | Self-asserted. Role comes from the share token, not identity.                                                                                                         |
| 11  | Request fields that are not messages (cache control, effort, fallbacks) | raw request body in `input.value`                                                       | The flattened attributes cannot reproduce a request; the raw body is what the fold replays.                                                                           |
| 12  | How much storage a session occupies                                     | `metadata.session_bytes` on each turn's root span, measured at turn start and end       | Nothing in the spec describes the cost of keeping a trace or session.                                                                                                 |

## Not yet checked

- A field-by-field diff between a raw Anthropic request and one rebuilt from
  the flattened `llm.*` attributes. This would list exactly what gap 11 loses.
- Images, documents, server-side tool blocks and compaction blocks.
- Providers other than Anthropic.
