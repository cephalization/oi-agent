import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import {
  definitionFrom,
  loadEvals,
  pendingFeedback,
  runEvals,
  saveEval,
  type TurnRecord,
  type EvalDefinition,
  type Verdict,
} from "../src/evals.ts"
import { readRules } from "../src/rules.ts"
import { Store } from "../src/store.ts"
import { BackgroundFixture, outcomeCheck } from "./fixtures/eval-background.ts"

let root = ""

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "oi-background-evals-"))
  vi.stubEnv("OI_AGENT_CONFIG_DIR", path.join(root, "config"))
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

const setup = (label = "pass") => {
  const store = new Store(root)
  const fixture = new BackgroundFixture(store, root)
  const judged: Array<TurnRecord> = []
  const distilled: Array<TurnRecord> = []

  const runtime = (disk: Store = store) => ({
    store: disk,
    judge: async (_definition: typeof outcomeCheck, record: TurnRecord) => {
      judged.push(record)

      return { label, score: label === "pass" ? 1 : 0 }
    },
    distill: async (_definition: EvalDefinition, _verdict: Verdict, record: TurnRecord) => {
      distilled.push(record)

      return "Verify the outcome before reporting completion."
    },
  })

  saveEval(root, { ...outcomeCheck, learn: true })
  const evaluate = (traceId: string, disk?: Store) => runEvals(runtime(disk), fixture.sessionId, traceId)

  return { store, fixture, judged, distilled, evaluate }
}

describe("opt-in background outcome checks", () => {
  it("persists the opt-in, defaults to immediate, and rejects it for code/metrics", () => {
    const input = { name: "x", description: "x", kind: "llm" as const, instructions: "x" }
    expect(definitionFrom(input)).toMatchObject({ wait_for_background: false })
    expect(definitionFrom({ ...input, wait_for_background: true })).toMatchObject({
      wait_for_background: true,
    })
    expect(definitionFrom({ ...input, kind: "code", pattern: "x", wait_for_background: true })).toContain(
      "only supported for llm",
    )
    expect(
      definitionFrom({
        ...input,
        kind: "threshold",
        metric: "tool_calls",
        max: 1,
        wait_for_background: true,
      }),
    ).toContain("only supported for llm")
    saveEval(root, outcomeCheck)
    expect(loadEvals(root)[0]).toMatchObject({ wait_for_background: true })
  })

  it("records pending without judging, feedback, score, or learning, even with a hostile fail_labels list", async () => {
    const { store, fixture, evaluate, judged, distilled } = setup("fail")
    saveEval(root, { ...outcomeCheck, learn: true, fail_labels: ["pending", "fail"] })
    const launch = fixture.turn({ launches: ["job"] })
    const [annotation] = await evaluate(launch.traceId)

    expect(annotation?.annotation).toMatchObject({
      label: "pending",
      metadata: {
        pending: true,
        failed: false,
        feedback: false,
        skipped: false,
        deferred_from: launch.traceId,
      },
    })
    expect(annotation?.annotation.score).toBeUndefined()
    expect(judged).toHaveLength(0)
    expect(distilled).toHaveLength(0)
    expect(pendingFeedback(store, fixture.sessionId)).toEqual([])
    expect(readRules(root)).toBe("")
  })

  it("recovers from disk, waits for every direct task/job, and combines partial deliveries without attributing new calls to the launch", async () => {
    const { store, fixture, evaluate, judged } = setup()
    const launch = fixture.turn({ launches: ["job", "task"] })
    await evaluate(launch.traceId)

    const unrelated = fixture.turn({
      input: "The tests are done, everything passed (no attributed delivery).",
    })

    // A turn that launched nothing is judged on its own; the launch stays pending without a second record.
    expect((await evaluate(unrelated.traceId)).map((a) => a?.annotation.label)).toEqual(["skipped"])

    const partial = fixture.turn({
      deliveries: launch.deliveries.slice(0, 1),
      input: "job result: pnpm test exited 0. JOB_SUCCESS",
    })

    expect((await evaluate(partial.traceId)).map((a) => a?.annotation.label)).toEqual(["skipped"])
    expect(judged).toHaveLength(0)
    expect(
      store.listAnnotations(fixture.sessionId).filter((a) => a.annotation.label === "pending"),
    ).toHaveLength(1)

    const child = new BackgroundFixture(store, root)
    const childResult = child.turn({ output: "42 passed. TASK_SUCCESS" })

    const complete = fixture.turn({
      deliveries: launch.deliveries
        .slice(1)
        .map((delivery) => ({ ...delivery, result: { session_id: child.sessionId, ...childResult.ref } })),
      input: "task result delivered",
    })

    const [result] = await evaluate(complete.traceId, new Store(store.home))
    expect(result?.annotation).toMatchObject({
      label: "pass",
      metadata: { pending: false, deferred_from: launch.traceId },
    })
    expect(judged).toHaveLength(1)
    expect(judged[0]?.judged).toContain("original launch turn")
    expect(judged[0]?.judged).toContain("pnpm test")
    expect(judged[0]?.judged).toContain("JOB_SUCCESS")
    expect(judged[0]?.judged).toContain("TASK_SUCCESS")
    expect(judged[0]?.metrics.tool_calls).toBe(2)
    expect(judged[0]?.activity?.get("tool:delegate")).toBe("yes")

    const next = fixture.turn({ input: "Thanks." })
    expect((await evaluate(next.traceId))[0]?.annotation.label).toBe("skipped")
    expect(judged).toHaveLength(1)
  })

  it("resolves failure only after delivery and distills launch plus outcome evidence", async () => {
    const { store, fixture, evaluate, judged, distilled } = setup("fail")
    const launch = fixture.turn({ launches: ["job"] })
    await evaluate(launch.traceId)

    const completion = fixture.turn({
      deliveries: launch.deliveries,
      input: "pnpm test was canceled; no successful result. CANCELED",
    })

    const [result] = await evaluate(completion.traceId)

    expect(result?.annotation).toMatchObject({
      label: "fail",
      metadata: { pending: false, failed: true, feedback: true },
    })
    expect(judged).toHaveLength(1)
    expect(distilled).toHaveLength(1)
    expect(distilled[0]?.transcript).toContain("pnpm test")
    expect(distilled[0]?.transcript).toContain("CANCELED")
    expect(pendingFeedback(store, fixture.sessionId)).toHaveLength(1)
    expect(readRules(root)).toContain("Verify the outcome")

    const corrective = fixture.turn({
      input: "Explain the failed verification.",
      output: "The earlier test run was canceled.",
    })

    await evaluate(corrective.traceId)
    expect(judged[1]?.judged).toContain("[failing turn]")
    expect(judged[1]?.judged).toContain("original launch turn")
    expect(judged[1]?.judged).toContain("CANCELED")
  })

  it("keeps concurrent launch-turn obligations independent", async () => {
    const { fixture, evaluate, judged } = setup()
    const first = fixture.turn({ launches: ["job"] })
    await evaluate(first.traceId)
    const second = fixture.turn({ launches: ["task"] })
    expect((await evaluate(second.traceId)).map((a) => a?.annotation.label)).toEqual(["pending"])
    const oneDone = fixture.turn({ deliveries: first.deliveries, input: "first completed successfully" })
    expect((await evaluate(oneDone.traceId)).map((a) => a?.annotation.label)).toEqual(["pass", "skipped"])
    const allDone = fixture.turn({ deliveries: second.deliveries, input: "second completed successfully" })
    expect((await evaluate(allDone.traceId)).map((a) => a?.annotation.label)).toEqual(["pass", "skipped"])
    expect(judged).toHaveLength(2)
  })

  it("resolves the old launch while independently deferring work launched in the delivery turn", async () => {
    const { fixture, evaluate, judged } = setup()
    const first = fixture.turn({ launches: ["job"] })
    await evaluate(first.traceId)

    const delivery = fixture.turn({
      deliveries: first.deliveries,
      launches: ["task"],
      input: "first job succeeded",
    })

    const results = await evaluate(delivery.traceId)
    expect(results.map((a) => a?.annotation.label)).toEqual(["pass", "pending"])
    expect(judged).toHaveLength(1)
    // Original launch evidence has one bash call, not the fresh delegate call.
    expect(judged[0]?.metrics.tool_calls).toBe(1)
    expect(judged[0]?.tool_input).not.toContain("delegate")
  })

  it("gives up a pending obligation whose result was delivered on another fork", async () => {
    const { fixture, evaluate, judged } = setup()
    const launch = fixture.turn({ launches: ["job"] })
    await evaluate(launch.traceId)

    const fork = fixture.turn({
      previous: null,
      deliveries: launch.deliveries,
      input: "succeeded on another fork",
    })

    expect((await evaluate(fork.traceId))[0]?.annotation.label).toBe("skipped")
    const continuation = fixture.turn({ previous: launch.ref, input: "continue waiting" })
    const [abandoned] = await evaluate(continuation.traceId)

    // The result is delivered once per session, so this branch would otherwise wait forever.
    expect(abandoned?.annotation).toMatchObject({
      label: "skipped",
      metadata: { deferred_from: launch.traceId },
    })
    expect(abandoned?.annotation.explanation).toContain("another branch")
    expect(judged).toHaveLength(0)

    const later = fixture.turn({ previous: continuation.ref, input: "and on" })

    expect((await evaluate(later.traceId)).map((a) => a?.annotation.metadata?.["deferred_from"])).toEqual([
      undefined,
    ])
  })

  it("waits for task_message that starts a new runner, then resolves its own linked outcome", async () => {
    const { fixture, evaluate, judged } = setup()
    saveEval(root, { ...outcomeCheck, applicability: { any: ["tool:task_message"] } })
    const followup = fixture.turn({ launches: ["followup"] })
    expect((await evaluate(followup.traceId))[0]?.annotation.label).toBe("pending")
    expect(judged).toHaveLength(0)

    const result = fixture.turn({
      deliveries: followup.deliveries,
      input: "follow-up runner completed: 42 passed",
    })

    expect((await evaluate(result.traceId))[0]?.annotation.label).toBe("pass")
    expect(judged[0]?.judged).toContain("task_message")
    expect(judged[0]?.judged).toContain("follow-up runner completed")
  })

  it("does not defer launch prohibitions by default", async () => {
    const { fixture, evaluate, judged } = setup("fail")
    saveEval(root, { ...outcomeCheck, wait_for_background: false })
    const launch = fixture.turn({ launches: ["job"] })
    expect((await evaluate(launch.traceId))[0]?.annotation.label).toBe("fail")
    expect(judged).toHaveLength(1)
  })

  it("does not defer skipped checks or status/steering calls", async () => {
    const { fixture, evaluate, judged } = setup()
    saveEval(root, { ...outcomeCheck, applicability: { any: ["tool:write_file"] } })
    const skipped = fixture.turn({ launches: ["task"] })
    expect((await evaluate(skipped.traceId))[0]?.annotation.label).toBe("skipped")

    saveEval(root, { ...outcomeCheck, applicability: { any: ["always"] } })
    const steer = fixture.turn({ launches: ["steer"] })
    expect((await evaluate(steer.traceId))[0]?.annotation.label).toBe("pass")
    expect(judged).toHaveLength(1)
  })
})
