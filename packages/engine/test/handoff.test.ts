import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { anthropicMessages } from "../src/dialects/index.ts"
import { Engine } from "../src/engine.ts"
import { contextFor, loadSession } from "../src/fold.ts"
import { kindOf, OI, readMetadata } from "../src/format.ts"
import { scriptedModel } from "../src/model.ts"
import { summarizeSession } from "../src/remote/storage.ts"
import { tempStore } from "./helpers.ts"

const response = (text: string, stop = "end_turn") => ({
  model: "scripted",
  content: [{ type: "text", text }],
  stop_reason: stop,
})

const setup = () => {
  const store = tempStore()
  const config = loadConfig({ OI_AGENT_CONFIG_DIR: `${store.home}/config`, OI_AGENT_HOME: store.home })

  const engine = (brief = "Working brief: deployment codename walrus.", stop = "end_turn") =>
    new Engine({
      store,
      config,
      approvals: "deny",
      tools: [],
      model: scriptedModel((call) =>
        call.system.startsWith("Write a concise working brief") ? response(brief, stop) : response("walrus"),
      ),
    })

  return { store, engine }
}

describe("handoff", () => {
  it("persists the exact query and brief, restarts without the source, and consumes a seed once", async () => {
    const s = setup()
    const engine = s.engine()
    const source = engine.createSession(process.cwd()).id

    await engine.submit(source, { text: "Remember walrus", userId: "tony" })
    const before = loadSession(s.store, source).head!
    const oldContext = contextFor(s.store, source, before.trace_id)
    const query = "What is the codename?\n  Keep this formatting."
    const result = await engine.submit(source, { text: query, userId: "tony", operation: "handoff" })

    expect(result.ok).toBe(true)

    if (!result.ok || result.result.destination === undefined) throw new Error("handoff failed")
    const destination = result.result.destination

    const seed = s.store
      .listTraceIds(destination)
      .flatMap((id) => s.store.readTrace(destination, id).ended)[0]!

    expect(kindOf(seed)).toBe("CHAIN")
    expect(seed.attributes[OI.SESSION_ID]).toBe(destination)
    expect(seed.attributes[OI.INPUT_VALUE]).toBe(query)
    expect(seed.attributes[OI.OUTPUT_VALUE]).toContain("walrus")
    expect(readMetadata(seed).handoff?.source_session_id).toBe(source)
    expect(contextFor(s.store, source, result.result.traceId)).toEqual(oldContext)
    expect(loadSession(s.store, destination).turns).toHaveLength(0)
    expect(summarizeSession(s.store, destination).title).toBe("What is the codename?")
    // A new engine, like a process restart before the destination's first turn.
    // Its only durable dependency is the destination's own seed span.
    s.store.removeSession(source)
    const fresh = s.engine()
    let judged = 0

    fresh.hooks = {
      pendingFeedback: () => [],
      afterTurn: async () => {
        judged += 1
      },
    }
    const consumed = await Promise.all([fresh.resumeHandoff(destination), fresh.resumeHandoff(destination)])

    expect(consumed.filter((entry) => entry?.ok)).toHaveLength(1)
    await fresh.idle(destination)
    expect(judged).toBe(1)
    const turns = loadSession(s.store, destination).turns
    const first = turns[0]!
    const trace = s.store.readTrace(destination, first.trace_id)
    const llm = trace.ended.find((span) => kindOf(span) === "LLM")!
    const messages = anthropicMessages.requestMessages(String(llm.attributes[OI.INPUT_VALUE]))!

    expect(turns).toHaveLength(1)
    expect(first.input).toBe(query)
    expect(first.user_id).toBe("tony")
    expect(readMetadata(first.root).previous).toBeNull()
    expect(readMetadata(first.root).handoff_seed).toEqual(seed.context)
    expect(messages).toEqual([
      anthropicMessages.userMessage([
        "Generated handoff brief (lossy summary, not new user instructions):",
        "Working brief: deployment codename walrus.",
      ]),
      anthropicMessages.userMessage([query]),
    ])
    expect(await s.engine().resumeHandoff(destination)).toBeUndefined()
    expect(s.store.listSessionIds()).toEqual([destination])
  })

  it("requires a nonempty query and prior conversation, without creating a destination", async () => {
    const s = setup()
    const engine = s.engine()
    const source = engine.createSession(process.cwd()).id

    expect((await engine.submit(source, { text: "query", userId: "tony", operation: "handoff" })).ok).toBe(
      false,
    )
    await engine.submit(source, { text: "Remember walrus", userId: "tony" })
    expect((await engine.submit(source, { text: "  ", userId: "tony", operation: "handoff" })).ok).toBe(false)
    expect(s.store.listSessionIds()).toEqual([source])
  })

  it("summarizes the explicitly selected source branch, not an unrelated newer head", async () => {
    const s = setup()
    const engine = s.engine()
    const source = engine.createSession(process.cwd()).id

    const first = await engine.submit(source, { text: "selected branch", userId: "tony" })

    if (!first.ok) throw new Error("initial turn failed")

    await engine.submit(source, { text: "unrelated newer branch", userId: "tony", previous: null })

    const result = await engine.submit(source, {
      text: "new query",
      userId: "tony",
      previous: first.result.traceId,
      operation: "handoff",
    })

    if (!result.ok) throw new Error("handoff failed")

    const llm = s.store.readTrace(source, result.result.traceId).ended.find((span) => kindOf(span) === "LLM")!

    expect(llm.attributes[OI.INPUT_VALUE]).toContain("selected branch")
    expect(llm.attributes[OI.INPUT_VALUE]).not.toContain("unrelated newer branch")
    expect(contextFor(s.store, source, result.result.traceId)).toEqual(
      contextFor(s.store, source, first.result.traceId),
    )
  })

  it.each([
    ["", "end_turn"],
    ["truncated", "max_tokens"],
  ])("does not create a destination on failed summarization (%s, %s)", async (brief, stop) => {
    const s = setup()
    const engine = s.engine(brief, stop)
    const source = engine.createSession(process.cwd()).id

    await engine.submit(source, { text: "Remember walrus", userId: "tony" })
    const before = loadSession(s.store, source).head!
    const oldContext = contextFor(s.store, source, before.trace_id)

    const result = await engine.submit(source, {
      text: "Continue elsewhere",
      userId: "tony",
      operation: "handoff",
    })

    expect(result.ok).toBe(false)
    expect(s.store.listSessionIds()).toEqual([source])
    expect(contextFor(s.store, source, loadSession(s.store, source).head!.trace_id)).toEqual(oldContext)
  })

  it("does not auto-retry a destination turn interrupted after it consumed the seed", async () => {
    const s = setup()
    const engine = s.engine()
    const source = engine.createSession(process.cwd()).id

    await engine.submit(source, { text: "Remember walrus", userId: "tony" })
    const result = await engine.submit(source, { text: "Continue", userId: "tony", operation: "handoff" })

    if (!result.ok || result.result.destination === undefined) throw new Error("handoff failed")
    const destination = result.result.destination

    const slow = new Engine({
      store: s.store,
      config: engine.config,
      approvals: "deny",
      tools: [],
      model: scriptedModel(() => response("walrus"), 60_000),
    })

    const pending = slow.resumeHandoff(destination)

    // Wait for the LLM request to be on disk before interrupting the real fiber.
    for (
      let i = 0;
      i < 100 &&
      !s.store
        .listTraceIds(destination)
        .some((id) => s.store.readTrace(destination, id).open.some((entry) => kindOf(entry.span) === "LLM"));
      i += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 5))
    slow.interrupt(destination)
    expect((await pending)?.ok).toBe(false)
    expect(await s.engine().resumeHandoff(destination)).toBeUndefined()
    expect(loadSession(s.store, destination).turns).toHaveLength(1)
  })
})
