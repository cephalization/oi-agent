# OpenInference spec gaps

Running log of things the harness needs that the spec cannot express today.
Each gap is worked around in the `metadata` attribute unless noted. Entries are
candidates to bring to the OpenInference team, not proposals yet.

Format: what is needed, how it is worked around, whether it has been confirmed
against the spec text.

## 1. Ordering and branching between traces

- **Need:** a turn must name the turn it continues, so order and forks are
  derivable without sequence numbers.
- **Workaround:** previous trace id and root span id in `metadata` on the root span.
- **Status:** anticipated. OTel span links could carry this; not yet checked
  whether the spec or Phoenix gives links any meaning.

## 2. In-flight spans

- **Need:** represent a span that has started but not ended, with streaming
  output and a liveness signal.
- **Workaround:** `.open.json` and `.stream.jsonl` files beside the span; never exported.
- **Status:** anticipated. OTel only exports ended spans.

## 3. Lossless replay of model calls

- **Need:** everything a provider requires to continue a conversation
  (thinking signatures, cache markers, server-side tool blocks).
- **Workaround:** raw request and response bodies in `input.value` / `output.value`.
- **Status:** unverified. The spike must list which fields the flattened
  `llm.*` attributes lose.

## 4. Queued input

- **Need:** a prompt that has been submitted by a peer but not yet started as a trace.
- **Workaround:** `inbox/` files outside the span model.
- **Status:** anticipated.

## 5. Context compaction

- **Need:** mark that earlier history was summarized and where the kept range starts.
- **Workaround:** `CHAIN` span with details in `metadata`.
- **Status:** anticipated.

## 6. Standing prompt changes

- **Need:** record that the system prompt changed, to which version, and why.
- **Workaround:** span with prompt version in `metadata`.
- **Status:** anticipated. Check the `prompt.*` attributes first.
