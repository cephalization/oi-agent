/**
 * The model service: one streaming request in, one raw response out.
 *
 * The service reports the exact request body it sent and returns the exact
 * response body it received, both as JSON text. Those two strings are what
 * the `LLM` span stores and what the fold later replays.
 */
import Anthropic from "@anthropic-ai/sdk"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { type Effort, EFFORTS } from "./config.ts"
import type { Dialect } from "./dialect.ts"
import { anthropicMessages, openaiChat, openaiResponses } from "./dialects/index.ts"
import type { StreamDelta } from "./format.ts"
import type { ToolSpec } from "./tools.ts"
import type { Json } from "./wire.ts"

export interface ModelCall {
  readonly system: string
  readonly tools: ReadonlyArray<ToolSpec>
  /** The conversation, in the model's dialect. */
  readonly messages: ReadonlyArray<Json>
}

export interface ModelHooks {
  /** Called once with the request body, before any output arrives. */
  readonly onRequest: (body: string) => void
  readonly onDelta: (delta: StreamDelta) => void
}

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
}) {}

export class Model extends Context.Service<
  Model,
  {
    /** Run one request. Resolves to the raw response body as JSON text. */
    readonly run: (call: ModelCall, hooks: ModelHooks) => Effect.Effect<string, ModelError>
    /** The wire format this model's requests and responses are in. */
    readonly dialect: Dialect
    /** The configured provider, recorded as `llm.provider`. */
    readonly provider: string
  }
>()("oi-agent/Model") {}

/** A model, ready to provide to a turn. */
export type ModelLayer = Layer.Layer<Model>

export interface ModelSettings {
  readonly model: string
  readonly effort: Effort
  readonly maxTokens: number
  readonly apiKey: string
  readonly baseUrl?: string
}

/** Models whose policy refusals can be retried server-side on another model. */
const SUPPORTS_FALLBACK = /^claude-(?:opus-5|sonnet-5-5|fable-5|mythos-5)/

/** The body of an API error response: `{ error: { message } }`. */
const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)

/** The API's own message, without the status code and raw JSON the SDK puts around it. */
const apiMessage = (error: InstanceType<typeof Anthropic.APIError>): string =>
  Option.match(decodeErrorBody(error.error), {
    onNone: () => error.message,
    onSome: (body) => body.error.message,
  })

const describe = (cause: unknown): ModelError => {
  if (cause instanceof Anthropic.AuthenticationError) {
    return new ModelError({ message: "Anthropic rejected the API key. Run `oi auth login`.", status: 401 })
  }

  if (cause instanceof Anthropic.RateLimitError) {
    return new ModelError({ message: `Rate limited by Anthropic: ${apiMessage(cause)}`, status: 429 })
  }

  if (cause instanceof Anthropic.APIError && Number.isInteger(cause.status)) {
    return new ModelError({ message: apiMessage(cause), status: cause.status })
  }

  return new ModelError({ message: cause instanceof Error ? cause.message : String(cause) })
}

const forward = (event: Anthropic.Beta.BetaRawMessageStreamEvent, hooks: ModelHooks): void => {
  if (event.type !== "content_block_delta") return

  const { delta, index } = event

  if (delta.type === "text_delta") hooks.onDelta({ k: "text", i: index, d: delta.text })

  if (delta.type === "thinking_delta") hooks.onDelta({ k: "thinking", i: index, d: delta.thinking })

  if (delta.type === "input_json_delta") hooks.onDelta({ k: "tool_input", i: index, d: delta.partial_json })
}

/**
 * Hand stored messages back to the SDK.
 *
 * SAFETY: these values are this API's own request and response bodies, stored
 * verbatim in span files and replayed unchanged (which the API requires for
 * thinking blocks). The API is their schema; validating them here would mean
 * maintaining a second copy of the SDK's message types.
 */
const replayable = (messages: ReadonlyArray<Json>): Array<Anthropic.Beta.BetaMessageParam> =>
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  messages as unknown as Array<Anthropic.Beta.BetaMessageParam>

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0]

const clientFor = (settings: ModelSettings): Anthropic =>
  settings.baseUrl === undefined
    ? new Anthropic({ apiKey: settings.apiKey })
    : new Anthropic({ apiKey: settings.apiKey, baseURL: settings.baseUrl })

export const anthropicModel = (settings: ModelSettings): Layer.Layer<Model> => {
  const client = clientFor(settings)

  const paramsFor = (call: ModelCall): StreamParams => {
    const params: StreamParams = {
      model: settings.model,
      max_tokens: settings.maxTokens,
      system: call.system,
      tools: call.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // SAFETY: tool parameters are hand-written JSON Schema objects in tools.ts.
        input_schema: tool.parameters as Anthropic.Beta.BetaTool.InputSchema,
        eager_input_streaming: true,
      })),
      messages: replayable(call.messages),
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: settings.effort },
      cache_control: { type: "ephemeral" },
    }

    // A policy refusal is re-run on a fallback model inside the same request.
    if (SUPPORTS_FALLBACK.test(settings.model)) {
      params.betas = ["server-side-fallback-2026-07-01"]
      params.fallbacks = "default"
    }

    return params
  }

  const run = (call: ModelCall, hooks: ModelHooks): Effect.Effect<string, ModelError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const params = paramsFor(call)

        hooks.onRequest(JSON.stringify(params))

        const stream = client.beta.messages.stream(params, { signal })

        for await (const event of stream) forward(event, hooks)

        return JSON.stringify(await stream.finalMessage())
      },
      catch: describe,
    })

  return Layer.succeed(Model, { run, dialect: anthropicMessages, provider: "anthropic" })
}

/** The request body a real model of this dialect would have sent. */
const scriptedRequest = (call: ModelCall, dialect: Dialect): Json => {
  const tools = call.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))

  if (dialect === openaiChat)
    return {
      model: "scripted",
      messages: [{ role: "system", content: call.system }, ...call.messages],
      tools: tools.map((tool) => ({ type: "function", function: tool })),
    }

  if (dialect === openaiResponses)
    return {
      model: "scripted",
      instructions: call.system,
      input: [...call.messages],
      tools: tools.map((tool) => ({ type: "function", ...tool })),
    }

  return {
    model: "scripted",
    system: call.system,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    messages: [...call.messages],
  }
}

/**
 * A model that answers from a script. Used by tests and by `--model scripted`
 * demos; it exercises the same loop, spans and fold as a real model.
 */
export const scriptedModel = (
  respond: (call: ModelCall, step: number) => Json,
  delayMs: number = 0,
  dialect: Dialect = anthropicMessages,
): Layer.Layer<Model> => {
  let step = 0

  return Layer.succeed(Model, {
    dialect,
    provider: "scripted",
    run: (call, hooks) =>
      Effect.gen(function* () {
        hooks.onRequest(JSON.stringify(scriptedRequest(call, dialect)))

        const response = respond(call, step)

        step += 1

        if (delayMs > 0) yield* Effect.sleep(delayMs)

        return JSON.stringify(response)
      }),
  })
}

/**
 * Ask the API whether a key and model id are usable. Resolves to the model's
 * display name, or fails with a message suitable for showing to the user.
 */
export const checkModel = async (apiKey: string, model: string): Promise<string> => {
  try {
    return (await new Anthropic({ apiKey, maxRetries: 0 }).models.retrieve(model)).display_name
  } catch (error) {
    if (error instanceof Anthropic.NotFoundError)
      throw new Error(`No model named ${model}.`, { cause: error })

    throw new Error(describe(error).message, { cause: error })
  }
}

/** A model the key can use, and the effort levels it accepts. */
export interface ModelOption {
  readonly id: string
  readonly name: string
  /** The configured provider that serves it. */
  readonly provider: string
  /** Supported effort levels, in order. Empty when the model has no effort setting. */
  readonly efforts: ReadonlyArray<Effort>
  /** The most tokens it writes in one reply, when the provider says. */
  readonly maxOutput?: number | undefined
}

const effortsOf = (info: Anthropic.ModelInfo): ReadonlyArray<Effort> => {
  const effort = info.capabilities?.effort

  // Older API responses carry no capabilities; assume the full ladder.
  if (effort === undefined) return EFFORTS

  if (!effort.supported) return []

  return EFFORTS.filter((level) => effort[level]?.supported === true)
}

/**
 * Every model this harness can drive, newest first, with the effort levels
 * each supports. Requests always ask for adaptive thinking, so models without
 * it are left out rather than offered and then rejected by the API.
 */
export const listModels = async (apiKey: string): Promise<Array<ModelOption>> => {
  const options: Array<ModelOption> = []

  try {
    for await (const info of new Anthropic({ apiKey, maxRetries: 0 }).models.list()) {
      if (info.capabilities?.thinking.types.adaptive.supported === false) continue

      options.push({ id: info.id, name: info.display_name, provider: "anthropic", efforts: effortsOf(info) })
    }
  } catch (error) {
    throw new Error(describe(error).message, { cause: error })
  }

  return options
}
