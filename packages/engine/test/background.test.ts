import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { Engine, SYSTEM_USER } from "../src/engine.ts"
import { contextFor, loadSession, pendingInbox } from "../src/fold.ts"
import { kindOf, OI, readMetadata, stringAttr } from "../src/format.ts"
import { type ModelCall, scriptedModel } from "../src/model.ts"
import { Redactor } from "../src/redact.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const text = (value: string): Json => ({
  model: "scripted",
  content: [{ type: "text", text: value }],
  stop_reason: "end_turn",
})

const bash = (id: string, input: Json): Json => ({
  model: "scripted",
  content: [{ type: "tool_use", id, name: "bash", input }],
  stop_reason: "tool_use",
})

const setup = (respond: (call: ModelCall, step: number) => Json) => {
  const store = tempStore()
  const config = loadConfig({ OI_AGENT_CONFIG_DIR: `${store.home}/config`, OI_AGENT_HOME: store.home })
  const redactor = new Redactor()

  const engine = (): Engine =>
    new Engine({ store, config, approvals: "allow", model: scriptedModel(respond), redactor })

  const sessionId = store.createSession(fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-cwd-"))).id

  return { store, engine, sessionId, redactor }
}

describe("background results", () => {
  it("a command that outlives its call is delivered as a turn that points back at the tool span", async () => {
    const script = [
      bash("call-1", { command: "sleep 0.5; echo suite passed", timeout_ms: 100 }),
      text("The suite is still running."),
      text("The suite passed."),
    ]

    const s = setup((_call, step) => script[step] ?? text("unexpected"))

    const engine = s.engine()

    engine.attend(s.sessionId)

    const first = await engine.submit(s.sessionId, { text: "Run the suite", userId: "tony" })

    expect(first.ok && first.result.output).toBe("The suite is still running.")

    await engine.settled(s.sessionId)

    const turns = loadSession(s.store, s.sessionId).turns

    expect(turns.map((turn) => turn.output)).toEqual(["The suite is still running.", "The suite passed."])

    const tool = s.store
      .readTrace(s.sessionId, turns[0]!.trace_id)
      .ended.find((span) => kindOf(span) === "TOOL")!

    const job = readMetadata(tool).job!

    expect(job.reason).toBe("timeout")
    expect(job.log.startsWith(path.join(s.store.home, "jobs", s.sessionId))).toBe(true)
    expect(stringAttr(tool, OI.OUTPUT_VALUE)).toContain(`continues in the background as job ${job.id}`)
    expect(tool.status_code).toBe("OK")

    const delivery = turns[1]!.root

    expect(stringAttr(delivery, OI.USER_ID)).toBe(SYSTEM_USER)
    expect(readMetadata(delivery).previous?.trace_id).toBe(turns[0]!.trace_id)
    expect(readMetadata(delivery).delivers).toEqual([
      {
        kind: "job",
        id: job.id,
        trace_id: tool.context.trace_id,
        span_id: tool.context.span_id,
        inbox_id: `job-${job.id}`,
      },
    ])
    expect(turns[1]!.input).toContain("<background-results>")
    expect(turns[1]!.input).toContain(`job ${job.id}: exited with code 0 after`)
    expect(turns[1]!.input).toContain("suite passed")
    expect(pendingInbox(s.store, s.sessionId)).toEqual([])

    // The model saw the tool's partial result, then the delivery, in one conversation.
    const context = JSON.stringify(contextFor(s.store, s.sessionId, turns[1]!.trace_id))

    expect(context).toContain("continues in the background as job")
    expect(context).toContain("suite passed")
    engine.close()
  })

  it("delivers every result that is waiting in one turn, and scrubs secrets from them", async () => {
    const secret = "sk-test-0123456789abcdef"

    const s = setup((_call, step) =>
      step === 0
        ? {
            model: "scripted",
            content: ["a", "b"].map((name) => ({
              type: "tool_use",
              id: `call-${name}`,
              name: "bash",
              input: { command: `sleep 1.3; echo ${name} ${secret}`, background: true },
            })),
            stop_reason: "tool_use",
          }
        : text(step === 1 ? "Both started." : "Both finished."),
    )

    s.redactor.add(secret)

    const engine = s.engine()

    // Nobody attends the session while the jobs finish: their results wait in the inbox.
    await engine.submit(s.sessionId, { text: "Start both", userId: "tony" })
    await Promise.all(engine.jobs.list(s.sessionId).map((job) => engine.jobs.ended(job)))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(loadSession(s.store, s.sessionId).turns).toHaveLength(1)
    expect(pendingInbox(s.store, s.sessionId)).toHaveLength(2)
    expect(JSON.stringify(s.store.listInbox(s.sessionId))).not.toContain(secret)

    engine.attend(s.sessionId)
    await engine.settled(s.sessionId)

    const turns = loadSession(s.store, s.sessionId).turns

    expect(turns).toHaveLength(2)
    expect(readMetadata(turns[1]!.root).delivers).toHaveLength(2)
    expect(turns[1]!.output).toBe("Both finished.")
    engine.close()
  })

  it("a new process delivers the result of a job the last one left running", async () => {
    // Each engine has its own model, so the script goes by what the model has seen, not by a step count.
    const s = setup((call) =>
      JSON.stringify(call.messages).includes("background")
        ? text("ok")
        : bash("call-1", { command: "sleep 1.5; echo late", background: true }),
    )

    const before = s.engine()

    await before.submit(s.sessionId, { text: "Start it", userId: "tony" })
    before.close()

    const after = s.engine()

    after.attend(s.sessionId)
    await after.settled(s.sessionId)

    const turns = loadSession(s.store, s.sessionId).turns

    expect(turns).toHaveLength(2)
    expect(turns[1]!.input).toContain("late")
    after.close()
  })
})
