/**
 * Models behind OpenAI's APIs: OpenAI itself, ChatGPT plan usage, and any
 * server that speaks Chat Completions ("OpenAI-compatible").
 *
 * Requests are plain `fetch` calls with a JSON body, so the body stored on
 * the `LLM` span is byte for byte what was sent. Responses stream as
 * server-sent events; the stored response is the final response object
 * (Responses API) or the stream folded into a completion (Chat Completions).
 */
import { Effect, Layer, Option, Schema } from "effect"
import type { Effort } from "./config.ts"
import type { Dialect } from "./dialect.ts"
import { openaiChat, openaiResponses } from "./dialects/index.ts"
import { Model, type ModelCall, ModelError, type ModelHooks, type ModelOption } from "./model.ts"
import type { Json } from "./wire.ts"

export type OpenAIApi = "chat" | "responses"

export interface OpenAISettings {
  /** Provider id, for `llm.provider` and messages. */
  readonly provider: string
  readonly api: OpenAIApi
  /** For example `https://api.openai.com/v1`. */
  readonly baseUrl: string
  readonly model: string
  /** Reasoning effort to request; `undefined` sends none. */
  readonly effort: Effort | undefined
  readonly maxTokens: number
  /** The bearer token for a request; `undefined` sends no authorization (a local server). */
  readonly token: () => Promise<string | undefined>
  /** What to tell the user when the credentials are rejected. */
  readonly onUnauthorized: string
}

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

// --- errors ------------------------------------------------------------------

const ErrorBody = Schema.Union([
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({ detail: Schema.String }),
  Schema.Struct({ message: Schema.String }),
])

const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

const errorText = (body: string): string =>
  Option.match(decodeError(body), {
    onNone: () => body.slice(0, 300),
    onSome: (parsed) => {
      if ("detail" in parsed) return parsed.detail

      if ("message" in parsed) return parsed.message

      return Schema.is(Schema.String)(parsed.error) ? parsed.error : parsed.error.message
    },
  })

const failure = (settings: OpenAISettings, status: number, body: string): ModelError => {
  if (status === 401 || status === 403)
    return new ModelError({
      message: `${settings.provider} rejected the credentials. ${settings.onUnauthorized}`,
      status,
    })

  if (status === 429)
    return new ModelError({ message: `Rate limited by ${settings.provider}: ${errorText(body)}`, status })

  return new ModelError({ message: `${settings.provider}: ${errorText(body)}`, status })
}

const describe = (settings: OpenAISettings, cause: unknown): ModelError => {
  if (cause instanceof ModelError) return cause

  const message = cause instanceof Error ? cause.message : String(cause)

  return new ModelError({
    message: `Could not reach ${settings.provider} at ${settings.baseUrl}: ${message}`,
  })
}

// --- server-sent events ---------------------------------------------------------

/** The `data:` payloads of a server-sent event stream. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })

    let boundary = /\r?\n\r?\n/.exec(buffer)

    while (boundary !== null) {
      const event = buffer.slice(0, boundary.index)

      buffer = buffer.slice(boundary.index + boundary[0].length)

      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")

      if (data !== "" && data !== "[DONE]") yield data

      boundary = /\r?\n\r?\n/.exec(buffer)
    }
  }
}

// --- Chat Completions -------------------------------------------------------------

const ChatChunk = Schema.Struct({
  id: Nullable(Schema.String),
  model: Nullable(Schema.String),
  choices: Nullable(
    Schema.Array(
      Schema.Struct({
        delta: Nullable(
          Schema.Struct({
            content: Nullable(Schema.String),
            reasoning_content: Nullable(Schema.String),
            reasoning: Nullable(Schema.String),
            tool_calls: Nullable(
              Schema.Array(
                Schema.Struct({
                  index: Schema.Finite,
                  id: Nullable(Schema.String),
                  function: Nullable(
                    Schema.Struct({ name: Nullable(Schema.String), arguments: Nullable(Schema.String) }),
                  ),
                }),
              ),
            ),
          }),
        ),
        finish_reason: Nullable(Schema.String),
      }),
    ),
  ),
  usage: Nullable(Schema.Json),
})

const decodeChunk = Schema.decodeUnknownOption(Schema.fromJsonString(ChatChunk))

interface PartialCall {
  id: string
  name: string
  arguments: string
}

/** Fold a Chat Completions stream into the completion a non-streaming call would have returned. */
class ChatAccumulator {
  private id = ""
  private model = ""
  private content = ""
  private reasoning = ""
  private finish: string | null = null
  private usage: Json = null
  private readonly calls = new Map<number, PartialCall>()

  add(data: string, hooks: ModelHooks): void {
    const chunk = Option.getOrUndefined(decodeChunk(data))

    if (chunk === undefined) return

    this.id = chunk.id ?? this.id
    this.model = chunk.model ?? this.model
    this.usage = chunk.usage ?? this.usage

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      this.finish = choice.finish_reason ?? this.finish

      if (delta?.content !== undefined && delta.content !== null && delta.content !== "") {
        this.content += delta.content
        hooks.onDelta({ k: "text", i: 0, d: delta.content })
      }

      const thought = delta?.reasoning_content ?? delta?.reasoning

      if (thought !== undefined && thought !== null && thought !== "") {
        this.reasoning += thought
        hooks.onDelta({ k: "thinking", i: 0, d: thought })
      }

      for (const call of delta?.tool_calls ?? []) {
        const partial = this.calls.get(call.index) ?? { id: "", name: "", arguments: "" }

        partial.id = call.id ?? partial.id
        partial.name += call.function?.name ?? ""
        partial.arguments += call.function?.arguments ?? ""
        this.calls.set(call.index, partial)

        if (call.function?.arguments !== undefined && call.function.arguments !== null)
          hooks.onDelta({ k: "tool_input", i: call.index + 1, d: call.function.arguments })
      }
    }
  }

  completion(): Json {
    const calls = [...this.calls.entries()]
      .toSorted(([a], [b]) => a - b)
      .map(([index, call]) => ({
        // A few servers omit ids; the fold needs one to pair the call with its result.
        id: call.id === "" ? `call_${index}` : call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }))

    const message: Array<[string, Json]> = [
      ["role", "assistant"],
      ["content", this.content === "" && calls.length > 0 ? null : this.content],
    ]

    if (calls.length > 0) message.push(["tool_calls", calls])

    if (this.reasoning !== "") message.push(["reasoning_content", this.reasoning])

    return {
      id: this.id,
      object: "chat.completion",
      model: this.model,
      choices: [{ index: 0, message: Object.fromEntries(message), finish_reason: this.finish }],
      usage: this.usage,
    }
  }
}

// --- Responses ----------------------------------------------------------------------

const ResponsesEvent = Schema.Struct({
  type: Schema.String,
  delta: Nullable(Schema.String),
  output_index: Nullable(Schema.Finite),
  response: Nullable(Schema.Json),
  message: Nullable(Schema.String),
})

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ResponsesEvent))

const FailedResponse = Schema.Struct({ error: Nullable(Schema.Struct({ message: Schema.String })) })
const decodeFailed = Schema.decodeUnknownOption(FailedResponse)

/** OpenAI's effort names stop at `xhigh`. */
const openaiEffort = (effort: Effort): string => (effort === "max" ? "xhigh" : effort)

// --- requests -----------------------------------------------------------------------

const chatBody = (settings: OpenAISettings, call: ModelCall): Json => {
  const body: Array<[string, Json]> = [
    ["model", settings.model],
    ["messages", [{ role: "system", content: call.system }, ...call.messages]],
    ["stream", true],
    ["stream_options", { include_usage: true }],
    ["max_tokens", settings.maxTokens],
  ]

  if (call.tools.length > 0)
    body.push([
      "tools",
      call.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    ])

  if (settings.effort !== undefined) body.push(["reasoning_effort", openaiEffort(settings.effort)])

  return Object.fromEntries(body)
}

const responsesBody = (settings: OpenAISettings, call: ModelCall): Json => {
  const body: Array<[string, Json]> = [
    ["model", settings.model],
    ["instructions", call.system],
    ["input", [...call.messages]],
    ["stream", true],
    // Nothing is kept server-side: the span files are the conversation.
    ["store", false],
  ]

  if (call.tools.length > 0)
    body.push([
      "tools",
      call.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      })),
    ])

  if (settings.effort !== undefined) {
    body.push(["reasoning", { effort: openaiEffort(settings.effort), summary: "auto" }])
    // Reasoning carries over between calls only as encrypted content.
    body.push(["include", ["reasoning.encrypted_content"]])
  }

  return Object.fromEntries(body)
}

const post = async (
  settings: OpenAISettings,
  route: string,
  body: string,
  signal: AbortSignal,
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json", accept: "text/event-stream" })
  const token = await settings.token()

  if (token !== undefined) headers.set("authorization", `Bearer ${token}`)

  const response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/${route}`, {
    method: "POST",
    headers,
    body,
    signal,
    redirect: "error",
  })

  if (!response.ok) throw failure(settings, response.status, await response.text())

  if (response.body === null)
    throw new ModelError({ message: `${settings.provider} returned no response body.` })

  return response
}

const runChat = async (settings: OpenAISettings, call: ModelCall, hooks: ModelHooks, signal: AbortSignal) => {
  const body = JSON.stringify(chatBody(settings, call))

  hooks.onRequest(body)

  const response = await post(settings, "chat/completions", body, signal)
  const accumulator = new ChatAccumulator()

  for await (const data of events(response.body ?? new ReadableStream())) accumulator.add(data, hooks)

  return JSON.stringify(accumulator.completion())
}

const runResponses = async (
  settings: OpenAISettings,
  call: ModelCall,
  hooks: ModelHooks,
  signal: AbortSignal,
) => {
  const body = JSON.stringify(responsesBody(settings, call))

  hooks.onRequest(body)

  const response = await post(settings, "responses", body, signal)

  for await (const data of events(response.body ?? new ReadableStream())) {
    const event = Option.getOrUndefined(decodeEvent(data))

    if (event === undefined) continue

    const delta = event.delta ?? ""
    const index = event.output_index ?? 0

    if (event.type === "response.output_text.delta") hooks.onDelta({ k: "text", i: index, d: delta })

    if (event.type === "response.reasoning_summary_text.delta")
      hooks.onDelta({ k: "thinking", i: index, d: delta })

    if (event.type === "response.function_call_arguments.delta")
      hooks.onDelta({ k: "tool_input", i: index, d: delta })

    if (
      (event.type === "response.completed" || event.type === "response.incomplete") &&
      event.response !== undefined
    )
      return JSON.stringify(event.response)

    if (event.type === "response.failed") {
      const reason = Option.getOrUndefined(decodeFailed(event.response))?.error?.message

      throw new ModelError({ message: `${settings.provider}: ${reason ?? "the response failed"}` })
    }

    if (event.type === "error")
      throw new ModelError({ message: `${settings.provider}: ${event.message ?? data}` })
  }

  throw new ModelError({ message: `${settings.provider} ended the response stream before it completed.` })
}

const DIALECTS = new Map<OpenAIApi, Dialect>([
  ["chat", openaiChat],
  ["responses", openaiResponses],
])

export const openaiModel = (settings: OpenAISettings): Layer.Layer<Model> =>
  Layer.succeed(Model, {
    dialect: DIALECTS.get(settings.api) ?? openaiChat,
    provider: settings.provider,
    run: (call, hooks) =>
      Effect.tryPromise({
        try: (signal) =>
          settings.api === "responses"
            ? runResponses(settings, call, hooks, signal)
            : runChat(settings, call, hooks, signal),
        catch: (cause) => describe(settings, cause),
      }),
  })

// --- model lists ------------------------------------------------------------------------

const ModelList = Schema.Union([
  /** OpenAI and most compatible servers. */
  Schema.Struct({
    data: Schema.Array(Schema.Struct({ id: Schema.String, display_name: Nullable(Schema.String) })),
  }),
  /** ChatGPT plan usage. */
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        display_name: Nullable(Schema.String),
        visibility: Nullable(Schema.String),
      }),
    ),
  }),
])

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(ModelList))

/** OpenAI ids of models that do something other than chat. */
const NOT_CHAT =
  /audio|realtime|transcribe|tts|image|embedding|moderation|dall-e|whisper|search|instruct|davinci|babbage/

/** OpenAI reasoning models take an effort; the API does not list which levels, so offer the common three. */
const REASONING = /^(?:o\d|gpt-5|codex)/

/** The effort levels to offer for an OpenAI model id. */
export const openaiEfforts = (model: string): ReadonlyArray<Effort> =>
  REASONING.test(model) ? ["low", "medium", "high"] : []

export interface ListOptions {
  readonly provider: string
  readonly baseUrl: string
  readonly token: string | undefined
  /** Keep only OpenAI's chat models (for OpenAI and ChatGPT), and offer effort for its reasoning models. */
  readonly openaiCatalog: boolean
}

/** The models a provider offers, as `/model` lists them. */
export const listOpenAIModels = async (options: ListOptions): Promise<Array<ModelOption>> => {
  const headers = new Headers({ accept: "application/json" })

  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`)

  const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/models`, {
    headers,
    redirect: "error",
  })

  const body = await response.text()

  if (!response.ok) throw new Error(`${options.provider}: ${errorText(body)}`)

  const list = Option.getOrUndefined(decodeList(body))

  if (list === undefined) throw new Error(`${options.provider} returned a model list in an unexpected shape.`)

  const entries =
    "data" in list
      ? list.data.map((model) => ({ id: model.id, name: model.display_name ?? model.id }))
      : list.models
          .filter(
            (model) =>
              model.visibility === undefined || model.visibility === null || model.visibility === "list",
          )
          .map((model) => ({ id: model.slug, name: model.display_name ?? model.slug }))

  return entries
    .filter((entry) => !options.openaiCatalog || !NOT_CHAT.test(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      provider: options.provider,
      efforts: options.openaiCatalog ? openaiEfforts(entry.id) : [],
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id))
}
