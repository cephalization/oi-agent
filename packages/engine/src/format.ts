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

export const SessionHeader = Schema.Struct({
  format: Schema.Literal(FORMAT_VERSION),
  id: Schema.String,
  created_at: Schema.String,
  cwd: Schema.String,
  device: Device,
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

/** A prompt submitted by a peer that the host has not started as a trace yet. */
export const InboxFile = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  user_id: Schema.String,
  text: Schema.String,
  /** Trace to continue from; omitted means the session head at pickup time. */
  previous_trace_id: Schema.optionalKey(Schema.String),
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

export const SpanKind = Schema.Literals(["AGENT", "LLM", "TOOL", "CHAIN", "EVALUATOR", "GUARDRAIL"])

export type SpanKind = typeof SpanKind.Type

const decodeSpanKind = Schema.decodeUnknownOption(SpanKind)

/** The OpenInference span kind; anything unrecognized is a `CHAIN`. */
export const kindOf = (span: SpanFile): SpanKind =>
  Option.getOrElse(decodeSpanKind(span.attributes[OI.SPAN_KIND]), () => "CHAIN" as const)

const decodeString = Schema.decodeUnknownOption(Schema.String)

/** A string attribute, or `undefined` when absent or not a string. */
export const stringAttr = (span: SpanFile, key: string): string | undefined =>
  Option.getOrUndefined(decodeString(span.attributes[key]))

// --- metadata: where everything the spec cannot express lives --------------

const SpanRef = Schema.Struct({ trace_id: Schema.String, span_id: Schema.String })

/**
 * Engine-specific state rides in the OpenInference `metadata` attribute (a
 * JSON string) under one key, so it never collides with user metadata.
 * See docs/spec-gaps.md for why each field exists.
 */
export const EngineMetadata = Schema.Struct({
  /** The turn this turn continues. `null` for the first turn of a session. */
  previous: Schema.optionalKey(Schema.NullOr(SpanRef)),
  /** Device that wrote the span. */
  device: Schema.optionalKey(Schema.String),
  /** Process that owns an in-flight span, for liveness checks. */
  pid: Schema.optionalKey(Schema.Int),
  /** Inbox entry this turn consumed. */
  inbox_id: Schema.optionalKey(Schema.String),
  /** Eval feedback injected into this turn's input. */
  injected: Schema.optionalKey(
    Schema.Array(Schema.Struct({ annotation_id: Schema.String, name: Schema.String })),
  ),
  /** A tool call whose result is an error. */
  is_error: Schema.optionalKey(Schema.Boolean),
  /** A tool call that is waiting for the host to allow or deny it. */
  awaiting_approval: Schema.optionalKey(Schema.Boolean),
  approval: Schema.optionalKey(
    Schema.Struct({ decision: Schema.Literals(["allow", "deny"]), by: Schema.String }),
  ),
  /** Version of the learned-rules prompt section in effect. */
  prompt_version: Schema.optionalKey(Schema.String),
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
