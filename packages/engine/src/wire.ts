/**
 * The parts of the Anthropic Messages wire format the engine inspects.
 *
 * Request and response bodies are stored verbatim in span files and replayed
 * verbatim, so everything here is deliberately partial: a block the engine
 * does not recognize is carried through untouched as JSON.
 */
import { Option, Schema } from "effect"

export type Json = typeof Schema.Json.Type

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const ThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.optionalKey(Schema.String),
})

const RedactedThinkingBlock = Schema.Struct({
  type: Schema.Literal("redacted_thinking"),
  data: Schema.String,
})

export const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Json,
})

export type ToolUseBlock = typeof ToolUseBlock.Type

const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optionalKey(Schema.Json),
  is_error: Schema.optionalKey(Schema.Boolean),
})

const OtherBlock = Schema.Struct({ type: Schema.String })

/** A content block, narrowed where the engine cares and opaque otherwise. */
export const ContentBlock = Schema.Union([
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  OtherBlock,
])

export type ContentBlock = typeof ContentBlock.Type

export const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
})

export type Message = typeof Message.Type

export const Usage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  output_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
})

export type Usage = typeof Usage.Type

/** A model response as stored in an `LLM` span's `output.value`. */
export const ResponseBody = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  content: Schema.Array(Schema.Json),
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Usage),
})

export type ResponseBody = typeof ResponseBody.Type

const ToolDefinition = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  input_schema: Schema.optionalKey(Schema.Json),
})

/** A model request as stored in an `LLM` span's `input.value`. */
export const RequestBody = Schema.Struct({
  model: Schema.String,
  system: Schema.optionalKey(Schema.Json),
  messages: Schema.Array(Schema.Json),
  tools: Schema.optionalKey(Schema.Array(ToolDefinition)),
})

export type RequestBody = typeof RequestBody.Type

const decodeBlock = Schema.decodeUnknownOption(ContentBlock)
const decodeMessage = Schema.decodeUnknownOption(Message)
const decodeToolUse = Schema.decodeUnknownOption(ToolUseBlock)

export const parseRequest = Schema.decodeUnknownOption(Schema.fromJsonString(RequestBody))
export const parseResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ResponseBody))

export const asBlock = (json: Json): ContentBlock | undefined => Option.getOrUndefined(decodeBlock(json))
export const asMessage = (json: Json): Message | undefined => Option.getOrUndefined(decodeMessage(json))

export const isText = Schema.is(Schema.String)

/** Message content as a list of parts; a bare string is one text part. */
export const asParts = (content: Message["content"]): ReadonlyArray<Json> =>
  isText(content) ? [{ type: "text", text: content }] : content

/** The `tool_use` blocks of a response, in order. */
export const toolUses = (content: ReadonlyArray<Json>): Array<ToolUseBlock> => {
  const uses: Array<ToolUseBlock> = []

  for (const block of content) {
    const use = Option.getOrUndefined(decodeToolUse(block))

    if (use !== undefined) uses.push(use)
  }

  return uses
}

/** The visible text of a response: its text blocks joined. */
export const textOf = (content: ReadonlyArray<Json>): string => {
  const parts: Array<string> = []

  for (const json of content) {
    const block = asBlock(json)

    if (block !== undefined && "text" in block) parts.push(block.text)
  }

  return parts.join("")
}
