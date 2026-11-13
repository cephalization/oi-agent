import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { approveAll, runTurn, type TurnEnv } from "../src/agent.ts"
import type { Dialect } from "../src/dialect.ts"
import { anthropicMessages, openaiChat, openaiResponses } from "../src/dialects/index.ts"
import { lastModelOf } from "../src/fold.ts"
import { Model } from "../src/model.ts"
import { Redactor } from "../src/redact.ts"
import { builtinTools } from "../src/tools.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const setup = (): TurnEnv => {
  const store = tempStore()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-cwd-"))

  return {
    store,
    sessionId: store.createSession(cwd).id,
    cwd,
    tools: builtinTools,
    redactor: new Redactor(),
  }
}

/** A model that records `request` as what it sent and answers with `response`. */
const servedBy = (provider: string, dialect: Dialect, request: Json, response: Json): Layer.Layer<Model> =>
  Layer.succeed(Model, {
    dialect,
    provider,
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
    const env = setup()

    expect(lastModelOf(env.store, env.sessionId)).toBeUndefined()
  })

  it("is the configured provider, model and effort of the newest turn's call", async () => {
    const env = setup()

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
