import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { attachEvals } from "../src/eval-tool.ts"
import { runEvals, saveEval, type TurnRecord } from "../src/evals.ts"
import { Engine } from "../src/engine.ts"
import { loadSession, pendingInbox } from "../src/fold.ts"
import { kindOf, readMetadata } from "../src/format.ts"
import { scriptedModel } from "../src/model.ts"
import { Store } from "../src/store.ts"
import type { Json } from "../src/wire.ts"
import { outcomeCheck } from "./fixtures/eval-background.ts"
import { tempStore } from "./helpers.ts"

/** Labels of the outcome checks: the results that settle a launch turn, not each turn's own verdict. */
const outcomes = (store: Store, sessionId: string): Array<string | undefined> =>
  store
    .listAnnotations(sessionId)
    .filter((a) => a.annotation.metadata?.["deferred_from"] !== undefined)
    .map((a) => a.annotation.label)

const say = (text: string): Json => ({ content: [{ type: "text", text }], stop_reason: "end_turn" })

const use = (name: string, input: Json): Json => ({
  content: [{ type: "tool_use", id: `${name}-call`, name, input }],
  stop_reason: "tool_use",
})

for (const tool of ["job_status", "job_kill"]) {
  describe(`outcomes consumed by ${tool}`, () => {
    it("resolves the pending outcome durably without duplicate automatic delivery, including after restart", async () => {
      const store = tempStore()
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-polled-outcome-"))

      const config = loadConfig({
        OI_AGENT_CONFIG_DIR: path.join(store.home, "config"),
        OI_AGENT_HOME: store.home,
      })

      const judged: Array<TurnRecord> = []
      const expected = tool === "job_status" ? "pass" : "fail"

      const engine = new Engine({
        store,
        config,
        approvals: "allow",
        model: scriptedModel((_call, step) => {
          if (step === 0)
            return use("bash", {
              command: tool === "job_status" ? "sleep 0.5; echo verified" : "sleep 30",
              timeout_ms: 1,
            })

          if (step === 2) {
            const job = engine.jobs.list(sessionId)[0]

            if (job === undefined) throw new Error("No background job")

            return use(tool, { id: job.id, wait_ms: 2000 })
          }

          return say("Reported the observed result.")
        }),
      })

      const sessionId = engine.createSession(cwd).id

      const runtime = {
        store,
        judge: async (_definition: typeof outcomeCheck, record: TurnRecord) => {
          judged.push(record)

          return { label: expected }
        },
        distill: async () => undefined,
      }

      attachEvals(engine, runtime)
      saveEval(cwd, outcomeCheck)

      try {
        await engine.submit(sessionId, { text: "Start verification", userId: "tester" })
        await engine.idle(sessionId)
        expect(outcomes(store, sessionId)).toEqual(["pending"])
        engine.attend(sessionId)
        await engine.submit(sessionId, { text: "Observe the result", userId: "tester" })
        await engine.idle(sessionId)
        expect(outcomes(store, sessionId)).toEqual(["pending", expected])
        expect(judged).toHaveLength(1)
        expect(judged[0]?.judged).toContain(tool === "job_status" ? "exited with code 0" : "killed after")
        expect(judged[0]?.judged).toContain("original launch turn")

        const turns = loadSession(store, sessionId).turns

        const observing = store
          .readTrace(sessionId, turns[1]!.trace_id)
          .ended.find((span) => kindOf(span) === "TOOL")!

        const [delivery] = readMetadata(observing).delivers ?? []
        expect(delivery?.trace_id).toBe(turns[0]?.trace_id)
        expect(delivery?.inbox_id).toMatch(/^job-/)
        expect(readMetadata(turns[1]!.root).observed_results).toEqual([delivery?.inbox_id])
        expect(store.listInbox(sessionId)).toHaveLength(1)
        expect(pendingInbox(store, sessionId)).toEqual([])
        const job = engine.jobs.list(sessionId)[0]!
        expect(engine.jobs.isReported(job)).toBe(true)
        await engine.jobs.ended(job)
        engine.attend(sessionId)
        await engine.settled(sessionId)
        expect(loadSession(store, sessionId).turns).toHaveLength(2)
        engine.close()

        const reopened = new Store(store.home)

        const after = new Engine({
          store: reopened,
          config,
          approvals: "allow",
          model: scriptedModel((_call, step) =>
            step === 0 ? use(tool, { id: job.id }) : say("Still done."),
          ),
        })

        try {
          after.attend(sessionId)
          await after.settled(sessionId)
          expect(loadSession(reopened, sessionId).turns).toHaveLength(2)
          expect(pendingInbox(reopened, sessionId)).toEqual([])
          // Re-evaluate from disk with a fresh Store, independent of any in-memory completion bookkeeping.
          expect(
            (await runEvals({ ...runtime, store: reopened }, sessionId, turns[1]!.trace_id))[0]?.annotation
              .label,
          ).toBe("skipped")

          // Asking about the job again later is not a second result.
          await after.submit(sessionId, { text: "Check that old job again", userId: "tester" })
          await after.idle(sessionId)

          const again = loadSession(reopened, sessionId).turns[2]!

          const asked = reopened
            .readTrace(sessionId, again.trace_id)
            .ended.filter((span) => kindOf(span) === "TOOL")

          expect(asked).toHaveLength(1)
          expect(readMetadata(asked[0]!).delivers).toBeUndefined()
          expect(readMetadata(again.root).observed_results).toBeUndefined()
        } finally {
          after.close()
        }
      } finally {
        engine.jobs.killAll(sessionId)
        engine.close()
        fs.rmSync(store.home, { recursive: true, force: true })
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })
}

class InterruptedObservationStore extends Store {
  interrupt = false

  override writeInbox(...args: Parameters<Store["writeInbox"]>) {
    const entry = super.writeInbox(...args)

    if (this.interrupt && entry.delivers !== undefined) {
      this.interrupt = false
      throw new Error("Interrupted after durable completion, before claim/TOOL consumption")
    }

    return entry
  }
}

it("recovers an interrupted polled observation from its durable inbox without losing or duplicating the outcome", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oi-observation-recovery-"))
  const store = new InterruptedObservationStore(home)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-observation-cwd-"))
  const config = loadConfig({ OI_AGENT_HOME: home })

  const engine = new Engine({
    store,
    config,
    approvals: "allow",
    model: scriptedModel((_call, step) => {
      if (step === 0) return use("bash", { command: "sleep 0.5; echo recovered-verification", timeout_ms: 1 })

      if (step === 2) return use("job_status", { id: engine.jobs.list(sessionId)[0]!.id, wait_ms: 2000 })

      return say("Observed.")
    }),
  })

  const sessionId = engine.createSession(cwd).id
  const judged: Array<TurnRecord> = []

  const judge = async (_definition: typeof outcomeCheck, record: TurnRecord) => {
    judged.push(record)

    return { label: "pass" }
  }

  const runtime = { store, judge, distill: async () => undefined }
  attachEvals(engine, runtime)
  saveEval(cwd, outcomeCheck)

  try {
    await engine.submit(sessionId, { text: "Start verification", userId: "tester" })
    await engine.idle(sessionId)
    store.interrupt = true
    await engine.submit(sessionId, { text: "Wait for verification", userId: "tester" })
    await engine.idle(sessionId)
    expect(judged).toHaveLength(0)
    expect(outcomes(store, sessionId)).toEqual(["pending"])
    expect(pendingInbox(store, sessionId)).toHaveLength(1)
    // Also cover death after a reported marker exists but before an observing TOOL can be committed.
    const claimed = engine.jobs.list(sessionId)[0]!
    engine.jobs.claim(claimed)
    expect(engine.jobs.isReported(claimed)).toBe(true)
    engine.close()
    const reopened = new Store(home)

    const after = new Engine({
      store: reopened,
      config,
      approvals: "allow",
      model: scriptedModel(() => say("Recovered completion.")),
    })

    attachEvals(after, { ...runtime, store: reopened })

    try {
      after.attend(sessionId)
      await after.settled(sessionId)
      expect(judged).toHaveLength(1)
      expect(judged[0]?.judged).toContain("recovered-verification")
      expect(outcomes(reopened, sessionId)).toEqual(["pending", "pass"])
      expect(pendingInbox(reopened, sessionId)).toEqual([])
      expect(reopened.listInbox(sessionId)).toHaveLength(1)
      expect(loadSession(reopened, sessionId).turns).toHaveLength(3)
    } finally {
      after.close()
    }
  } finally {
    engine.jobs.killAll(sessionId)
    engine.close()
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
