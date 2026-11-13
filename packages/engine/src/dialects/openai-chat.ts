/**
 * The OpenAI Chat Completions dialect: what "OpenAI-compatible" servers
 * (Ollama, vLLM, LM Studio, OpenRouter, Groq, Anthropic's compatibility
 * endpoint, ...) all speak.
 *
 * The system prompt is a message here, so the stored request's system
 * messages are left out of the conversation and sent fresh each call.
 */
import { Option, Schema } from "effect"
import {
  type Attrs,
  type Dialect,
  flattenTranscript,
  mergeAssistant,
  parseArguments,
  type ToolCall,
  type TranscriptEntry,
} from "../dialect.ts"
import { OI } from "../format.ts"
import type { Json } from "../wire.ts"

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

const ChatToolCall = Schema.Struct({
  id: Schema.String,
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
})

const TextPart = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })

const Content = Schema.Union([Schema.String, Schema.Array(TextPart)])

const ChatMessage = Schema.Struct({
  role: Schema.String,
  content: Nullable(Content),
  tool_calls: Nullable(Schema.Array(ChatToolCall)),
  tool_call_id: Nullable(Schema.String),
})

type ChatMessage = typeof ChatMessage.Type

const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Json),
  tools: Schema.optionalKey(Schema.Array(Schema.Json)),
  max_tokens: Schema.optionalKey(Schema.Json),
  max_completion_tokens: Schema.optionalKey(Schema.Json),
  reasoning_effort: Schema.optionalKey(Schema.Json),
})

const ChatResponse = Schema.Struct({
  model: Nullable(Schema.String),
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Nullable(Schema.String),
        tool_calls: Nullable(Schema.Array(ChatToolCall)),
      }),
      finish_reason: Nullable(Schema.String),
    }),
  ),
  usage: Nullable(
    Schema.Struct({
      prompt_tokens: Nullable(Schema.Finite),
      completion_tokens: Nullable(Schema.Finite),
      prompt_tokens_details: Nullable(Schema.Struct({ cached_tokens: Nullable(Schema.Finite) })),
    }),
  ),
})

const parseRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ChatRequest))
const parseResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ChatResponse))
const decodeMessage = Schema.decodeUnknownOption(ChatMessage)

const asMessage = (json: Json): ChatMessage | undefined => Option.getOrUndefined(decodeMessage(json))

const textOf = (content: ChatMessage["content"]): string => {
  if (content === undefined || content === null) return ""

  if (Schema.is(Schema.String)(content)) return content

  return content.map((part) => part.text ?? "").join("")
}

const isSystem = (role: string): boolean => role === "system" || role === "developer"

const callsOf = (calls: ReadonlyArray<typeof ChatToolCall.Type> | null | undefined): Array<ToolCall> =>
  (calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: parseArguments(call.function.arguments),
  }))

const reply: Dialect["reply"] = (raw) =>
  Option.match(parseResponse(raw), {
    onNone: () => undefined,
    onSome: (response) => {
      const choice = response.choices[0]
      const calls = callsOf(choice?.message.tool_calls)

      return {
        text: choice?.message.content ?? "",
        calls,
        // Some servers say "stop" even when they called tools; the calls decide.
        wantsTools: calls.length > 0,
        paused: false,
        stopReason: choice?.finish_reason ?? "",
      }
    },
  })

/** The assistant message to send back: the response's content and tool calls, as returned. */
const assistantMessage = (raw: string): Json | undefined =>
  Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(raw), {
    onNone: () => undefined,
    onSome: (json): Json | undefined => {
      const response = Option.getOrUndefined(parseResponse(raw))
      const choice = response?.choices[0]

      if (choice === undefined) return undefined

      const calls = rawToolCalls(json)

      return calls === undefined
        ? { role: "assistant", content: choice.message.content ?? "" }
        : { role: "assistant", content: choice.message.content ?? null, tool_calls: calls }
    },
  })

const RawChoices = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({ message: Schema.Struct({ tool_calls: Nullable(Schema.Array(Schema.Json)) }) }),
  ),
})

/** The response's tool calls exactly as the server wrote them. */
const rawToolCalls = (json: Json): Array<Json> | undefined => {
  const calls = Option.getOrUndefined(Schema.decodeUnknownOption(RawChoices)(json))?.choices[0]?.message
    .tool_calls

  return calls === undefined || calls === null || calls.length === 0 ? undefined : [...calls]
}

const toolMessage = (id: string, output: string, isError: boolean): Json => ({
  role: "tool",
  tool_call_id: id,
  // Chat Completions has no error flag on a tool result, so say it in the text.
  content: isError ? `Error: ${output}` : output,
})

const continueWith: Dialect["continueWith"] = (messages, rawResponse, results) => {
  const next = [...messages]
  const assistant = assistantMessage(rawResponse)

  if (assistant !== undefined) next.push(assistant)

  for (const result of results) next.push(toolMessage(result.id, result.output, result.isError))

  return next
}

const toTranscript: Dialect["toTranscript"] = (messages) => {
  const entries: Array<TranscriptEntry> = []

  for (const json of messages) {
    const message = asMessage(json)

    if (message === undefined || isSystem(message.role)) continue

    if (message.role === "tool") {
      entries.push({
        role: "tool",
        id: message.tool_call_id ?? "",
        output: textOf(message.content),
        isError: false,
      })
    } else if (message.role === "assistant") {
      mergeAssistant(entries, {
        role: "assistant",
        text: textOf(message.content),
        calls: callsOf(message.tool_calls),
      })
    } else {
      entries.push({ role: "user", text: textOf(message.content) })
    }
  }

  return entries
}

const fromTranscript: Dialect["fromTranscript"] = (transcript) =>
  transcript.map((entry): Json => {
    if (entry.role === "user") return { role: "user", content: entry.text }

    if (entry.role === "tool") return toolMessage(entry.id, entry.output, entry.isError)

    if (entry.calls.length === 0) return { role: "assistant", content: entry.text }

    return {
      role: "assistant",
      content: entry.text === "" ? null : entry.text,
      tool_calls: entry.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    }
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
    JSON.stringify({
      max_tokens: request.max_tokens ?? request.max_completion_tokens,
      reasoning_effort: request.reasoning_effort,
    }),
  )

  let index = 0

  for (const json of request.messages) {
    const message = asMessage(json)

    if (message === undefined || !isSystem(message.role)) continue

    out.set(`${OI.LLM_INPUT_MESSAGES}.${index}.message.role`, "system")
    out.set(`${OI.LLM_INPUT_MESSAGES}.${index}.message.content`, textOf(message.content))
    index += 1
  }

  flattenTranscript(OI.LLM_INPUT_MESSAGES, index, toTranscript(request.messages), out)

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
  // OpenAI counts cached tokens inside the prompt total, as OpenInference does.
  const prompt = usage?.prompt_tokens ?? 0
  const completion = usage?.completion_tokens ?? 0

  flattenTranscript(
    OI.LLM_OUTPUT_MESSAGES,
    0,
    [{ role: "assistant", text: parsed.text, calls: parsed.calls }],
    out,
  )
  out.set(OI.TOKENS_PROMPT, prompt)
  out.set(OI.TOKENS_COMPLETION, completion)
  out.set(OI.TOKENS_TOTAL, prompt + completion)
  out.set(OI.TOKENS_CACHE_READ, usage?.prompt_tokens_details?.cached_tokens ?? 0)

  if (response.model !== undefined && response.model !== null) out.set(OI.LLM_MODEL, response.model)

  if (parsed.stopReason !== "") out.set(OI.LLM_FINISH_REASON, parsed.stopReason)

  return out
}

export const openaiChat: Dialect = {
  api: "openai-chat",
  requestMessages: (raw) =>
    Option.match(parseRequest(raw), {
      onNone: () => undefined,
      onSome: (request) => request.messages.filter((json) => !isSystem(asMessage(json)?.role ?? "")),
    }),
  reply,
  continueWith,
  userMessage: (parts) => ({ role: "user", content: parts.join("\n\n") }),
  toTranscript,
  fromTranscript,
  requestAttributes,
  responseAttributes,
}
