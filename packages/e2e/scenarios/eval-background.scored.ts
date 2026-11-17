/** Live evaluation lifecycle over span fixtures, without launching real test processes. */
import * as path from "node:path"
import { expect, vi } from "vite-plus/test"
import { runEvals, saveEval, type Judge } from "../../engine/src/evals.ts"
import { phoenixJudge } from "../../engine/src/judge.ts"
import { getSecret } from "../../engine/src/secrets.ts"
import { Store } from "../../engine/src/store.ts"
import { readOnlyCriterion } from "../../engine/test/fixtures/eval-attribution.ts"
import { BackgroundFixture, outcomeCheck } from "../../engine/test/fixtures/eval-background.ts"
import { positiveInteger } from "../src/samples.ts"
import { MODELS, scenario } from "../src/scenario.ts"

scenario(
  "opt-in background evaluations wait for outcomes and recover from spans",
  {
    model: MODELS.anthropic,
    liveOnly: true,
  },
  async (s) => {
    const key = getSecret("anthropic")

    if (key === undefined) throw new Error("Anthropic credentials required")

    // These calls run in-process rather than the CLI. Keep evaluator definitions isolated too.
    vi.stubEnv("OI_AGENT_CONFIG_DIR", s.sandbox.configDir)

    try {
      const cases = [
        {
          name: "job-success",
          kinds: ["job"] as const,
          results: ["pnpm test completed: exit code 0; 42 passed."],
          expected: "pass",
          wait: true,
          observed: false,
        },
        {
          name: "task-failure",
          kinds: ["task"] as const,
          results: ["pnpm test completed: exit code 1; 3 failed."],
          expected: "fail",
          wait: true,
          observed: false,
        },
        {
          name: "partial-then-success",
          kinds: ["job", "task"] as const,
          results: [
            "First pnpm test completed: exit code 0; 42 passed.",
            "Second pnpm test completed: exit code 0; 7 passed.",
          ],
          expected: "pass",
          wait: true,
          observed: false,
        },
        {
          name: "canceled-job",
          kinds: ["job"] as const,
          results: ["pnpm test was canceled before completion; no successful result."],
          expected: "fail",
          wait: true,
          observed: false,
        },
        {
          name: "launch-prohibition-immediate",
          kinds: ["task"] as const,
          results: [],
          expected: "fail",
          wait: false,
          observed: false,
        },
        {
          name: "polled-job-success",
          kinds: ["job"] as const,
          results: ["pnpm test exited with code 0: 42 passed."],
          expected: "pass",
          wait: true,
          observed: true,
        },
        {
          name: "polled-job-cancellation",
          kinds: ["job"] as const,
          results: ["pnpm test killed after 1s: canceled before completion."],
          expected: "fail",
          wait: true,
          observed: true,
        },
        {
          name: "followup-runner-success",
          kinds: ["followup"] as const,
          results: ["Follow-up pnpm test exited with code 0: 42 passed."],
          expected: "pass",
          wait: true,
          observed: false,
        },
      ]

      for (let sample = 0; sample < positiveInteger("OI_E2E_SAMPLES", 3); sample += 1) {
        for (const entry of cases) {
          const store = new Store(path.join(s.sandbox.home, `${sample}-${entry.name}`))
          const fixture = new BackgroundFixture(store, store.home)
          saveEval(
            store.home,
            entry.wait
              ? {
                  ...outcomeCheck,
                  applicability: { any: ["tool:bash", "tool:delegate", "tool:task_message"] },
                }
              : readOnlyCriterion,
          )
          let calls = 0

          const judge: Judge = (definition, record, report) => {
            calls += 1

            return phoenixJudge(key)(definition, record, report)
          }

          const runtime = { store, judge, distill: async () => undefined }

          const launch = fixture.turn({
            launches: entry.kinds,
            input: entry.wait ? "Run tests and verify success." : "Read-only review: do not run tests.",
          })

          let verdict = (await runEvals(runtime, fixture.sessionId, launch.traceId))[0]
          const initialLabel = verdict?.annotation.label
          const initialCalls = calls
          expect(initialLabel).toBe(entry.wait ? "pending" : "fail")
          expect(initialCalls).toBe(entry.wait ? 0 : 1)

          for (const [index, result] of entry.results.entries()) {
            const delivered = fixture.turn({
              deliveries: entry.observed ? [] : launch.deliveries.slice(index, index + 1),
              observed: entry.observed ? launch.deliveries.slice(index, index + 1) : [],
              observationTool: entry.name === "polled-job-success" ? "job_status" : "job_kill",
              input: entry.observed ? "Inspect the background result." : result,
              output: entry.observed ? result : "Reporting the completed background result.",
            })

            const results = await runEvals(
              { ...runtime, store: new Store(store.home) },
              fixture.sessionId,
              delivered.traceId,
            )

            // A waiting check's result is the one that names its launch turn; the turn's own verdict comes after it.
            const settled = entry.wait
              ? results.find((result) => result.annotation.metadata?.["deferred_from"] !== undefined)
              : results[0]

            if (index < entry.results.length - 1) {
              // Still waiting: recorded once, on the launch turn, and not judged.
              expect(settled).toBeUndefined()
              expect(calls).toBe(0)
            } else {
              verdict = settled
            }
          }

          s.results([
            {
              case: entry.name,
              sample,
              expected: entry.expected,
              actual: verdict?.annotation.label ?? "missing",
              initialLabel: initialLabel ?? "missing",
              initialCalls,
              calls,
              explanation: verdict?.annotation.explanation ?? "",
            },
          ])
          expect(verdict?.annotation.label).toBe(entry.expected)
          expect(calls).toBe(1)
        }
      }

      s.note(
        `background outcomes: ${cases.length * positiveInteger("OI_E2E_SAMPLES", 3)} matched; pending launch checks made no judge calls`,
      )
    } finally {
      vi.unstubAllEnvs()
    }
  },
)
