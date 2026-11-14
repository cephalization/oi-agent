import * as fs from "node:fs"
import { createServer } from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { approveAll, runTurn, type TurnEnv, type TurnInput } from "../src/agent.ts"
import type { Dialect } from "../src/dialect.ts"
import { anthropicMessages, openaiChat, openaiResponses } from "../src/dialects/index.ts"
import { contextFor, loadSession } from "../src/fold.ts"
import { kindOf, OI, readMetadata } from "../src/format.ts"
import { Model, type ModelCall, scriptedModel } from "../src/model.ts"
import { openaiModel, type OpenAISettings } from "../src/openai.ts"
import { Redactor } from "../src/redact.ts"
import { builtinTools } from "../src/tools.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const setup = (): TurnEnv => {
  const store = tempStore()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-cwd-"))
  const session = store.createSession(cwd)

  return { store, sessionId: session.id, cwd, tools: builtinTools, redactor: new Redactor() }
}

const run = (
  env: TurnEnv,
  input: TurnInput,
  dialect: Dialect,
  respond: (call: ModelCall, step: number) => Json,
) =>
  Effect.runPromise(
    runTurn(env, input).pipe(Effect.provide(Layer.mergeAll(scriptedModel(respond, 0, dialect), approveAll))),
  )

const turn = (text: string, previous: TurnInput["previous"] = null): TurnInput => ({
  text,
  userId: "tony",
  previous,
})

// --- scripted responses, one per dialect --------------------------------------------

const chatCall = (id: string, command: string): Json => ({
  model: "scripted",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
})

const chatText = (text: string): Json => ({
  model: "scripted",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 5 },
})

const responsesCall = (id: string, command: string): Json => ({
  model: "scripted",
  status: "completed",
  output: [
    { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque" },
    { id: "fc_1", type: "function_call", call_id: id, name: "bash", arguments: JSON.stringify({ command }) },
  ],
  usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
})

const responsesText = (text: string): Json => ({
  model: "scripted",
  status: "completed",
  output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 20, output_tokens: 5 },
})

const anthropicCall = (id: string, command: string): Json => ({
  model: "scripted",
  content: [
    { type: "thinking", thinking: "Run it.", signature: "sig-1" },
    { type: "tool_use", id, name: "bash", input: { command } },
  ],
  stop_reason: "tool_use",
})

const anthropicText = (text: string): Json => ({
  model: "scripted",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
})

describe("OpenAI dialects through the agent loop", () => {
  it("runs a Chat Completions turn with a tool call, rebuilding each request from disk", async () => {
    const env = setup()
    const seen: Array<ReadonlyArray<Json>> = []

    await run(env, turn("say hi"), openaiChat, (call, step) => {
      seen.push(call.messages)

      return step === 0 ? chatCall("call_1", "echo hi-from-chat") : chatText("It printed hi.")
    })

    expect(seen[1]).toEqual([
      { role: "user", content: "say hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: '{"command":"echo hi-from-chat"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: expect.stringContaining("hi-from-chat") },
    ])

    const [traceId] = env.store.listTraceIds(env.sessionId)
    const trace = env.store.readTrace(env.sessionId, traceId ?? "")
    const llm = trace.ended.find((span) => kindOf(span) === "LLM")

    expect(readMetadata(llm ?? trace.ended[0]!).api).toBe("openai-chat")
    expect(llm?.attributes[OI.LLM_SYSTEM]).toBe("openai")
    expect(llm?.attributes[`${OI.LLM_INPUT_MESSAGES}.0.message.role`]).toBe("system")
    expect(loadSession(env.store, env.sessionId).turns[0]?.output).toBe("It printed hi.")
  })

  it("replays Responses output items without ids, keeping encrypted reasoning", async () => {
    const env = setup()
    const seen: Array<ReadonlyArray<Json>> = []

    await run(env, turn("say hi"), openaiResponses, (call, step) => {
      seen.push(call.messages)

      return step === 0 ? responsesCall("call_9", "echo hi-from-responses") : responsesText("Done.")
    })

    expect(seen[1]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] },
      { type: "reasoning", summary: [], encrypted_content: "opaque" },
      {
        type: "function_call",
        call_id: "call_9",
        name: "bash",
        arguments: '{"command":"echo hi-from-responses"}',
      },
      {
        type: "function_call_output",
        call_id: "call_9",
        output: expect.stringContaining("hi-from-responses"),
      },
    ])
  })
})

describe("switching provider mid-session", () => {
  it("carries text, tool calls and results across dialects, and drops reasoning", async () => {
    const env = setup()

    await run(env, turn("list files"), anthropicMessages, (_call, step) =>
      step === 0 ? anthropicCall("toolu_1", "echo from-claude") : anthropicText("One file."),
    )

    const head = loadSession(env.store, env.sessionId).head

    const previous =
      head === undefined ? null : { trace_id: head.trace_id, span_id: head.root.context.span_id }

    const seen: Array<ReadonlyArray<Json>> = []

    await run(env, turn("and now?", previous), openaiResponses, (call) => {
      seen.push(call.messages)

      return responsesText("Still one.")
    })

    expect(seen[0]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "bash",
        arguments: '{"command":"echo from-claude"}',
      },
      { type: "function_call_output", call_id: "toolu_1", output: expect.stringContaining("from-claude") },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "One file." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "and now?" }] },
    ])

    // And back: the Responses turn reads as Anthropic messages, with no reasoning to replay.
    const back = contextFor(
      env.store,
      env.sessionId,
      loadSession(env.store, env.sessionId).head?.trace_id ?? "",
      anthropicMessages,
    )

    expect(back.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Still one." }] })
    expect(JSON.stringify(back)).not.toContain("sig-1")
  })

  it("leaves a conversation in its own dialect untouched", async () => {
    const env = setup()

    // One tool call, then an answer: a model that only ever calls tools runs the loop to its step limit.
    await run(env, turn("hi"), anthropicMessages, (_call, step) =>
      step === 0 ? anthropicCall("toolu_1", "true") : anthropicText("done"),
    )

    const traceId = loadSession(env.store, env.sessionId).head?.trace_id ?? ""

    expect(JSON.stringify(contextFor(env.store, env.sessionId, traceId))).toContain("sig-1")
  })
})

// --- the HTTP model against a local server ---------------------------------------------

const serve = async (respond: (url: string, body: string) => { status: number; body: string }) => {
  const requests: Array<{ url: string; body: string; auth: string | undefined }> = []

  const server = createServer((request, response) => {
    let body = ""

    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body, auth: request.headers.authorization })

      const reply = respond(request.url ?? "", body)

      response.writeHead(reply.status, { "content-type": "text/event-stream" })
      response.end(reply.body)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  const address = server.address()
  const port = address === null || Schema.is(Schema.String)(address) ? 0 : address.port

  return { base: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() }
}

const sse = (events: ReadonlyArray<Json>, done = false): string =>
  [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), done ? "data: [DONE]\n\n" : ""].join("")

const settings = (base: string, api: OpenAISettings["api"]): OpenAISettings => ({
  provider: "local",
  api,
  baseUrl: base,
  model: "m1",
  effort: undefined,
  maxTokens: 1000,
  token: () => Promise.resolve("secret-key"),
  onUnauthorized: "Replace the key.",
})

const call = (layer: Layer.Layer<Model>, deltas: Array<string> = []) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const model = yield* Model

      return yield* model.run(
        { system: "be brief", tools: builtinTools.slice(0, 1), messages: [{ role: "user", content: "hi" }] },
        { onRequest: () => undefined, onDelta: (delta) => deltas.push(`${delta.k}:${delta.d}`) },
      )
    }).pipe(Effect.provide(layer)),
  )

describe("the OpenAI HTTP model", () => {
  it("folds a Chat Completions stream, including split tool-call arguments, into one completion", async () => {
    const local = await serve(() => ({
      status: 200,
      body: sse(
        [
          { id: "c1", model: "m1", choices: [{ delta: { content: "Look" } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_a", function: { name: "bash", arguments: '{"comm' } }],
                },
              },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
        ],
        true,
      ),
    }))

    const deltas: Array<string> = []
    const exit = await call(openaiModel(settings(local.base, "chat")), deltas)

    local.close()

    const raw = Exit.isSuccess(exit) ? exit.value : ""
    const reply = openaiChat.reply(raw)

    expect(reply?.text).toBe("Look")
    expect(reply?.calls).toEqual([{ id: "call_a", name: "bash", input: { command: "ls" } }])
    expect(deltas[0]).toBe("text:Look")
    expect(local.requests[0]?.url).toBe("/v1/chat/completions")
    expect(local.requests[0]?.auth).toBe("Bearer secret-key")
    expect(JSON.parse(local.requests[0]?.body ?? "{}").messages[0]).toEqual({
      role: "system",
      content: "be brief",
    })
  })

  it("returns the completed response from a Responses stream, with store off", async () => {
    const final = responsesText("Hello.")

    const local = await serve(() => ({
      status: 200,
      body: sse([
        { type: "response.output_text.delta", output_index: 0, delta: "Hel" },
        { type: "response.output_text.delta", output_index: 0, delta: "lo." },
        { type: "response.completed", response: final },
      ]),
    }))

    const exit = await call(openaiModel(settings(local.base, "responses")))

    local.close()

    expect(Exit.isSuccess(exit) ? JSON.parse(exit.value) : undefined).toEqual(final)
    expect(JSON.parse(local.requests[0]?.body ?? "{}")).toMatchObject({
      store: false,
      instructions: "be brief",
      stream: true,
    })
  })

  it("reports rejected credentials with the provider's hint", async () => {
    const local = await serve(() => ({
      status: 401,
      body: JSON.stringify({ error: { message: "bad key" } }),
    }))

    const exit = await call(openaiModel(settings(local.base, "chat")))

    local.close()

    expect(Exit.isFailure(exit) ? String(exit.cause) : "").toContain(
      "local rejected the credentials. Replace the key.",
    )
  })
})
