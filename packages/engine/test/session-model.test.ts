import { Effect, Layer } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { approveAll, runTurn, type TurnEnv } from "../src/agent.ts"
import type { Dialect } from "../src/dialect.ts"
import { anthropicMessages, openaiChat, openaiResponses } from "../src/dialects/index.ts"
import { lastModelOf } from "../src/fold.ts"
import { kindOf, OI, readMetadata } from "../src/format.ts"
import { Model } from "../src/model.ts"
import type { Json } from "../src/wire.ts"
import { tempEnv } from "./helpers.ts"

/** A model that records `request` as what it sent and answers with `response`. */
const servedBy = (provider: string, dialect: Dialect, request: Json, response: Json): Layer.Layer<Model> =>
  Layer.succeed(Model, {
    dialect,
    provider,
    // As the built-in providers are: the ChatGPT plan reaches OpenAI, and is not billed per token.
    vendor: provider === "chatgpt" ? "openai" : provider,
    billing: provider === "chatgpt" ? "plan" : "api",
    run: (_call, hooks) =>
      Effect.sync(() => {
        hooks.onRequest(JSON.stringify(request))

        return JSON.stringify(response)
      }),
  })

const turn = (env: TurnEnv, text: string, model: Layer.Layer<Model>) =>
  Effect.runPromise(
    runTurn(env, { text, userId: "tony", previous: null }).pipe(
      Effect.provide(Layer.mergeAll(model, approveAll)),
    ),
  )

const anthropic = servedBy(
  "anthropic",
  anthropicMessages,
  { model: "claude-a", messages: [], output_config: { effort: "high" } },
  { model: "claude-a", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
)

const responses = servedBy(
  "chatgpt",
  openaiResponses,
  { model: "gpt-b", input: [], reasoning: { effort: "low", summary: "auto" } },
  {
    model: "gpt-b",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
  },
)

describe("a session's last model", () => {
  it("is undefined before any model has served the session", () => {
    const env = tempEnv()

    expect(lastModelOf(env.store, env.sessionId)).toBeUndefined()
  })

  it("is the configured provider, model and effort of the newest turn's call", async () => {
    const env = tempEnv()

    await turn(env, "one", anthropic)
    expect(lastModelOf(env.store, env.sessionId)).toEqual({
      provider: "anthropic",
      model: "claude-a",
      effort: "high",
    })

    await turn(env, "two", responses)
    expect(lastModelOf(env.store, env.sessionId)).toEqual({
      provider: "chatgpt",
      model: "gpt-b",
      effort: "low",
    })
  })

  it("records who served each call in llm.provider, and oi's provider id and the billing in metadata", async () => {
    const env = tempEnv()

    await turn(env, "one", anthropic)
    await turn(env, "two", responses)

    const calls = env.store
      .listTraceIds(env.sessionId)
      .flatMap((traceId) => env.store.readTrace(env.sessionId, traceId).ended)
      .filter((span) => kindOf(span) === "LLM")
      .map((span) => ({
        system: span.attributes[OI.LLM_SYSTEM],
        vendor: span.attributes[OI.LLM_PROVIDER],
        provider: readMetadata(span).provider,
        billing: readMetadata(span).billing,
      }))

    expect(calls).toEqual([
      { system: "anthropic", vendor: "anthropic", provider: "anthropic", billing: "api" },
      { system: "openai", vendor: "openai", provider: "chatgpt", billing: "plan" },
    ])
  })
})

describe("effort in a stored request", () => {
  it("is read the way each dialect sends it", () => {
    expect(
      anthropicMessages.effort(
        JSON.stringify({ model: "m", messages: [], output_config: { effort: "max" } }),
      ),
    ).toBe("max")

    expect(
      openaiResponses.effort(JSON.stringify({ model: "m", input: [], reasoning: { effort: "xhigh" } })),
    ).toBe("xhigh")

    expect(openaiChat.effort(JSON.stringify({ model: "m", messages: [], reasoning_effort: "medium" }))).toBe(
      "medium",
    )
  })

  it("is undefined when absent or not a level this harness knows", () => {
    expect(anthropicMessages.effort(JSON.stringify({ model: "m", messages: [] }))).toBeUndefined()
    expect(
      openaiChat.effort(JSON.stringify({ model: "m", messages: [], reasoning_effort: "minimal" })),
    ).toBeUndefined()
    expect(openaiResponses.effort("not json")).toBeUndefined()
  })
})
