import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { OI } from "../src/format.ts"
import { makeDiskTracer } from "../src/tracer.ts"
import { tempStore, tree } from "./helpers.ts"

describe("disk tracer", () => {
  it("writes one immutable file per ended span and leaves nothing in flight", async () => {
    const store = tempStore()
    const session = store.createSession("/tmp/project")
    const program = Effect.succeed("done").pipe(
      Effect.withSpan("child", { attributes: { [OI.SPAN_KIND]: "TOOL", "tool.name": "read" } }),
      Effect.withSpan("turn", { attributes: { [OI.SPAN_KIND]: "AGENT", [OI.INPUT_VALUE]: "hi" } }),
      Effect.withTracer(makeDiskTracer(store, session.id)),
    )

    await Effect.runPromise(program)

    const [traceId] = store.listTraceIds(session.id)
    const trace = store.readTrace(session.id, traceId ?? "")
    const root = trace.ended.find((span) => span.parent_id === null)
    const child = trace.ended.find((span) => span.parent_id !== null)

    expect(trace.open).toEqual([])
    expect(trace.ended).toHaveLength(2)
    expect(root?.name).toBe("turn")
    expect(root?.status_code).toBe("OK")
    expect(root?.attributes[OI.SESSION_ID]).toBe(session.id)
    expect(child?.parent_id).toBe(root?.context.span_id)
    expect(child?.context.trace_id).toBe(root?.context.trace_id)
    expect(tree(store.sessionDir(session.id)).every((file) => !file.includes(".open."))).toBe(true)
  })

  it("records a failure as an ERROR span with an exception event", async () => {
    const store = tempStore()
    const session = store.createSession("/tmp/project")
    const program = Effect.fail(new Error("boom")).pipe(
      Effect.withSpan("turn"),
      Effect.withTracer(makeDiskTracer(store, session.id)),
    )

    await Effect.runPromiseExit(program)

    const [traceId] = store.listTraceIds(session.id)
    const [span] = store.readTrace(session.id, traceId ?? "").ended

    expect(span?.status_code).toBe("ERROR")
    expect(span?.status_message).toBe("boom")
    expect(span?.events[0]?.name).toBe("exception")
  })

  it("exposes an in-flight span on disk while it runs", async () => {
    const store = tempStore()
    const session = store.createSession("/tmp/project")
    const seen: Array<string> = []
    const program = Effect.sync(() => {
      const [traceId] = store.listTraceIds(session.id)

      for (const open of store.readTrace(session.id, traceId ?? "").open) seen.push(open.span.name)
    }).pipe(
      Effect.delay("5 millis"),
      Effect.withSpan("turn"),
      Effect.withTracer(makeDiskTracer(store, session.id)),
    )

    await Effect.runPromise(program)

    expect(seen).toEqual(["turn"])
  })
})
