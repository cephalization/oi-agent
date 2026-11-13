/**
 * The OpenAI Responses dialect, used for OpenAI's own API and for ChatGPT
 * plan usage.
 *
 * Requests are sent with `store: false`, so OpenAI keeps nothing and the
 * span files remain the only state. Reasoning carries over between calls as
 * `reasoning` items with `encrypted_content`, which the response includes
 * because the request asks for it. Output items are sent back without their
 * `id`: with nothing stored server-side, an id would refer to an item OpenAI
 * cannot find.
 */
import { Option, Schema } from "effect"
import {
  type Attrs,
  type Dialect,
  effortIn,
  flattenTranscript,
  mergeAssistant,
  parseArguments,
  type ToolCall,
  type TranscriptEntry,
} from "../dialect.ts"
import { OI } from "../format.ts"
import type { Json } from "../wire.ts"

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

const Part = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })

/** Any input or output item, narrowed only where the engine looks. */
const Item = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Part)])),
  call_id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Part)])),
})

type Item = typeof Item.Type

const ResponsesRequest = Schema.Struct({
  model: Schema.String,
  instructions: Schema.optionalKey(Schema.String),
  input: Schema.Array(Schema.Json),
  tools: Schema.optionalKey(Schema.Array(Schema.Json)),
  reasoning: Schema.optionalKey(Schema.Json),
  max_output_tokens: Schema.optionalKey(Schema.Json),
})

const ResponsesResponse = Schema.Struct({
  model: Nullable(Schema.String),
  status: Nullable(Schema.String),
  output: Schema.Array(Schema.Json),
  incomplete_details: Nullable(Schema.Struct({ reason: Nullable(Schema.String) })),
  usage: Nullable(
    Schema.Struct({
      input_tokens: Nullable(Schema.Finite),
      output_tokens: Nullable(Schema.Finite),
      input_tokens_details: Nullable(Schema.Struct({ cached_tokens: Nullable(Schema.Finite) })),
    }),
  ),
})

const JsonObject = Schema.Record(Schema.String, Schema.Json)

const parseRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ResponsesRequest))
const parseResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ResponsesResponse))
const decodeItem = Schema.decodeUnknownOption(Item)
const decodeObject = Schema.decodeUnknownOption(JsonObject)

const asItem = (json: Json): Item | undefined => Option.getOrUndefined(decodeItem(json))

const textOf = (content: Item["content"]): string => {
  if (content === undefined) return ""

  if (Schema.is(Schema.String)(content)) return content

  return content.map((part) => part.text ?? "").join("")
}

/** A message item; an easy input message (`{ role, content }`) has no `type`. */
const isMessage = (item: Item): boolean =>
  item.type === "message" || (item.type === undefined && item.role !== undefined)

const callOf = (item: Item): ToolCall | undefined =>
  item.type === "function_call" && item.call_id !== undefined
    ? { id: item.call_id, name: item.name ?? "", input: parseArguments(item.arguments ?? "") }
    : undefined

const reply: Dialect["reply"] = (raw) =>
  Option.match(parseResponse(raw), {
    onNone: () => undefined,
    onSome: (response) => {
      const items = response.output.flatMap((json) => asItem(json) ?? [])
      const calls = items.flatMap((item) => callOf(item) ?? [])

      const text = items
        .filter((item) => isMessage(item) && item.role === "assistant")
        .map((item) => textOf(item.content))
        .join("")

      const incomplete = response.incomplete_details?.reason

      return {
        text,
        calls,
        wantsTools: calls.length > 0,
        paused: false,
        stopReason: calls.length > 0 ? "tool_calls" : (incomplete ?? response.status ?? ""),
      }
    },
  })

/** An output item as it goes back in: everything but its server-side id. */
const withoutId = (json: Json): Json =>
  Option.match(decodeObject(json), {
    onNone: () => json,
    onSome: (object) => Object.fromEntries(Object.entries(object).filter(([key]) => key !== "id")),
  })

const resultItem = (id: string, output: string, isError: boolean): Json => ({
  type: "function_call_output",
  call_id: id,
  // The Responses API has no error flag on a function result, so say it in the text.
  output: isError ? `Error: ${output}` : output,
})

const continueWith: Dialect["continueWith"] = (messages, rawResponse, results) => {
  const output = Option.match(parseResponse(rawResponse), {
    onNone: () => [],
    onSome: (response) => response.output.map(withoutId),
  })

  return [
    ...messages,
    ...output,
    ...results.map((result) => resultItem(result.id, result.output, result.isError)),
  ]
}

const toTranscript: Dialect["toTranscript"] = (messages) => {
  const entries: Array<TranscriptEntry> = []

  for (const json of messages) {
    const item = asItem(json)

    if (item === undefined) continue

    const call = callOf(item)

    if (call !== undefined) {
      mergeAssistant(entries, { role: "assistant", text: "", calls: [call] })
    } else if (item.type === "function_call_output") {
      entries.push({ role: "tool", id: item.call_id ?? "", output: textOf(item.output), isError: false })
    } else if (isMessage(item) && item.role === "assistant") {
      mergeAssistant(entries, { role: "assistant", text: textOf(item.content), calls: [] })
    } else if (isMessage(item) && item.role === "user") {
      entries.push({ role: "user", text: textOf(item.content) })
    }
    // Reasoning items and system or developer messages do not carry over.
  }

  return entries
}

const userMessage: Dialect["userMessage"] = (parts) => ({
  type: "message",
  role: "user",
  content: parts.map((text) => ({ type: "input_text", text })),
})

const fromTranscript: Dialect["fromTranscript"] = (transcript) =>
  transcript.flatMap((entry): Array<Json> => {
    if (entry.role === "user") return [userMessage([entry.text])]

    if (entry.role === "tool") return [resultItem(entry.id, entry.output, entry.isError)]

    const text: Array<Json> =
      entry.text === ""
        ? []
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: entry.text }] }]

    return [
      ...text,
      ...entry.calls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input),
      })),
    ]
  })

const requestAttributes: Dialect["requestAttributes"] = (raw, provider) => {
  const out: Attrs = new Map([
    [OI.SPAN_KIND, "LLM"],
    [OI.LLM_SYSTEM, "openai"],
    [OI.LLM_PROVIDER, provider],
    [OI.INPUT_VALUE, raw],
    [OI.INPUT_MIME, "application/json"],
  ])

  const request = Option.getOrUndefined(parseRequest(raw))

  if (request === undefined) return out

  out.set(OI.LLM_MODEL, request.model)
  out.set(
    OI.LLM_INVOCATION_PARAMETERS,
    JSON.stringify({ max_output_tokens: request.max_output_tokens, reasoning: request.reasoning }),
  )

  let index = 0

  if (request.instructions !== undefined) {
    out.set(`${OI.LLM_INPUT_MESSAGES}.0.message.role`, "system")
    out.set(`${OI.LLM_INPUT_MESSAGES}.0.message.content`, request.instructions)
    index = 1
  }

  flattenTranscript(OI.LLM_INPUT_MESSAGES, index, toTranscript(request.input), out)

  for (const [position, tool] of (request.tools ?? []).entries())
    out.set(`${OI.LLM_TOOLS}.${position}.tool.json_schema`, JSON.stringify(tool))

  return out
}

const responseAttributes: Dialect["responseAttributes"] = (raw) => {
  const out: Attrs = new Map([
    [OI.OUTPUT_VALUE, raw],
    [OI.OUTPUT_MIME, "application/json"],
  ])

  const response = Option.getOrUndefined(parseResponse(raw))
  const parsed = reply(raw)

  if (response === undefined || parsed === undefined) return out

  const usage = response.usage
  // Responses counts cached tokens inside `input_tokens`, as OpenInference does.
  const prompt = usage?.input_tokens ?? 0
  const completion = usage?.output_tokens ?? 0

  flattenTranscript(
    OI.LLM_OUTPUT_MESSAGES,
    0,
    [{ role: "assistant", text: parsed.text, calls: parsed.calls }],
    out,
  )
  out.set(OI.TOKENS_PROMPT, prompt)
  out.set(OI.TOKENS_COMPLETION, completion)
  out.set(OI.TOKENS_TOTAL, prompt + completion)
  out.set(OI.TOKENS_CACHE_READ, usage?.input_tokens_details?.cached_tokens ?? 0)

  if (response.model !== undefined && response.model !== null) out.set(OI.LLM_MODEL, response.model)

  if (parsed.stopReason !== "") out.set(OI.LLM_FINISH_REASON, parsed.stopReason)

  return out
}

export const openaiResponses: Dialect = {
  api: "openai-responses",
  requestMessages: (raw) =>
    Option.match(parseRequest(raw), { onNone: () => undefined, onSome: (request) => [...request.input] }),
  reply,
  continueWith,
  userMessage,
  toTranscript,
  fromTranscript,
  requestAttributes,
  responseAttributes,
  effort: (raw) =>
    Option.match(parseRequest(raw), {
      onNone: () => undefined,
      onSome: (request) => effortIn(request.reasoning),
    }),
}
