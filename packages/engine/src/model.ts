/**
 * The model service: one streaming request in, one raw response out.
 *
 * The service reports the exact request body it sent and returns the exact
 * response body it received, both as JSON text. Those two strings are what
 * the `LLM` span stores and what the fold later replays.
 */
import Anthropic from "@anthropic-ai/sdk"
import { Context, Effect, Layer, Schema } from "effect"
import type { Effort } from "./config.ts"
import type { StreamDelta } from "./format.ts"
import type { ToolSpec } from "./tools.ts"
import type { Json } from "./wire.ts"

export interface ModelCall {
  readonly system: string
  readonly tools: ReadonlyArray<ToolSpec>
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
  }
>()("oi-agent/Model") {}

export interface ModelSettings {
  readonly model: string
  readonly effort: Effort
  readonly maxTokens: number
  readonly apiKey: string
  readonly baseUrl?: string
}

/** Models whose policy refusals can be retried server-side on another model. */
const SUPPORTS_FALLBACK = /^claude-(?:opus-5|sonnet-5-5|fable-5|mythos-5)/

const describe = (cause: unknown): ModelError => {
  if (cause instanceof Anthropic.AuthenticationError) {
    return new ModelError({ message: "Anthropic rejected the API key. Run `oi auth login`.", status: 401 })
  }

  if (cause instanceof Anthropic.RateLimitError) {
    return new ModelError({ message: `Rate limited by Anthropic: ${cause.message}`, status: 429 })
  }

  if (cause instanceof Anthropic.APIError && Number.isInteger(cause.status)) {
    return new ModelError({ message: cause.message, status: cause.status })
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

  return Layer.succeed(Model, { run })
}

/**
 * A model that answers from a script. Used by tests and by `--model scripted`
 * demos; it exercises the same loop, spans and fold as a real model.
 */
export const scriptedModel = (
  respond: (call: ModelCall, step: number) => Json,
  delayMs: number = 0,
): Layer.Layer<Model> => {
  let step = 0

  return Layer.succeed(Model, {
    run: (call, hooks) =>
      Effect.gen(function* () {
        hooks.onRequest(
          JSON.stringify({
            model: "scripted",
            system: call.system,
            tools: call.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
            messages: call.messages,
          }),
        )

        const response = respond(call, step)

        step += 1

        if (delayMs > 0) yield* Effect.sleep(delayMs)

        return JSON.stringify(response)
      }),
  })
}
