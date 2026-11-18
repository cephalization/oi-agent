/** The Anthropic Messages dialect: the engine's original, and the default for spans that predate dialects. */
import { Option, Schema } from "effect"
import type { Image } from "../attachments.ts"
import {
  type Dialect,
  effortIn,
  mergeAssistant,
  type ToolCall,
  type ToolResult,
  type Transcript,
  type TranscriptEntry,
  userEntry,
} from "../dialect.ts"
import { requestAttributes, responseAttributes } from "../oi.ts"
import {
  asBlock,
  asMessage,
  asParts,
  isText,
  type Json,
  parseRequest,
  parseResponse,
  textOf,
  toolUses,
} from "../wire.ts"

const reply: Dialect["reply"] = (raw) =>
  Option.match(parseResponse(raw), {
    onNone: () => undefined,
    onSome: (response) => {
      const calls: Array<ToolCall> = toolUses(response.content).map((use) => ({
        id: use.id,
        name: use.name,
        input: use.input,
      }))

      const stopReason = response.stop_reason ?? ""

      return {
        text: textOf(response.content),
        calls,
        wantsTools: stopReason === "tool_use" && calls.length > 0,
        paused: stopReason === "pause_turn",
        stopReason,
      }
    },
  })

const toolResults = (results: ReadonlyArray<ToolResult>): Json => ({
  role: "user",
  content: results.map((result) => ({
    type: "tool_result",
    tool_use_id: result.id,
    content: result.output,
    is_error: result.isError,
  })),
})

const continueWith: Dialect["continueWith"] = (messages, rawResponse, results) => {
  const next = [...messages]

  const content = Option.match(parseResponse(rawResponse), {
    onNone: () => [],
    onSome: (response) => response.content,
  })

  if (content.length > 0) next.push({ role: "assistant", content: [...content] })

  if (results.length > 0) next.push(toolResults(results))

  return next
}

/** Text of a tool result's content: a string, or text blocks. */
const resultText = (content: Json | undefined): string => {
  if (content === undefined || content === null) return ""

  const message = asMessage({ role: "user", content })

  if (message === undefined) return JSON.stringify(content)

  return asParts(message.content)
    .map((part) => {
      const block = asBlock(part)

      return block !== undefined && "text" in block ? block.text : ""
    })
    .join("")
}

/** The most of a fetched page that carries over to another provider. */
const FETCHED_CHARS = 20_000

/** The blocks Anthropic's own web tools leave in a response, as far as another provider can use them. */
const ServerBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("server_tool_use"), name: Schema.String, input: Schema.Json }),
  Schema.Struct({
    type: Schema.Literal("web_search_tool_result"),
    content: Schema.Array(Schema.Struct({ title: Schema.String, url: Schema.String })),
  }),
  Schema.Struct({
    type: Schema.Literal("web_fetch_tool_result"),
    content: Schema.Struct({
      content: Schema.Struct({
        source: Schema.Struct({ type: Schema.Literal("text"), data: Schema.String }),
      }),
    }),
  }),
])

const decodeServerBlock = Schema.decodeUnknownOption(ServerBlock)

/**
 * A web tool's call or result as text. Another provider cannot read these
 * blocks, and without them the conversation would lose what was found.
 */
const serverText = (part: Json): string | undefined =>
  Option.match(decodeServerBlock(part), {
    onNone: () => undefined,
    onSome: (block) => {
      if (block.type === "server_tool_use") return `[${block.name}: ${JSON.stringify(block.input)}]`

      if (block.type === "web_search_tool_result")
        return block.content.map((result) => `${result.title} — ${result.url}`).join("\n")

      return block.content.content.source.data.slice(0, FETCHED_CHARS)
    },
  })

const toTranscript: Dialect["toTranscript"] = (messages) => {
  const entries: Array<TranscriptEntry> = []

  for (const json of messages) {
    const message = asMessage(json)

    if (message === undefined) continue

    if (isText(message.content)) {
      if (message.role === "user") entries.push({ role: "user", text: message.content })
      else mergeAssistant(entries, { role: "assistant", text: message.content, calls: [] })

      continue
    }

    const texts: Array<string> = []
    const calls: Array<ToolCall> = []
    const images: Array<Image> = []

    for (const part of message.content) {
      const block = asBlock(part)
      const server = serverText(part)

      if (server !== undefined) texts.push(server)

      if (block === undefined) continue

      if ("tool_use_id" in block) {
        entries.push({
          role: "tool",
          id: block.tool_use_id,
          output: resultText(block.content),
          isError: block.is_error === true,
        })
      } else if ("input" in block) {
        calls.push({ id: block.id, name: block.name, input: block.input })
      } else if ("text" in block) {
        texts.push(block.text)
      } else if ("source" in block) {
        images.push({ media_type: block.source.media_type, data: block.source.data })
      }
      // Thinking and other provider-specific blocks do not carry over; web tool blocks did, as text, above.
    }

    const text = texts.join("\n")

    if (message.role === "user") {
      if (text !== "" || images.length > 0) entries.push(userEntry(text, images))
    } else if (text !== "" || calls.length > 0) {
      mergeAssistant(entries, { role: "assistant", text, calls })
    }
  }

  return entries
}

/** Anthropic tool ids allow letters, digits, `_` and `-`. */
const toolId = (id: string): string => id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")

const fromTranscript: Dialect["fromTranscript"] = (transcript: Transcript) => {
  const messages: Array<Json> = []
  let pending: Array<Json> = []

  const flushResults = (): void => {
    if (pending.length > 0) messages.push({ role: "user", content: pending })

    pending = []
  }

  for (const entry of transcript) {
    if (entry.role === "tool") {
      pending.push({
        type: "tool_result",
        tool_use_id: toolId(entry.id),
        content: entry.output,
        is_error: entry.isError,
      })
      continue
    }

    flushResults()

    if (entry.role === "user") {
      messages.push(userMessage([entry.text], entry.images))
      continue
    }

    const content: Array<Json> = entry.text === "" ? [] : [{ type: "text", text: entry.text }]

    for (const call of entry.calls)
      content.push({ type: "tool_use", id: toolId(call.id), name: call.name, input: call.input })

    if (content.length > 0) messages.push({ role: "assistant", content })
  }

  flushResults()

  return messages
}

const imageBlock = (image: Image): Json => ({
  type: "image",
  source: { type: "base64", media_type: image.media_type, data: image.data },
})

const userMessage: Dialect["userMessage"] = (parts, images = []) => {
  // One part stays a plain string, as the engine has always sent it; replays then match byte for byte.
  if (images.length === 0)
    return parts.length === 1
      ? { role: "user", content: parts[0] ?? "" }
      : { role: "user", content: parts.map((text) => ({ type: "text", text })) }

  // Images first, as Anthropic recommends; an empty text block is refused, and a prompt can be only images.
  return {
    role: "user",
    content: [
      ...images.map(imageBlock),
      ...parts.flatMap((text) => (text === "" ? [] : [{ type: "text", text }])),
    ],
  }
}

export const anthropicMessages: Dialect = {
  api: "anthropic-messages",
  requestMessages: (raw) =>
    Option.match(parseRequest(raw), { onNone: () => undefined, onSome: (request) => [...request.messages] }),
  reply,
  continueWith,
  userMessage,
  toTranscript,
  fromTranscript,
  requestAttributes: (raw, vendor) =>
    Option.match(parseRequest(raw), {
      onNone: () => new Map(),
      onSome: (request) => requestAttributes(request, raw, vendor),
    }),
  responseAttributes: (raw) =>
    Option.match(parseResponse(raw), {
      onNone: () => new Map(),
      onSome: (response) => responseAttributes(response, raw),
    }),
  effort: (raw) =>
    Option.match(parseRequest(raw), {
      onNone: () => undefined,
      onSome: (request) => effortIn(request.output_config),
    }),
}
