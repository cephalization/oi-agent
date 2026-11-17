/**
 * The on-disk format. This file is the product: everything else in the engine
 * is a reader or writer of these shapes.
 *
 * A span file is the readable JSON shape from the OpenInference `traces.md`
 * spec, with attributes in flattened dotted form so the projection to OTLP is
 * mechanical and lossless.
 */
import { Option, Schema } from "effect"

export const FORMAT_VERSION = "oi-agent/1"

/** What a tool call was observed to do to the workspace: `unknown` when it could not be determined. */
export const Activity = Schema.Literals(["yes", "no", "unknown"])

export const ToolEvidence = Schema.Struct({ writes: Activity, commit: Activity })

export type ToolEvidence = typeof ToolEvidence.Type

// --- spans -----------------------------------------------------------------

export const AttrPrimitive = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])

export type AttrPrimitive = typeof AttrPrimitive.Type

export const AttrValue = Schema.Union([AttrPrimitive, Schema.Array(AttrPrimitive)])

export type AttrValue = typeof AttrValue.Type

export const Attributes = Schema.Record(Schema.String, AttrValue)

export type Attributes = typeof Attributes.Type

export const StatusCode = Schema.Literals(["UNSET", "OK", "ERROR"])

export type StatusCode = typeof StatusCode.Type

export const SpanEvent = Schema.Struct({
  name: Schema.String,
  timestamp: Schema.String,
  attributes: Attributes,
})

export type SpanEvent = typeof SpanEvent.Type

const spanFields = {
  name: Schema.String,
  context: Schema.Struct({ trace_id: Schema.String, span_id: Schema.String }),
  span_kind: Schema.Literal("SPAN_KIND_INTERNAL"),
  parent_id: Schema.NullOr(Schema.String),
  start_time: Schema.String,
  status_code: StatusCode,
  status_message: Schema.String,
  attributes: Attributes,
  events: Schema.Array(SpanEvent),
}

/** A span as written to disk. `end_time` is `null` only while in flight. */
export const SpanFile = Schema.Struct({ ...spanFields, end_time: Schema.NullOr(Schema.String) })

export type SpanFile = typeof SpanFile.Type

/** An immutable, ended span. */
export const EndedSpan = Schema.Struct({ ...spanFields, end_time: Schema.String })

export type EndedSpan = typeof EndedSpan.Type

// --- session ---------------------------------------------------------------

export const Device = Schema.Struct({ id: Schema.String, name: Schema.String })

export type Device = typeof Device.Type

/** A span in a session, named from another session. */
export const SessionSpanRef = Schema.Struct({
  session_id: Schema.String,
  trace_id: Schema.String,
  span_id: Schema.String,
})

export type SessionSpanRef = typeof SessionSpanRef.Type

/** What a session was delegated to do, on the header of a subagent's session. */
export const TaskHeader = Schema.Struct({
  /** Short id the delegating agent and the user call the task by. */
  id: Schema.String,
  title: Schema.String,
  /** `worktree`: its own git worktree and branch. `shared`: the delegating session's directory. */
  isolation: Schema.Literals(["worktree", "shared"]),
  /** `provider/model` it was started on. */
  model: Schema.String,
  worktree: Schema.optionalKey(
    Schema.Struct({
      path: Schema.String,
      branch: Schema.String,
      /** The commit the branch started from. */
      base: Schema.String,
    }),
  ),
})

export type TaskHeader = typeof TaskHeader.Type

export const SessionHeader = Schema.Struct({
  format: Schema.Literal(FORMAT_VERSION),
  id: Schema.String,
  created_at: Schema.String,
  cwd: Schema.String,
  device: Device,
  /** On a subagent's session: the `TOOL` span, in another session, that delegated it. */
  parent: Schema.optionalKey(SessionSpanRef),
  task: Schema.optionalKey(TaskHeader),
})

export type SessionHeader = typeof SessionHeader.Type

// --- annotations -----------------------------------------------------------

export const AnnotatorKind = Schema.Literals(["HUMAN", "LLM", "CODE"])

export type AnnotatorKind = typeof AnnotatorKind.Type

/** The OpenInference annotation fields. */
export const AnnotationBody = Schema.Struct({
  name: Schema.String,
  score: Schema.optionalKey(Schema.Finite),
  label: Schema.optionalKey(Schema.String),
  explanation: Schema.optionalKey(Schema.String),
  annotator_kind: AnnotatorKind,
  identifier: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})

export type AnnotationBody = typeof AnnotationBody.Type

/** An annotation plus the span, trace or session it describes. */
export const AnnotationFile = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["span", "trace", "session"]),
  target: Schema.Struct({
    session_id: Schema.String,
    trace_id: Schema.optionalKey(Schema.String),
    span_id: Schema.optionalKey(Schema.String),
  }),
  created_at: Schema.String,
  annotation: AnnotationBody,
})

export type AnnotationFile = typeof AnnotationFile.Type

// --- inbox -----------------------------------------------------------------

/** Background work whose result is being delivered, and the `TOOL` span that started it. */
export const Delivery = Schema.Struct({
  kind: Schema.Literals(["job", "task"]),
  id: Schema.String,
  trace_id: Schema.String,
  span_id: Schema.String,
  /** For a task: the root span of the subagent's last turn, whose output is the result. */
  result: Schema.optionalKey(SessionSpanRef),
})

export type Delivery = typeof Delivery.Type

/**
 * Input that the host has not started as a trace yet: a prompt submitted by
 * a peer, or the result of background work (`delivers`).
 */
export const InboxFile = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  user_id: Schema.String,
  text: Schema.String,
  /** Trace to continue from; omitted means the session head at pickup time. */
  previous_trace_id: Schema.optionalKey(Schema.String),
  /** Set when this is a result, not a prompt: what finished. */
  delivers: Schema.optionalKey(Delivery),
  /** Set when another session sent this prompt (a brief, a follow-up): the `TOOL` span that sent it. */
  origin: Schema.optionalKey(SessionSpanRef),
  /**
   * Meant for the turn that was running when it was sent, not for a turn of
   * its own. If that turn ends first, it runs as an ordinary prompt.
   */
  steers: Schema.optionalKey(Schema.Boolean),
})

export type InboxFile = typeof InboxFile.Type

// --- streaming deltas ------------------------------------------------------

/** One line of a `.stream.jsonl` file for an in-flight span. */
export const StreamDelta = Schema.Struct({
  /** What is streaming. */
  k: Schema.Literals(["text", "thinking", "tool_input", "stdout"]),
  /** Content block index for model output; 0 otherwise. */
  i: Schema.Int,
  d: Schema.String,
})

export type StreamDelta = typeof StreamDelta.Type

// --- OpenInference attribute names used by the engine ----------------------

export const OI = {
  SPAN_KIND: "openinference.span.kind",
  SESSION_ID: "session.id",
  USER_ID: "user.id",
  METADATA: "metadata",
  AGENT_NAME: "agent.name",
  INPUT_VALUE: "input.value",
  INPUT_MIME: "input.mime_type",
  OUTPUT_VALUE: "output.value",
  OUTPUT_MIME: "output.mime_type",
  LLM_SYSTEM: "llm.system",
  LLM_PROVIDER: "llm.provider",
  LLM_MODEL: "llm.model_name",
  LLM_INVOCATION_PARAMETERS: "llm.invocation_parameters",
  LLM_INPUT_MESSAGES: "llm.input_messages",
  LLM_OUTPUT_MESSAGES: "llm.output_messages",
  LLM_TOOLS: "llm.tools",
  LLM_FINISH_REASON: "llm.finish_reason",
  TOKENS_PROMPT: "llm.token_count.prompt",
  TOKENS_COMPLETION: "llm.token_count.completion",
  TOKENS_TOTAL: "llm.token_count.total",
  TOKENS_CACHE_READ: "llm.token_count.prompt_details.cache_read",
  TOKENS_CACHE_WRITE: "llm.token_count.prompt_details.cache_write",
  TOOL_NAME: "tool.name",
  TOOL_ID: "tool.id",
  TOOL_DESCRIPTION: "tool.description",
  TOOL_PARAMETERS: "tool.parameters",
} as const

export const SpanKind = Schema.Literals([
  "AGENT",
  "LLM",
  "TOOL",
  "CHAIN",
  "EVALUATOR",
  "GUARDRAIL",
  "DECISION",
])

export type SpanKind = typeof SpanKind.Type

const decodeSpanKind = Schema.decodeUnknownOption(SpanKind)

/** The OpenInference span kind; anything unrecognized is a `CHAIN`. */
export const kindOf = (span: SpanFile): SpanKind =>
  Option.getOrElse(decodeSpanKind(span.attributes[OI.SPAN_KIND]), () => "CHAIN" as const)

const decodeString = Schema.decodeUnknownOption(Schema.String)

/** A string attribute, or `undefined` when absent or not a string. */
export const stringAttr = (span: SpanFile, key: string): string | undefined =>
  Option.getOrUndefined(decodeString(span.attributes[key]))

/** A numeric attribute, or 0 when absent or not a number. */
export const numberAttr = (span: SpanFile, key: string): number => {
  const value = Number(span.attributes[key] ?? 0)

  return Number.isFinite(value) ? value : 0
}

// --- metadata: where everything the spec cannot express lives --------------

export const SpanRef = Schema.Struct({ trace_id: Schema.String, span_id: Schema.String })

/** The wire format of a model call's stored request and response bodies (see `dialect.ts`). */
export const Api = Schema.Literals(["anthropic-messages", "openai-chat", "openai-responses"])

export type Api = typeof Api.Type

/** Where a turn ran. The spans hold the conversation, not the files. */
export const Workspace = Schema.Struct({
  cwd: Schema.String,
  git: Schema.optionalKey(
    Schema.Struct({
      /** The `origin` remote, with any credentials removed. */
      remote: Schema.optionalKey(Schema.String),
      commit: Schema.String,
      /** Tracked files had uncommitted changes. */
      dirty: Schema.Boolean,
    }),
  ),
})

export type Workspace = typeof Workspace.Type

/** A message given to a turn that was already running. */
export const Steered = Schema.Struct({
  inbox_id: Schema.String,
  /** The `LLM` span whose reply (and tool results) the message follows. */
  after: Schema.String,
  user_id: Schema.String,
  text: Schema.String,
})

export type Steered = typeof Steered.Type

/** How a model call is paid for: out of a subscription's allowance, or per token. */
export const Billing = Schema.Literals(["plan", "api"])

export type Billing = typeof Billing.Type

/**
 * Engine-specific state rides in the OpenInference `metadata` attribute (a
 * JSON string) under one key, so it never collides with user metadata.
 * See docs/spec-gaps.md for why each field exists.
 */
export const EngineMetadata = Schema.Struct({
  /** The turn this turn continues. `null` for the first turn of a session. */
  previous: Schema.optionalKey(Schema.NullOr(SpanRef)),
  /** A user-requested context transformation, not an ordinary model turn. */
  operation: Schema.optionalKey(Schema.Literals(["compact", "handoff"])),
  /** The ended CHAIN checkpoint: activation for compact, durable intent for handoff. */
  checkpoint: Schema.optionalKey(SpanRef),
  /** Source command's destination, also recorded before creating it for crash recovery. */
  handoff_target: Schema.optionalKey(Schema.String),
  /** On a destination bootstrap CHAIN: provenance only, never a context-following edge. */
  handoff: Schema.optionalKey(Schema.Struct({ source_session_id: Schema.String, checkpoint: SpanRef })),
  /** On the first destination AGENT root: the local bootstrap consumed by this turn. */
  handoff_seed: Schema.optionalKey(SpanRef),
  /** On a context.compact CHAIN: the exact branch head replaced by its output. */
  compaction: Schema.optionalKey(
    Schema.Struct({
      source: SpanRef,
      trigger: Schema.Literal("manual"),
      policy_version: Schema.Literal("1"),
    }),
  ),
  /** Device that wrote the span. */
  device: Schema.optionalKey(Schema.String),
  /** Process that owns an in-flight span, for liveness checks. */
  pid: Schema.optionalKey(Schema.Int),
  /** Inbox entry this turn consumed. */
  inbox_id: Schema.optionalKey(Schema.String),
  /**
   * On a turn root or observing TOOL span: the results of background work it delivers
   * to the model, each with the inbox entry it consumed and the `TOOL` span
   * that started the work.
   */
  delivers: Schema.optionalKey(Schema.Array(Schema.Struct({ ...Delivery.fields, inbox_id: Schema.String }))),
  /** On a turn root: inbox results consumed by ended child TOOL spans, indexed without reading model histories. */
  observed_results: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * On a turn's root span: what its person said while it ran, and where in
   * the turn each message was given to the model: after the tool results of
   * the `LLM` span `after`, or after its reply when that asked for no tools.
   */
  steered: Schema.optionalKey(Schema.Array(Steered)),
  /** On a turn's root span: the `TOOL` span, in another session, that sent this turn's prompt. */
  origin: Schema.optionalKey(SessionSpanRef),
  /** On a `TOOL` span that delegated or steered a task: the task and its session. */
  task: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      session_id: Schema.String,
      started_runner: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** On a `TOOL` span: the job its command became when it outlived the call. */
  job: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      /** The job's full output, outside the session tree. */
      log: Schema.String,
      reason: Schema.Literals(["requested", "timeout"]),
    }),
  ),
  /** Eval feedback injected into this turn's input. */
  injected: Schema.optionalKey(
    Schema.Array(Schema.Struct({ annotation_id: Schema.String, name: Schema.String })),
  ),
  /** Observed workspace effects, independent of shell text or exit status. */
  evidence: Schema.optionalKey(ToolEvidence),
  /** A tool call whose result is an error. */
  is_error: Schema.optionalKey(Schema.Boolean),
  /** TOOL execution boundary, after approval; null means execution has not started. Absent in older spans. */
  execution_started_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** A tool call that is waiting for the host to allow or deny it. */
  awaiting_approval: Schema.optionalKey(Schema.Boolean),
  approval: Schema.optionalKey(
    Schema.Struct({
      decision: Schema.Literals(["allow", "deny"]),
      /** The device whose user decided, or `auto:<model>` when a decision model allowed it. */
      by: Schema.String,
      /** A decision model's answers (probability of yes per question), when one was asked. */
      answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
      /** Why auto mode asked a human instead: a hard rule, the answers, or a failed decision call. */
      asked_because: Schema.optionalKey(Schema.String),
    }),
  ),
  /** On a `DECISION` span: what the decision was for. */
  purpose: Schema.optionalKey(Schema.Literals(["approval", "steering"])),
  /** The trace an `EVALUATOR` span judged. */
  evaluates: Schema.optionalKey(Schema.String),
  /** On an `LLM` span: the wire format of its request and response bodies. Absent means Anthropic Messages. */
  api: Schema.optionalKey(Api),
  /** On an `LLM` span: the configured provider that served it. */
  provider: Schema.optionalKey(Schema.String),
  /** How the call was paid for: `plan` is a subscription's allowance, not billed per token. */
  billing: Schema.optionalKey(Billing),
  /** On a turn's root span: the directory and checkout it ran in. */
  workspace: Schema.optionalKey(Workspace),
  /** Version of the learned-rules prompt section in effect. */
  prompt_version: Schema.optionalKey(Schema.String),
  /**
   * Bytes the whole session occupies on disk. On a turn's root span: measured
   * when the turn starts and again when it ends.
   */
  session_bytes: Schema.optionalKey(Schema.Int),
})

export type EngineMetadata = {
  -readonly [K in keyof typeof EngineMetadata.Type]: (typeof EngineMetadata.Type)[K]
}

export const METADATA_KEY = "oi_agent"

const MetadataEnvelope = Schema.fromJsonString(Schema.Struct({ [METADATA_KEY]: EngineMetadata }))
const decodeEnvelope = Schema.decodeUnknownOption(MetadataEnvelope)

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
const decodeJsonObject = Schema.decodeUnknownOption(JsonObject)
const encodeEngineMetadata = Schema.encodeSync(EngineMetadata)

export const readMetadata = (span: SpanFile): EngineMetadata =>
  Option.match(decodeEnvelope(span.attributes[OI.METADATA]), {
    onNone: () => ({}),
    onSome: (envelope) => envelope[METADATA_KEY],
  })

/** Merge engine metadata into an existing `metadata` attribute value. */
export const writeMetadata = (existing: AttrValue | undefined, patch: EngineMetadata): string => {
  const base = Option.getOrElse(decodeJsonObject(existing), () => ({}))

  const current = Option.match(decodeEnvelope(existing), {
    onNone: () => ({}),
    onSome: (envelope) => envelope[METADATA_KEY],
  })

  return JSON.stringify({ ...base, [METADATA_KEY]: encodeEngineMetadata({ ...current, ...patch }) })
}

// --- file names ------------------------------------------------------------

export const spanFileName = (startNs: bigint, spanId: string): string =>
  `${startNs.toString().padStart(20, "0")}-${spanId}`

// --- codecs ----------------------------------------------------------------

/** Parse a JSON document with a schema; `undefined` when it does not conform. */
export const parser = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))

  return (text: string): S["Type"] | undefined => Option.getOrUndefined(decode(text))
}

/** Serialize a value as the pretty-printed JSON that goes on disk. */
export const printer = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const encode = Schema.encodeSync(schema)

  return (value: S["Type"]): string => JSON.stringify(encode(value), null, 2)
}

export const parseSpan = parser(SpanFile)
export const parseEndedSpan = parser(EndedSpan)
export const printSpan = printer(SpanFile)
export const parseHeader = parser(SessionHeader)
export const printHeader = printer(SessionHeader)
export const parseAnnotation = parser(AnnotationFile)
export const printAnnotation = printer(AnnotationFile)
export const parseInbox = parser(InboxFile)
export const printInbox = printer(InboxFile)
export const parseDelta = parser(StreamDelta)
export const parseDevice = parser(Device)
export const printDevice = printer(Device)
