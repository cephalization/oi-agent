import * as fs from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import {
  askDecision,
  clearsThresholds,
  approvalConcerns,
  DEFAULT_DECISION,
  deletesOutside,
  type DecisionSettings,
  mustAsk,
} from "../src/decision.ts"
import { decisionDetector, llmDetector } from "../src/detectors.ts"
import { Engine } from "../src/engine.ts"
import { attachEvals, createEvalTool } from "../src/eval-tool.ts"
import { loadEvals } from "../src/evals.ts"
import { type EndedSpan, kindOf, OI, readMetadata, stringAttr } from "../src/format.ts"
import { scriptedModel } from "../src/model.ts"
import type { Detector, SpanParent, SteeringInput, SteeringVerdict } from "../src/steering.ts"
import { builtinTools } from "../src/tools.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

// --- a fake System One server ---------------------------------------------

interface Fake {
  /** The noul for each question; a missing one is left out of the answer. */
  nouls: Map<string, number>
  status: number
  response?: string
  bodies: Array<string>
}

const fake: Fake = { nouls: new Map(), status: 200, bodies: [] }

const server = createServer((request, response) => {
  const chunks: Array<Buffer> = []

  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    fake.bodies.push(Buffer.concat(chunks).toString("utf8"))

    const answers = Object.fromEntries([...fake.nouls].map(([name, noul]) => [name, { type: "noul", noul }]))

    response.writeHead(fake.status, { "content-type": "application/json" })
    response.end(
      fake.response ??
        (fake.status === 200
          ? JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 50, output_tokens: 4 } })
          : '{"error":"nope"}'),
    )
  })
})

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

// SAFETY: a server listening on a TCP port reports an AddressInfo.
const settings: DecisionSettings = {
  ...DEFAULT_DECISION,
  base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
}

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const answer = (nouls: Record<string, number>, status = 200): void => {
  fake.nouls = new Map(Object.entries(nouls))
  fake.status = status
  delete fake.response
}

const SAFE = { irreversible: 0.01, outside_workspace: 0.02, exposes_secrets: 0.01, requested: 0.97 }

// --- hard rules ------------------------------------------------------------

describe("auto approval rules", () => {
  it.each([
    "rm -rf ~/projects",
    "rm -rf /",
    "cd x && rm -fr ../other",
    "rm -r -f $HOME/x",
    "rm --recursive --force /tmp/x",
  ])("always asks for %s", (command) => {
    expect(deletesOutside(command)).toBe(true)
  })

  it.each(["rm -rf node_modules", "rm -rf ./dist", "rm ~/file.txt", "rm -r ~/dir", "ls -la /"])(
    "leaves %s to the decision model",
    (command) => {
      expect(deletesOutside(command)).toBe(false)
    },
  )

  it("asks for force pushes, sudo and discarding work, whatever the model says", () => {
    expect(mustAsk("bash", { command: "git push --force origin main" }, "/w")).toBe("a force push")
    expect(mustAsk("bash", { command: "git push -f" }, "/w")).toBe("a force push")
    expect(mustAsk("bash", { command: "sudo make install" }, "/w")).toBe("sudo")
    expect(mustAsk("bash", { command: "git reset --hard HEAD~3" }, "/w")).toBe("discarding uncommitted work")
    expect(mustAsk("bash", { command: "git push origin feature" }, "/w")).toBeUndefined()
  })

  it("asks for writes outside the working directory", () => {
    expect(mustAsk("write_file", { path: "src/a.ts", content: "" }, "/w")).toBeUndefined()
    expect(mustAsk("write_file", { path: "/w/src/a.ts", content: "" }, "/w")).toBeUndefined()
    expect(mustAsk("edit_file", { path: "../other/a.ts" }, "/w")).toBe(
      "a write outside the working directory",
    )
    expect(mustAsk("write_file", { path: "/etc/hosts", content: "" }, "/w")).toBeDefined()
    expect(mustAsk("write_file", { path: "/wx/a", content: "" }, "/w")).toBeDefined()
  })

  it("asks for writes through a symlink outside the working directory", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-auto-path-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "oi-auto-outside-"))

    try {
      fs.symlinkSync(outside, path.join(cwd, "link"))
      expect(mustAsk("write_file", { path: "link/new/nested.txt", content: "" }, cwd)).toBeDefined()
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("explains exactly which probabilities did not clear the thresholds", () => {
    expect(approvalConcerns(new Map(Object.entries(SAFE)))).toEqual([])
    expect(approvalConcerns(new Map(Object.entries({ ...SAFE, irreversible: 0.6, requested: 0.8 })))).toEqual(
      ["irreversible=0.60 (needs < 0.10)", "requested=0.80 (needs > 0.80)"],
    )
  })

  it("explains missing and invalid answers without treating them as safe", () => {
    const answers = new Map(Object.entries({ ...SAFE, irreversible: 2 }))

    answers.delete("exposes_secrets")
    expect(approvalConcerns(answers)).toEqual([
      "irreversible: invalid probability",
      "exposes_secrets: no answer",
    ])
  })

  it("allows only when every answer clears its threshold", () => {
    expect(clearsThresholds(new Map(Object.entries(SAFE)))).toBe(true)
    expect(clearsThresholds(new Map(Object.entries({ ...SAFE, irreversible: -1 })))).toBe(false)
    expect(clearsThresholds(new Map(Object.entries({ ...SAFE, requested: 2 })))).toBe(false)
    expect(clearsThresholds(new Map(Object.entries({ ...SAFE, requested: Number.NaN })))).toBe(false)
    expect(clearsThresholds(new Map(Object.entries({ ...SAFE, irreversible: 0.2 })))).toBe(false)
    expect(clearsThresholds(new Map(Object.entries({ ...SAFE, requested: 0.5 })))).toBe(false)

    const missing = new Map(Object.entries(SAFE))

    missing.delete("exposes_secrets")
    expect(clearsThresholds(missing)).toBe(false)
  })
})

// --- the client ------------------------------------------------------------

describe("askDecision", () => {
  const question = new Map([
    ["q", { type: "noul" as const, instructions: "?", criteria: { true: "y", false: "n" } }],
  ])

  it("returns the answers, the model and the exact bodies", async () => {
    answer({ q: 0.3 })

    const call = await askDecision(settings, "key", "approval", { a: 1 }, question)

    expect(call.error).toBeUndefined()
    expect(call.model).toBe("jev-test")
    expect(call.nouls.get("q")).toBe(0.3)
    expect(call.input_tokens).toBe(50)
    expect(JSON.parse(call.request)).toMatchObject({ model: "jev-latest", state: { a: 1 } })
    expect(call.response).toContain("jev-test")
  })

  it.each([-0.1, 1.1])("rejects out-of-range probability %s", async (q) => {
    answer({ q })

    const call = await askDecision(settings, "key", "approval", {}, question)

    expect(call.error).toContain("System One shape")
    expect(call.nouls.size).toBe(0)
  })

  it("rejects an answer with the wrong type", async () => {
    answer({})
    fake.response = JSON.stringify({ model: "jev-test", answers: { q: { type: "score", noul: 0.01 } } })

    expect((await askDecision(settings, "key", "approval", {}, question)).error).toBeDefined()
  })

  it("scrubs secrets from the state and the recorded response", async () => {
    answer({})
    fake.response = '{"error":"decision-test-secret-key"}'

    const call = await askDecision(
      settings,
      "decision-test-secret-key",
      "approval",
      {
        secret: "decision-test-secret-key",
      },
      question,
    )

    expect(fake.bodies.at(-1)).not.toContain("decision-test-secret-key")
    expect(call.request).toContain("[redacted]")
    expect(call.response).toContain("[redacted]")
  })

  it("reports a failure instead of throwing", async () => {
    answer({}, 500)
    expect((await askDecision(settings, "key", "approval", {}, question)).error).toContain("HTTP 500")

    const nowhere = { ...settings, base_url: "http://127.0.0.1:1" }

    expect((await askDecision(nowhere, "key", "approval", {}, question)).error).toBeDefined()
  })
})

// --- auto mode in the engine -------------------------------------------------

const bash = (command: string): Json => ({
  content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command } }],
  stop_reason: "tool_use",
})

const say = (value: string): Json => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn" })

/** An engine in auto mode whose model runs one bash command; a human, if asked, says `human`. */
const autoEngine = (command: string, human: "allow" | "deny", decider = true) => {
  const store = tempStore()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-auto-"))
  const asked: Array<string> = []

  const engine = new Engine({
    store,
    config: loadConfig({ OI_AGENT_CONFIG_DIR: store.home }),
    model: scriptedModel((_call, step) => (step === 0 ? bash(command) : say("done"))),
    approvals: "auto",
    decider: decider ? { settings, apiKey: "test-key" } : undefined,
  })

  engine.onApproval((request) => {
    asked.push(request.tool)
    engine.resolveApproval(request.span_id, human)
  })

  const sessionId = engine.createSession(cwd).id

  const run = async () => {
    await engine.submit(sessionId, { text: "print hello", userId: "tony" })

    const [traceId] = store.listTraceIds(sessionId)
    const spans = store.readTrace(sessionId, traceId ?? "").ended
    const tool = spans.find((span) => kindOf(span) === "TOOL")
    const decisions = spans.filter((span) => kindOf(span) === "DECISION")

    return { tool, decisions, asked, approval: tool === undefined ? undefined : readMetadata(tool).approval }
  }

  return { run }
}

describe("auto approvals", () => {
  it("runs a call the decision model is sure of, and records the decision under the tool call", async () => {
    answer(SAFE)

    const { tool, decisions, asked, approval } = await autoEngine("echo hello", "deny").run()

    expect(asked).toEqual([])
    expect(approval).toMatchObject({ decision: "allow", by: "auto:jev-test", answers: SAFE })
    expect(stringAttr(tool!, OI.OUTPUT_VALUE)).toContain("hello")
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.parent_id).toBe(tool?.context.span_id)
    expect(decisions[0]?.attributes["decision.model_name"]).toBe("jev-test")
    expect(decisions[0]?.attributes["decision.token_count.input"]).toBe(50)
    expect(readMetadata(decisions[0]!).purpose).toBe("approval")
    expect(Object.keys(decisions[0]!.attributes).some((key) => key.startsWith("llm."))).toBe(false)
    // The key goes in the header, never into the request body or a span.
    expect(JSON.stringify(decisions)).not.toContain("test-key")
  })

  it("asks a human when the model is not sure, and keeps its answers", async () => {
    answer({ ...SAFE, irreversible: 0.6 })

    const { asked, approval } = await autoEngine("echo hello", "deny").run()

    expect(asked).toEqual(["bash"])
    expect(approval).toMatchObject({
      decision: "deny",
      asked_because: expect.stringContaining("not confident"),
    })
    expect(approval?.answers?.["irreversible"]).toBe(0.6)
  })

  it("asks a human for a hard-rule command without calling the decision model", async () => {
    answer(SAFE)

    const before = fake.bodies.length
    const { asked, decisions, approval } = await autoEngine("rm -rf ~/oi-nothing-here", "deny").run()

    expect(asked).toEqual(["bash"])
    expect(decisions).toEqual([])
    expect(fake.bodies.length).toBe(before)
    expect(approval?.asked_because).toContain("always asked")
  })

  it("asks a human when the decision call fails, or there is no decision model", async () => {
    answer({}, 503)

    const failed = await autoEngine("echo hello", "allow").run()

    expect(failed.asked).toEqual(["bash"])
    expect(failed.decisions[0]?.status_code).toBe("ERROR")
    expect(failed.approval?.asked_because).toContain("failed")

    const none = await autoEngine("echo hello", "allow", false).run()

    expect(none.asked).toEqual(["bash"])
    expect(none.decisions).toEqual([])
  })
})

// --- steering detectors -----------------------------------------------------

const INPUT: SteeringInput = { prompt: "we use pnpm here", previous: "", existing: [] }

const PNPM: SteeringVerdict = {
  durable: true,
  confidence: 0.6,
  statement: "Use pnpm.",
  evaluator: {
    name: "use_pnpm",
    description: "Use pnpm.",
    kind: "code",
    pattern: String.raw`\bnpm install\b`,
    target: "tool_input",
  },
}

const recorder = () => {
  const spans: Array<EndedSpan> = []
  const parent: SpanParent = { sessionId: "s", traceId: "t", spanId: "p" }

  return {
    spans,
    report: {
      usage: () => undefined,
      span: (build: (parent: SpanParent) => EndedSpan) => spans.push(build(parent)),
    },
  }
}

describe("decision detector", () => {
  const writer =
    (calls: Array<SteeringInput>): Detector =>
    (input) => {
      calls.push(input)

      return Promise.resolve(PNPM)
    }

  it("does not call the writer when the screen says one-off", async () => {
    answer({ durable: 0.1 })

    const calls: Array<SteeringInput> = []
    const { spans, report } = recorder()
    const verdict = await decisionDetector(settings, "k", writer(calls))(INPUT, report)

    expect(calls).toEqual([])
    expect(verdict).toMatchObject({ durable: false, confidence: 0.9 })
    expect(spans.map(kindOf)).toEqual(["DECISION"])
    expect(readMetadata(spans[0]!).purpose).toBe("steering")
  })

  it("writes the evaluator when the screen is confident, keeping the calibrated confidence", async () => {
    answer({ durable: 0.92 })

    const calls: Array<SteeringInput> = []
    const verdict = await decisionDetector(settings, "k", writer(calls))(INPUT, recorder().report)

    expect(calls).toHaveLength(1)
    expect(verdict).toMatchObject({ durable: true, confidence: 0.92, evaluator: { name: "use_pnpm" } })
  })

  it("lets the writer decide alone when the decision call fails", async () => {
    answer({}, 500)

    const calls: Array<SteeringInput> = []
    const verdict = await decisionDetector(settings, "k", writer(calls))(INPUT, recorder().report)

    expect(calls).toHaveLength(1)
    expect(verdict?.confidence).toBe(0.6)
  })
})

describe("llm detector", () => {
  it("runs the detector prompt on any model and records the call with its exact bodies", async () => {
    const reply = JSON.stringify({ ...PNPM, confidence: 0.95 })
    const { spans, report } = recorder()
    const verdict = await llmDetector(scriptedModel(() => say(reply)))(INPUT, report)

    expect(verdict).toMatchObject({ durable: true, confidence: 0.95 })
    expect(spans.map(kindOf)).toEqual(["LLM"])
    expect(stringAttr(spans[0]!, OI.INPUT_VALUE)).toContain("we use pnpm here")
    expect(stringAttr(spans[0]!, OI.OUTPUT_VALUE)).toContain("use_pnpm")
    expect(readMetadata(spans[0]!).provider).toBe("scripted")
  })

  it("learns through the engine like any detector", async () => {
    const store = tempStore()
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-llmdetector-"))

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
      detect: llmDetector(scriptedModel(() => say(JSON.stringify({ ...PNPM, confidence: 0.95 })))),
    })

    const sessionId = engine.createSession(cwd).id

    await engine.submit(sessionId, { text: "we use pnpm here", userId: "tony" })
    await engine.idle(sessionId)

    expect(loadEvals(cwd).map((definition) => definition.name)).toEqual(["use_pnpm"])
  })
})
