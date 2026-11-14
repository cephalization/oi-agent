import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { approveAll, Approver, runTurn, type TurnEnv, type TurnInput } from "../src/agent.ts"
import { contextFor, loadSession } from "../src/fold.ts"
import { kindOf, OI, readMetadata } from "../src/format.ts"
import { type ModelCall, scriptedModel } from "../src/model.ts"
import { Redactor } from "../src/redact.ts"
import { builtinTools } from "../src/tools.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const text = (value: string): Json => ({
  model: "scripted",
  content: [{ type: "text", text: value }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
})

const bash = (id: string, command: string): Json => ({
  model: "scripted",
  content: [
    { type: "thinking", thinking: "I should run it.", signature: "sig-1" },
    { type: "tool_use", id, name: "bash", input: { command } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
})

const setup = (): TurnEnv => {
  const store = tempStore()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-cwd-"))
  const session = store.createSession(cwd)

  return { store, sessionId: session.id, cwd, tools: builtinTools, redactor: new Redactor() }
}

const run = (env: TurnEnv, input: TurnInput, respond: (call: ModelCall, step: number) => Json) =>
  Effect.runPromiseExit(
    runTurn(env, input).pipe(Effect.provide(Layer.mergeAll(scriptedModel(respond), approveAll))),
  )

const first = (textValue: string): TurnInput => ({ text: textValue, userId: "tony", previous: null })

describe("agent loop", () => {
  it("records a turn as an AGENT span with LLM and TOOL children", async () => {
    const env = setup()
    const seen: Array<ReadonlyArray<Json>> = []

    await run(env, first("say hi"), (call, step) => {
      seen.push(call.messages)

      return step === 0 ? bash("toolu_1", "echo hi-from-bash") : text("It printed hi.")
    })

    const [traceId] = env.store.listTraceIds(env.sessionId)
    const trace = env.store.readTrace(env.sessionId, traceId ?? "")
    const kinds = trace.ended.map(kindOf).sort()
    const root = trace.ended.find((span) => span.parent_id === null)
    const tool = trace.ended.find((span) => kindOf(span) === "TOOL")

    expect(kinds).toEqual(["AGENT", "LLM", "LLM", "TOOL"])
    expect(trace.open).toEqual([])
    expect(root?.attributes[OI.INPUT_VALUE]).toBe("say hi")
    expect(root?.attributes[OI.OUTPUT_VALUE]).toBe("It printed hi.")
    expect(tool?.attributes[OI.TOOL_ID]).toBe("toolu_1")
    expect(tool?.attributes[OI.OUTPUT_VALUE]).toContain("hi-from-bash")
    // The second request was built from disk: it carries the first response and the tool result.
    expect(seen[1]).toEqual([
      { role: "user", content: "say hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should run it.", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "echo hi-from-bash" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "hi-from-bash\n[exit code 0]",
            is_error: false,
          },
        ],
      },
    ])
  })

  it("continues a conversation across turns from span files alone", async () => {
    const env = setup()

    await run(env, first("my name is Tony"), () => text("Hello Tony."))

    const head = loadSession(env.store, env.sessionId).head
    const seen: Array<ReadonlyArray<Json>> = []

    await run(
      env,
      {
        text: "what is my name?",
        userId: "tony",
        previous: head === undefined ? null : { trace_id: head.trace_id, span_id: head.root.context.span_id },
      },
      (call) => {
        seen.push(call.messages)

        return text("Tony.")
      },
    )

    const view = loadSession(env.store, env.sessionId)

    expect(seen[0]).toEqual([
      { role: "user", content: "my name is Tony" },
      { role: "assistant", content: [{ type: "text", text: "Hello Tony." }] },
      { role: "user", content: "what is my name?" },
    ])
    expect(view.turns.map((turn) => turn.state)).toEqual(["complete", "complete"])
    expect(view.head?.output).toBe("Tony.")
    expect(view.leaves).toHaveLength(1)
  })

  it("recovers a turn that died after its tool ran", async () => {
    const env = setup()

    await run(env, first("run it"), (_call, step) => {
      if (step === 0) return bash("toolu_9", "echo survived")

      throw new Error("process killed")
    })

    const view = loadSession(env.store, env.sessionId)
    const messages = contextFor(env.store, env.sessionId, view.head?.trace_id ?? "")

    expect(view.head?.state).toBe("failed")
    // Nothing was held in memory, so the next request still has the tool result.
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_9", content: "survived\n[exit code 0]", is_error: false },
      ],
    })
  })

  it("reports an interrupted tool call instead of losing it", async () => {
    const env = setup()

    await run(env, first("run it"), (_call, step) => {
      if (step === 0) return twoCalls("toolu_a", "toolu_b")

      return text("done")
    })

    const [traceId] = env.store.listTraceIds(env.sessionId)
    const trace = env.store.readTrace(env.sessionId, traceId ?? "")
    const missing = trace.ended.find((span) => span.attributes[OI.TOOL_ID] === "toolu_b")

    // Remove one tool span to simulate a crash between two parallel tool calls.
    fs.rmSync(
      path.join(
        env.store.traceDir(env.sessionId, traceId ?? ""),
        fs
          .readdirSync(env.store.traceDir(env.sessionId, traceId ?? ""))
          .find((name) => name.includes(missing?.context.span_id ?? "?")) ?? "",
      ),
    )

    const llm = trace.ended.filter((span) => kindOf(span) === "LLM").at(-1)

    fs.rmSync(
      path.join(
        env.store.traceDir(env.sessionId, traceId ?? ""),
        fs
          .readdirSync(env.store.traceDir(env.sessionId, traceId ?? ""))
          .find((name) => name.includes(llm?.context.span_id ?? "?")) ?? "",
      ),
    )

    const results = contextFor(env.store, env.sessionId, traceId ?? "").at(-1)

    expect(JSON.stringify(results)).toContain("interrupted before it completed")
    expect(JSON.stringify(results)).toContain("ran-a")
  })

  it("scrubs secrets from tool output before it reaches a span", async () => {
    const env = setup()

    fs.writeFileSync(
      path.join(env.cwd, ".env"),
      "TOKEN=hunter2-hunter2\nKEY=sk-ant-abcdefghijklmnopqrstuvwxyz\n",
    )
    env.redactor.add("hunter2-hunter2")
    await run(env, first("leak"), (_call, step) => (step === 0 ? bash("toolu_s", "cat .env") : text("ok")))

    const [traceId] = env.store.listTraceIds(env.sessionId)
    const all = JSON.stringify(env.store.readTrace(env.sessionId, traceId ?? "").ended)

    expect(all.includes("hunter2-hunter2")).toBe(false)
    expect(all.includes("sk-ant-abcdefghijklmnopqrstuvwxyz")).toBe(false)
    expect(all.includes("TOKEN=[redacted]")).toBe(true)
  })

  it("marks a tool call as awaiting approval on disk while the decision is pending", async () => {
    const env = setup()
    const seen: Array<boolean | undefined> = []

    // An approver that looks at the in-flight span file before deciding.
    const inspecting = Layer.succeed(Approver, {
      decide: (request) =>
        Effect.sync(() => {
          const pending = env.store
            .readTrace(env.sessionId, request.trace_id)
            .open.find((entry) => entry.span.context.span_id === request.span_id)

          seen.push(pending === undefined ? undefined : readMetadata(pending.span).awaiting_approval)

          return { decision: "allow" as const }
        }),
    })

    await Effect.runPromiseExit(
      runTurn(env, first("go")).pipe(
        Effect.provide(
          Layer.mergeAll(
            scriptedModel((_call, step) => (step === 0 ? bash("toolu_w", "echo waited") : text("ok"))),
            inspecting,
          ),
        ),
      ),
    )

    expect(seen).toEqual([true])

    const [traceId] = env.store.listTraceIds(env.sessionId)

    const tool = env.store
      .readTrace(env.sessionId, traceId ?? "")
      .ended.find((span) => kindOf(span) === "TOOL")

    expect(readMetadata(tool!).awaiting_approval).toBe(false)
    expect(readMetadata(tool!).approval?.decision).toBe("allow")
  })
})

const twoCalls = (a: string, b: string): Json => ({
  model: "scripted",
  content: [
    { type: "tool_use", id: a, name: "bash", input: { command: "echo ran-a" } },
    { type: "tool_use", id: b, name: "bash", input: { command: "echo ran-b" } },
  ],
  stop_reason: "tool_use",
})
