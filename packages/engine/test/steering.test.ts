import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { attachEvals, createEvalTool } from "../src/eval-tool.ts"
import { loadEvals, saveEval } from "../src/evals.ts"
import { Engine } from "../src/engine.ts"
import { loadSession } from "../src/fold.ts"
import { kindOf, OI, readMetadata, stringAttr } from "../src/format.ts"
import { scriptedModel } from "../src/model.ts"
import { fillTemplate, parseVerdict } from "../src/judge.ts"
import type { Detector, SteeringInput, SteeringVerdict } from "../src/steering.ts"
import { builtinTools } from "../src/tools.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const say = (value: string): Json => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn" })

const PNPM: SteeringVerdict = {
  durable: true,
  confidence: 0.9,
  statement: "Use pnpm, not npm, in this project.",
  covered_by: null,
  evaluator: {
    name: "use_pnpm",
    description: "Commands use pnpm rather than npm.",
    kind: "code",
    pattern: String.raw`\bnpm (install|i|run|ci)\b`,
    target: "tool_input",
  },
}

/** An engine whose steering detector answers `verdict` (or throws), recording what it was given. */
const setup = (verdict: SteeringVerdict | undefined | Error) => {
  const store = tempStore()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-steering-"))
  const seen: Array<SteeringInput> = []

  const detect: Detector = (input) => {
    seen.push(input)

    return verdict instanceof Error ? Promise.reject(verdict) : Promise.resolve(verdict)
  }

  const engine = new Engine({
    store,
    config: loadConfig({ OI_AGENT_CONFIG_DIR: store.home }),
    model: scriptedModel(() => say("ok")),
    approvals: "allow",
    tools: [...builtinTools, createEvalTool],
  })

  attachEvals(engine, {
    store,
    judge: () => Promise.resolve({ label: "pass" }),
    distill: () => Promise.resolve(undefined),
    detect,
  })

  const sessionId = engine.createSession(cwd).id

  const turn = async (text: string): Promise<string> => {
    await engine.submit(sessionId, { text, userId: "tony" })
    await engine.idle(sessionId)

    return loadSession(store, sessionId).head?.trace_id ?? ""
  }

  return { store, cwd, sessionId, seen, turn }
}

describe("learning from steering", () => {
  it("saves a durable correction as an evaluator that links back to the prompt", async () => {
    const { store, cwd, sessionId, turn } = setup(PNPM)
    const traceId = await turn("ugh, npm again? we use pnpm here.")
    const [learned] = loadEvals(cwd)

    expect(learned).toMatchObject({
      name: "use_pnpm",
      kind: "code",
      feedback: true,
      learn: true,
      origin: { kind: "steering", session_id: sessionId, trace_id: traceId },
    })

    // The terminal and Phoenix show it as an annotation on the turn.
    const notes = store.listAnnotations(sessionId).filter((file) => file.annotation.name === "steering")

    expect(notes).toHaveLength(1)
    expect(notes[0]?.target.trace_id).toBe(traceId)
    expect(notes[0]?.annotation.label).toBe("learned")
    expect(notes[0]?.annotation.metadata?.["feedback"]).toBe(false)

    // The detection is an EVALUATOR trace of its own, with the prompt in and the verdict out.
    const detection = store
      .listTraceIds(sessionId)
      .flatMap((id) => store.readTrace(sessionId, id).ended)
      .find((span) => span.name === "steering")

    expect(detection === undefined ? undefined : kindOf(detection)).toBe("EVALUATOR")
    expect(detection === undefined ? undefined : readMetadata(detection).evaluates).toBe(traceId)
    expect(detection === undefined ? "" : stringAttr(detection, OI.INPUT_VALUE)).toBe(
      "ugh, npm again? we use pnpm here.",
    )
    expect(detection === undefined ? "" : stringAttr(detection, OI.OUTPUT_VALUE)).toContain('"learned":true')
  })

  it("gives the detector the previous turn and the evaluators that already exist", async () => {
    const { cwd, seen, turn } = setup({ ...PNPM, durable: false })

    saveEval(cwd, {
      name: "ran_tests",
      description: "The turn ran the tests.",
      kind: "llm",
      instructions: "Pass if tests ran.",
      choices: { pass: 1, fail: 0 },
      fail_labels: ["fail"],
      feedback: true,
      learn: true,
    })

    await turn("What installs the dependencies?")
    await turn("no, not like that")

    expect(seen[0]?.previous).toBe("")
    expect(seen[1]?.prompt).toBe("no, not like that")
    expect(seen[1]?.previous).toContain("What installs the dependencies?")
    expect(seen[1]?.existing).toEqual([{ name: "ran_tests", description: "The turn ran the tests." }])
  })

  for (const [label, verdict] of [
    ["is not durable", { ...PNPM, durable: false }],
    ["is not confident enough", { ...PNPM, confidence: 0.5 }],
    ["proposes no evaluator", { ...PNPM, evaluator: null }],
    ["proposes an invalid regular expression", { ...PNPM, evaluator: { ...PNPM.evaluator!, pattern: "(" } }],
    ["gives no usable answer", undefined],
    ["throws", new Error("model down")],
  ] as const) {
    it(`learns nothing when the detector ${label}`, async () => {
      const { store, cwd, sessionId, turn } = setup(verdict)

      await turn("something")

      expect(loadEvals(cwd)).toEqual([])
      expect(store.listAnnotations(sessionId).filter((file) => file.annotation.name === "steering")).toEqual(
        [],
      )
      // The session carries on either way.
      expect(loadSession(store, sessionId).head?.state).toBe("complete")
    })
  }

  it("does not learn what an existing evaluator already checks", async () => {
    const { cwd, turn } = setup({ ...PNPM, covered_by: "pnpm_only" })

    saveEval(cwd, {
      name: "pnpm_only",
      description: "Use pnpm.",
      kind: "code",
      pattern: "npm",
      target: "tool_input",
      match_label: "fail",
      otherwise_label: "pass",
      fail_labels: ["fail"],
      feedback: true,
      learn: true,
    })

    await turn("we use pnpm here")

    expect(loadEvals(cwd).map((entry) => entry.name)).toEqual(["pnpm_only"])
  })

  it("does not replace an evaluator with the same name", async () => {
    const { cwd, turn } = setup(PNPM)

    await turn("we use pnpm here")
    await turn("seriously, pnpm")

    expect(loadEvals(cwd).map((entry) => entry.name)).toEqual(["use_pnpm"])
  })
})

describe("the detector prompt", () => {
  it("takes user text as is, even when it looks like a replacement pattern or a placeholder", () => {
    const values = new Map([
      ["previous", "ran `echo $& $1` and wrote {{prompt}}"],
      ["prompt", "use $$ not $&"],
    ])

    expect(fillTemplate("<p>{{previous}}</p><m>{{prompt}}</m><x>{{missing}}</x>", values)).toBe(
      "<p>ran `echo $& $1` and wrote {{prompt}}</p><m>use $$ not $&</m><x>{{missing}}</x>",
    )
  })
})

describe("reading the detector's reply", () => {
  it("accepts empty strings for fields that do not apply, as models write them", () => {
    // A real reply that a strict schema rejected: target "" is not a target.
    const reply =
      '{"durable": true, "confidence": 0.9, "statement": "Never add comments.", "covered_by": null, "evaluator": {"name": "no_code_comments", "description": "No comments.", "kind": "llm", "pattern": "", "target": "", "instructions": "Pass if the turn adds no comments."}}'

    // Models sometimes fence the JSON or say something first.
    expect(parseVerdict(`Here you go:\n\`\`\`json\n${reply}\n\`\`\``)?.durable).toBe(true)
    expect(parseVerdict(reply)?.evaluator).toEqual({
      name: "no_code_comments",
      description: "No comments.",
      kind: "llm",
      instructions: "Pass if the turn adds no comments.",
    })
  })

  it("rejects what is not a verdict", () => {
    expect(parseVerdict("I think this is durable.")).toBeUndefined()
    expect(parseVerdict('{"durable": "yes"}')).toBeUndefined()
  })
})
