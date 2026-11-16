import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { attachEvals, createEvalTool } from "../src/eval-tool.ts"
import {
  definitionFrom,
  type EvalDefinition,
  type LlmEval,
  loadEvals,
  saveEval,
  type TurnRecord,
} from "../src/evals.ts"
import { Engine } from "../src/engine.ts"
import { kindOf, readMetadata } from "../src/format.ts"
import { scriptedModel } from "../src/model.ts"
import { readRules } from "../src/rules.ts"
import { builtinTools } from "../src/tools.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const say = (value: string): Json => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn" })

const call = (name: string, input: Json): Json => ({
  content: [{ type: "tool_use", id: `toolu_${name}_${Math.random()}`, name, input }],
  stop_reason: "tool_use",
})

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })

const COMMIT = "git -c user.name=Test -c user.email=test@example.com commit -qam"

/** One scripted tool call per turn (or none), then an answer. */
const setup = (options: { git: boolean; verdicts?: Array<string> }) => {
  const store = tempStore()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-applicability-"))
  const judged: Array<{ definition: LlmEval; record: TurnRecord }> = []
  const verdicts = [...(options.verdicts ?? [])]

  if (options.git) {
    git(cwd, "init", "-q")
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\n")
    git(cwd, "add", "a.txt")
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init")
  }

  // The next turn's tool call, consumed by its first model call.
  let pending: Json | undefined

  const engine = new Engine({
    store,
    config: loadConfig({ OI_AGENT_CONFIG_DIR: store.home }),
    model: scriptedModel(() => {
      const next = pending ?? say("Done.")

      pending = undefined

      return next
    }),
    approvals: "allow",
    tools: [...builtinTools, createEvalTool],
  })

  attachEvals(engine, {
    store,
    judge: (definition, record) => {
      judged.push({ definition, record })

      const label = verdicts.shift() ?? "pass"

      return Promise.resolve({ label, explanation: `judged ${label}` })
    },
    distill: () => Promise.resolve("Open a PR after every commit."),
  })

  const sessionId = engine.createSession(cwd).id

  const turn = async (text: string, tool?: Json) => {
    pending = tool
    await engine.submit(sessionId, { text, userId: "tony" })
    await engine.idle(sessionId)

    return store
      .listAnnotations(sessionId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .at(-1)
  }

  return { store, cwd, sessionId, judged, turn }
}

const prCheck = (applicability: EvalDefinition["applicability"]): EvalDefinition => {
  const definition: EvalDefinition = {
    name: "pr_after_commit",
    description: "Committed changes get a PR.",
    kind: "llm",
    instructions: "Pass if committed changes have a PR or PR creation is reported blocked.",
    choices: { pass: 1, fail: 0 },
    fail_labels: ["fail"],
    feedback: true,
    learn: true,
  }

  return applicability === undefined ? definition : { ...definition, applicability }
}

const evidenceOf = (store: ReturnType<typeof tempStore>, sessionId: string) =>
  store
    .listTraceIds(sessionId)
    .flatMap((traceId) => store.readTrace(sessionId, traceId).ended)
    .filter((span) => kindOf(span) === "TOOL")
    .map((span) => readMetadata(span).evidence)

describe("evaluator applicability", () => {
  it("skips a commit check on a read-only turn without calling the judge, feedback or learning", async () => {
    const { cwd, judged, turn, store, sessionId } = setup({ git: true, verdicts: ["fail"] })

    saveEval(cwd, prCheck({ any: ["commit"] }))

    const result = await turn("which issue is next?", call("bash", { command: "git log --oneline" }))

    expect(judged).toHaveLength(0)
    expect(result?.annotation).toMatchObject({
      name: "pr_after_commit",
      label: "skipped",
      metadata: { failed: false, feedback: false, skipped: true },
    })
    expect(JSON.stringify(result?.annotation.metadata?.["applicability"])).toContain(
      String.raw`\"commit\":\"no\"`,
    )
    expect(readRules(cwd)).toBe("")
    expect(evidenceOf(store, sessionId)).toEqual([{ writes: "no", commit: "no" }])
  })

  it("triggers on a bash commit of changes written in an earlier turn", async () => {
    const { cwd, judged, turn, store, sessionId } = setup({ git: true })

    saveEval(cwd, prCheck({ any: ["commit"] }))

    const write = await turn("edit a.txt", call("write_file", { path: "a.txt", content: "two\n" }))

    expect(write?.annotation.label).toBe("skipped")

    const commit = await turn("commit it", call("bash", { command: `${COMMIT} 'feat: two'` }))

    expect(judged).toHaveLength(1)
    expect(commit?.annotation.label).toBe("pass")
    expect(evidenceOf(store, sessionId)).toEqual([
      { writes: "yes", commit: "no" },
      { writes: "no", commit: "yes" },
    ])
  })

  it("treats a failed commit and a no-op write as no activity", async () => {
    const { cwd, judged, turn, store, sessionId } = setup({ git: true })

    saveEval(cwd, prCheck({ any: ["commit", "writes"] }))

    expect((await turn("commit", call("bash", { command: `${COMMIT} 'nothing'` })))?.annotation.label).toBe(
      "skipped",
    )
    expect(
      (await turn("rewrite", call("write_file", { path: "a.txt", content: "one\n" })))?.annotation.label,
    ).toBe("skipped")
    expect(judged).toHaveLength(0)
    expect(evidenceOf(store, sessionId)).toEqual([
      { writes: "no", commit: "no" },
      { writes: "no", commit: "no" },
    ])
  })

  it("requires every predicate in all", async () => {
    const { cwd, judged, turn } = setup({ git: true })

    saveEval(cwd, prCheck({ any: [], all: ["writes", "tool:bash"] }))

    await turn("edit", call("write_file", { path: "a.txt", content: "three\n" }))
    expect(judged).toHaveLength(0)
    await turn("edit with bash", call("bash", { command: "printf four > a.txt" }))
    expect(judged).toHaveLength(1)
  })

  it("runs the check when evidence is unknown, and legacy checks every turn", async () => {
    const { cwd, judged, turn } = setup({ git: false })

    saveEval(cwd, prCheck({ any: ["commit"] }))
    await turn("commit outside git", call("bash", { command: "true" }))
    expect(judged).toHaveLength(1)
    expect(String(judged[0]?.record.activity?.get("commit"))).toBe("unknown")

    saveEval(cwd, prCheck(undefined))
    await turn("just talk")
    expect(judged).toHaveLength(2)
  })

  it("rechecks a failed obligation on a corrective turn that makes no new commit", async () => {
    const { cwd, judged, turn } = setup({ git: true, verdicts: ["fail", "pass"] })

    saveEval(cwd, prCheck({ any: ["commit"] }))
    fs.writeFileSync(path.join(cwd, "a.txt"), "five\n")

    const failure = await turn("commit", call("bash", { command: `${COMMIT} 'feat: five'` }))

    expect(failure?.annotation.label).toBe("fail")

    const fixed = await turn("open the PR", call("bash", { command: "echo opened pull request 7" }))

    expect(judged).toHaveLength(2)
    expect(judged[1]?.record.judged).toContain("[failing turn]")
    expect(judged[1]?.record.judged).toContain("feat: five")
    expect(judged[1]?.definition.instructions).toContain("This is a recheck")
    expect(fixed?.annotation).toMatchObject({ label: "pass", metadata: { rechecks: failure?.id } })

    // Resolved: the next unrelated turn is skipped again.
    expect((await turn("thanks"))?.annotation.label).toBe("skipped")
    expect(judged).toHaveLength(2)
  })

  it("persists applicability from create_eval and rejects unknown predicates", () => {
    const base = { name: "x", description: "x", kind: "code" as const, pattern: "x" }

    expect(definitionFrom({ ...base, applicability: { any: ["pushed"] } })).toContain("Unknown applicability")

    const definition = definitionFrom({ ...base, applicability: { any: ["commit", "tool:bash"] } })

    expect(definition).toMatchObject({ applicability: { any: ["commit", "tool:bash"] } })

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-applicability-"))

    saveEval(cwd, prCheck({ any: ["commit", "tool:bash"] }))
    expect(loadEvals(cwd)[0]?.applicability).toEqual({ any: ["commit", "tool:bash"] })
  })
})
