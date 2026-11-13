import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { attachEvals, createEvalTool } from "../src/eval-tool.ts"
import { loadEvals, saveEval } from "../src/evals.ts"
import { Engine } from "../src/engine.ts"
import { loadSession } from "../src/fold.ts"
import { kindOf, readMetadata } from "../src/format.ts"
import { type ModelCall, scriptedModel } from "../src/model.ts"
import { readRules, revertRules } from "../src/rules.ts"
import { builtinTools } from "../src/tools.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const say = (value: string): Json => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn" })

const use = (name: string, input: Json): Json => ({
  content: [{ type: "tool_use", id: `toolu_${name}`, name, input }],
  stop_reason: "tool_use",
})

const setup = (respond: (call: ModelCall, step: number) => Json) => {
  const store = tempStore()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-evals-"))

  const engine = new Engine({
    store,
    config: loadConfig({ OI_AGENT_CONFIG_DIR: store.home }),
    model: scriptedModel(respond),
    approvals: "allow",
    tools: [...builtinTools, createEvalTool],
  })

  attachEvals(engine, {
    store,
    judge: () =>
      Promise.resolve({ label: "fail", score: 0, explanation: "No test run appears in the turn." }),
    distill: () => Promise.resolve("Run the test suite before reporting that a change is complete."),
  })

  return { store, cwd, engine, sessionId: engine.createSession(cwd).id }
}

describe("evaluators", () => {
  it("records session size on each turn and fails a threshold evaluator when it is exceeded", async () => {
    const seen: Array<ReadonlyArray<Json>> = []

    const { engine, store, sessionId, cwd } = setup((call) => {
      seen.push(call.messages)

      return say("Done.")
    })

    saveEval(cwd, {
      name: "session_size",
      description: "Warn the user that the session is over the size limit.",
      kind: "threshold",
      metric: "session_bytes",
      max: 1000,
      fail_labels: ["fail"],
      feedback: true,
      learn: false,
    })

    await engine.submit(sessionId, { text: "hello", userId: "tony" })
    await engine.idle(sessionId)

    const turn = loadSession(store, sessionId).head
    const recorded = turn === undefined ? 0 : (readMetadata(turn.root).session_bytes ?? 0)
    const [annotation] = store.listAnnotations(sessionId)

    // The size on the span is the real footprint, short of the root span file itself.
    expect(recorded).toBeGreaterThan(1000)
    expect(recorded).toBeLessThanOrEqual(store.sessionBytes(sessionId))
    expect(annotation?.annotation).toMatchObject({ name: "session_size", label: "fail", score: recorded })
    expect(annotation?.annotation.explanation).toContain("over the limit of 1.0 kB")

    await engine.submit(sessionId, { text: "next", userId: "tony" })

    expect(JSON.stringify(seen[1])).toContain(
      "session_size: fail — Warn the user that the session is over the size limit.",
    )
  })

  it("lets the agent create an evaluator with a tool call", async () => {
    const { engine, sessionId, cwd } = setup((_call, step) =>
      step === 0
        ? use("create_eval", {
            name: "no_rm_rf",
            description: "Never run rm -rf.",
            kind: "code",
            pattern: "rm\\s+-rf",
            target: "tool_input",
          })
        : say("Added a check."),
    )

    await engine.submit(sessionId, { text: "never run rm -rf", userId: "tony" })
    await engine.idle(sessionId)

    expect(loadEvals(cwd).map((definition) => definition.name)).toEqual(["no_rm_rf"])
  })

  it("annotates a failing turn, feeds it back, and learns a rule", async () => {
    const seen: Array<ReadonlyArray<Json>> = []

    const { engine, store, sessionId, cwd } = setup((call) => {
      seen.push(call.messages)

      return say("Done.")
    })

    saveEval(cwd, {
      name: "ran_tests",
      description: "Tests are run before work is called done.",
      kind: "llm",
      instructions: "The assistant ran the tests before saying the work was done.",
      choices: { pass: 1, fail: 0 },
      fail_labels: ["fail"],
      feedback: true,
      learn: true,
    })

    await engine.submit(sessionId, { text: "fix the bug", userId: "tony" })
    await engine.idle(sessionId)

    const [annotation] = store.listAnnotations(sessionId)

    expect(annotation?.annotation).toMatchObject({ name: "ran_tests", label: "fail", annotator_kind: "LLM" })
    expect(annotation?.scope).toBe("trace")
    expect(readRules(cwd)).toContain("Run the test suite before reporting")

    await engine.submit(sessionId, { text: "thanks", userId: "tony" })
    await engine.idle(sessionId)

    const view = loadSession(store, sessionId)
    const second = JSON.stringify(seen[1])

    // The failure reached the model at the start of the next turn, exactly once.
    expect(second).toContain("<eval-feedback>")
    expect(second).toContain("ran_tests: fail")
    expect(view.turns.map((turn) => readMetadata(turn.root).injected?.[0]?.name)).toEqual([
      undefined,
      "ran_tests",
    ])
    // Evaluator runs are traces of their own, and are not turns.
    expect(view.turns).toHaveLength(2)
    expect(store.listTraceIds(sessionId).length).toBeGreaterThan(2)
    expect(
      store
        .listTraceIds(sessionId)
        .map((traceId) => store.readTraceRoots(sessionId, traceId).ended[0])
        .filter((root) => root !== undefined && kindOf(root) === "EVALUATOR"),
    ).toHaveLength(2)

    await engine.submit(sessionId, { text: "and again", userId: "tony" })

    expect(JSON.stringify(seen[2]).split("<eval-feedback>").length - 1).toBe(2)
    expect(revertRules(cwd)).toBe(true)
  })
})
