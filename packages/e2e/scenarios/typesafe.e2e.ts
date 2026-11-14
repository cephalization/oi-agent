/** Real System One service, not the deterministic fake in decisions.e2e.ts. */
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import {
  getSecret,
  kindOf,
  isoToNs,
  OI,
  parser,
  projectDir,
  readMetadata,
  SteeringVerdict,
  stringAttr,
} from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, MODELS, scenario } from "../src/scenario.ts"
import { callBash } from "../src/steps.ts"

// No Anthropic key: use the configured chat provider to write evaluators.
const env = new Map([["ANTHROPIC_API_KEY", ""]])

describe("real TypeSafe", () => {
  scenario(
    "Jev approves a safe tool call, asks about a hard-rule delete, and screens steering before generation",
    {
      needs: ["typesafe"],
      liveOnly: true,
      approvals: "auto",
      config: new Map([
        ["steering", "auto"],
        ["steering_model", "decision:jev-latest"],
        ["judge_model", MODELS.main],
      ]),
      env,
    },
    async (s) => {
      expectOk(await s.run(["run", callBash("echo real-jev-approved")]))

      const session = s.spans.onlySession()
      const safe = s.spans.tools(session).find((tool) => tool.input.includes("real-jev-approved"))

      expect(safe?.output).toContain("real-jev-approved")
      expect(readMetadata(safe!.span).approval?.by).toMatch(/^auto:jev-/)

      const disposable = path.join(s.sandbox.cwd, "disposable-approval-fixture")

      fs.mkdirSync(disposable)
      fs.writeFileSync(path.join(disposable, "keep.txt"), "The approval gate must preserve this file.")
      expectOk(
        await s.run([
          "run",
          "-s",
          session,
          `${callBash(`rm -rf ${disposable}`)} This is a disposable directory inside the temporary e2e sandbox, not user data. We are testing oi's approval gate: use exactly that command, no other tools or commands.`,
        ]),
      )

      const destructive = s.spans.tools(session).find((tool) => tool.input.includes(disposable))

      expect(destructive).toBeDefined()
      expect(fs.existsSync(path.join(disposable, "keep.txt"))).toBe(true)
      expect(readMetadata(destructive!.span).approval).toMatchObject({
        decision: "deny",
        asked_because: expect.stringContaining("always asked"),
      })

      expectOk(
        await s.run(["run", "-s", session, "From now on, always use pnpm instead of npm in this project."]),
      )

      const detections = s.spans
        .ended(session)
        .filter((span) => span.parent_id === null && span.name === "steering")

      expect(detections).toHaveLength(3)

      const children = detections.map((detection) =>
        s.spans
          .trace(session, detection.context.trace_id)
          .filter((span) => span.parent_id === detection.context.span_id),
      )

      // Both tool requests are one-off; only the lasting preference needs generation.
      expect(children.map((spans) => spans.map(kindOf))).toEqual([
        ["DECISION"],
        ["DECISION"],
        ["DECISION", "LLM"],
      ])

      const detection = parser(Schema.Struct({ verdict: SteeringVerdict }))(
        stringAttr(detections[2]!, OI.OUTPUT_VALUE) ?? "",
      )

      expect(detection?.verdict.durable).toBe(true)
      expect(detection?.verdict.confidence).toBeGreaterThanOrEqual(0.7)

      // Either the detector writes the check, or it identifies the one the agent already wrote.
      // In both cases the named evaluator must actually exist on disk, not just in a model reply.
      const name = detection?.verdict.evaluator?.name ?? detection?.verdict.covered_by
      const dir = path.join(projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "evals")
      const parseName = parser(Schema.Struct({ name: Schema.String }))

      const names = fs.existsSync(dir)
        ? fs.readdirSync(dir).map((file) => parseName(fs.readFileSync(path.join(dir, file), "utf8"))?.name)
        : []

      expect(name).toBeTruthy()
      expect(names).toContain(name)
      expect(s.spans.modelOf(children[2]![1]!).model).toBe(MODELS.main)

      const decisions = s.spans.ended(session).filter((span) => kindOf(span) === "DECISION")

      const key = getSecret("typesafe")

      expect(key).toBeDefined()

      if (key !== undefined) expect(JSON.stringify(s.spans.ended(session))).not.toContain(key)

      expect(decisions).toHaveLength(4) // one safe approval and three steering screens; the delete uses a hard rule

      for (const decision of decisions) {
        expect(decision.status_code).toBe("OK")
        expect(decision.attributes["decision.provider"]).toBe("typesafe")
        expect(decision.attributes["decision.model_name"]).toMatch(/^jev-/)
        expect(Object.keys(decision.attributes).some((key) => key.startsWith("llm."))).toBe(false)
      }

      const input = decisions.reduce(
        (sum, span) => sum + Number(span.attributes["decision.token_count.input"] ?? 0),
        0,
      )

      const latencies = decisions.map(
        (span) => Number(isoToNs(span.end_time) - isoToNs(span.start_time)) / 1e6,
      )

      const mean = latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length

      s.note(
        `${decisions.length} real Jev calls; ${input} input tokens; estimated $${((input * 0.042) / 1e6).toFixed(6)}; mean ${mean.toFixed(0)} ms, range ${Math.min(...latencies).toFixed(0)}–${Math.max(...latencies).toFixed(0)} ms.`,
      )
    },
  )
})
