/**
 * Learning from steering (issue #10): what the detector must and must not
 * learn, on single cases with a certain answer. The scored experiment over
 * every case is `steering.scored.ts` (`pnpm e2e:scored`).
 */
import { kindOf, parser, SteeringVerdict, stringAttr, OI } from "@oi-agent/engine"
import { Schema } from "effect"
import { describe, expect } from "vite-plus/test"
import { MODELS, scenario } from "../src/scenario.ts"
import { DURABLE, IMPLICIT, learned, PRODUCT_BUGS } from "../src/steering.ts"

describe("learning from steering", () => {
  scenario(
    "product bug reports do not become standing preferences for the coding agent",
    {
      needs: ["second-model"],
      config: new Map([
        ["steering", "auto"],
        ["steering_model", MODELS.second],
      ]),
    },
    async (s) => {
      for (const entry of PRODUCT_BUGS) {
        const created = await learned(s, entry)
        const session = s.spans.sessions().at(-1) ?? ""

        const detection = s.spans
          .ended(session)
          .filter((span) => span.name === "steering" && span.parent_id === null)
          .at(-1)

        // Read the detector, not just the whole-system outcome: the agent may independently create checks.
        const output = detection === undefined ? "" : (stringAttr(detection, OI.OUTPUT_VALUE) ?? "")

        const verdict = parser(Schema.Struct({ verdict: SteeringVerdict }))(output)?.verdict

        expect(verdict).toBeDefined()
        expect(verdict?.durable).toBe(false)
        expect(verdict?.evaluator ?? null).toBeNull()
        expect(created.filter((entry) => entry.producer === "detector")).toEqual([])
        s.note(`not learned: ${entry.steer}`)
      }

      // The exclusion must not suppress an actual preference about the agent's working style.
      const created = await learned(s, IMPLICIT[2]!)
      const session = s.spans.sessions().at(-1) ?? ""

      const detection = s.spans
        .ended(session)
        .filter((span) => span.name === "steering" && span.parent_id === null)
        .at(-1)

      const output = detection === undefined ? "" : (stringAttr(detection, OI.OUTPUT_VALUE) ?? "")
      const verdict = parser(Schema.Struct({ verdict: SteeringVerdict }))(output)?.verdict

      expect(verdict?.durable).toBe(true)
      expect(created.length).toBeGreaterThan(0)
      s.note("genuine preference about concise answers: learned")
    },
  )

  scenario(
    "runs on the configured steering model, with no Anthropic key",
    {
      config: new Map([
        ["steering", "auto"],
        ["steering_model", MODELS.main],
      ]),
      // An empty variable hides a key in the keychain too.
      env: new Map([["ANTHROPIC_API_KEY", ""]]),
    },
    async (s) => {
      const created = await learned(s, DURABLE[0]!)
      const session = s.spans.sessions().at(-1) ?? ""

      const detections = s.spans
        .ended(session)
        .filter((span) => span.parent_id === null && span.name === "steering" && kindOf(span) === "EVALUATOR")

      expect(detections).toHaveLength(2)

      // Each detection called the configured model, recorded under it with its exact bodies.
      for (const detection of detections) {
        const calls = s.spans
          .trace(session, detection.context.trace_id)
          .filter((span) => kindOf(span) === "LLM" && span.parent_id === detection.context.span_id)

        expect(calls.map((call) => s.spans.modelOf(call).model)).toEqual([MODELS.main])
      }

      // The correction was learned. By whom varies: the agent often writes the evaluator itself with
      // create_eval, and the detector then adds nothing; sometimes a second, unrelated one appears too.
      expect(created.length).toBeGreaterThanOrEqual(1)
    },
  )
})
