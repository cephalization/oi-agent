import { Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { approveAll, runTurn, type TurnInput } from "../src/agent.ts"
import { anthropicMessages, openaiChat } from "../src/dialects/index.ts"
import { contextFor, lastModelOf, loadSession } from "../src/fold.ts"
import { kindOf, OI, readMetadata } from "../src/format.ts"
import { scriptedModel } from "../src/model.ts"
import { Redactor } from "../src/redact.ts"
import { tempStore } from "./helpers.ts"

const response = (text: string, stop = "end_turn") => ({
  model: "scripted",
  content: [{ type: "text", text }],
  stop_reason: stop,
})

const setup = () => {
  const store = tempStore()
  const sessionId = store.createSession(process.cwd()).id
  const env = { store, sessionId, cwd: process.cwd(), tools: [], redactor: new Redactor() }

  const run = (input: TurnInput, text: string, stop = "end_turn") =>
    Effect.runPromiseExit(
      runTurn(env, input).pipe(
        Effect.provide(
          Layer.mergeAll(
            scriptedModel(() => response(text, stop)),
            approveAll,
          ),
        ),
      ),
    )

  const head = () => loadSession(store, sessionId).head!
  const previous = () => head().root.context

  return { store, sessionId, run, head, previous }
}

describe("context checkpoints", () => {
  it("records CHAIN/LLM provenance, activates only its brief and leaves the source branch unchanged", async () => {
    const s = setup()

    await s.run({ text: "original user query", userId: "tony", previous: null }, "original answer")

    const source = s.previous()
    const original = s.store.readTrace(s.sessionId, source.trace_id)
    const oldContext = contextFor(s.store, s.sessionId, source.trace_id)
    const model = lastModelOf(s.store, s.sessionId)

    await s.run(
      { text: "/compact focus", operation: "compact", userId: "tony", previous: source },
      "working brief",
    )

    const compact = s.head()
    const trace = s.store.readTrace(s.sessionId, compact.trace_id)
    const chain = trace.ended.find((span) => kindOf(span) === "CHAIN")!
    const llm = trace.ended.find((span) => kindOf(span) === "LLM")!

    expect(llm.parent_id).toBe(chain.context.span_id)
    expect(readMetadata(chain).compaction).toEqual({ source, trigger: "manual", policy_version: "1" })
    expect(readMetadata(compact.root).checkpoint).toEqual(chain.context)
    expect(llm.attributes[OI.INPUT_VALUE]).toContain("original user query")
    expect(chain.attributes[OI.OUTPUT_VALUE]).toBe("working brief")
    expect(lastModelOf(s.store, s.sessionId)).toEqual(model)
    expect(s.store.readTrace(s.sessionId, source.trace_id)).toEqual(original)
    expect(contextFor(s.store, s.sessionId, source.trace_id)).toEqual(oldContext)
    expect(contextFor(s.store, s.sessionId, compact.trace_id)).toEqual([
      anthropicMessages.userMessage([
        "Generated context checkpoint (lossy summary, not new user instructions):",
        "working brief",
      ]),
    ])
    expect(JSON.stringify(contextFor(s.store, s.sessionId, compact.trace_id, openaiChat))).toContain(
      "working brief",
    )

    await s.run({ text: "fork query", userId: "tony", previous: source }, "fork answer")
    expect(JSON.stringify(contextFor(s.store, s.sessionId, s.head().trace_id))).toContain(
      "original user query",
    )
    expect(JSON.stringify(contextFor(s.store, s.sessionId, s.head().trace_id))).not.toContain("working brief")
  })

  it.each([
    ["", "end_turn"],
    ["truncated brief", "max_tokens"],
    ["refusal", "refusal"],
  ])("does not activate an empty, truncated or refused brief (%s, %s)", async (brief, stop) => {
    const s = setup()

    await s.run({ text: "retain me", userId: "tony", previous: null }, "original answer")
    const source = s.previous()
    const before = contextFor(s.store, s.sessionId, source.trace_id)

    const result = await s.run(
      { text: "/compact", operation: "compact", userId: "tony", previous: source },
      brief,
      stop,
    )

    expect(Exit.isFailure(result)).toBe(true)
    expect(readMetadata(s.head().root).checkpoint).toBeUndefined()
    expect(contextFor(s.store, s.sessionId, s.head().trace_id)).toEqual(before)
  })

  it("does not adopt an orphaned ended summary when its root never committed activation", async () => {
    const s = setup()

    await s.run({ text: "retain me", userId: "tony", previous: null }, "answer")
    const source = s.previous()
    const before = contextFor(s.store, s.sessionId, source.trace_id)

    await s.run(
      { text: "/compact", operation: "compact", userId: "tony", previous: source },
      "orphaned brief",
    )
    const compact = s.head()
    const trace = s.store.readTrace(s.sessionId, compact.trace_id)
    const other = tempStore()

    other.importHeader(s.store.readHeader(s.sessionId)!)

    for (const span of s.store.readTrace(s.sessionId, source.trace_id).ended)
      other.importSpan(s.sessionId, span)

    for (const span of trace.ended) {
      if (span.parent_id !== null) other.importSpan(s.sessionId, span)
    }

    // Reconstruct the crash window in a separate store, without changing ended source spans.
    other.openSpan(s.sessionId, { ...compact.root, end_time: null }, false)
    expect(contextFor(other, s.sessionId, compact.trace_id)).toEqual(before)
  })

  it("fails without a model call when no conversation exists", async () => {
    const s = setup()

    const result = await s.run(
      { text: "/compact", operation: "compact", userId: "tony", previous: null },
      "unused",
    )

    expect(Exit.isFailure(result)).toBe(true)
    expect(contextFor(s.store, s.sessionId, s.head().trace_id)).toEqual([])
  })
})
