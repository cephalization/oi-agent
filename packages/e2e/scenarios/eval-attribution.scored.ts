/** Live judge regression over bounded span evidence, not a generated agent trajectory. */
import { expect } from "vite-plus/test"
import { phoenixJudge } from "../../engine/src/judge.ts"
import { getSecret } from "../../engine/src/secrets.ts"
import { Store } from "../../engine/src/store.ts"
import { attributionExamples, readOnlyCriterion } from "../../engine/test/fixtures/eval-attribution.ts"
import { positiveInteger } from "../src/samples.ts"
import { MODELS, scenario } from "../src/scenario.ts"

scenario(
  "async evaluator attributes launches rather than reports",
  {
    model: MODELS.anthropic,
    liveOnly: true,
    samples: true,
  },
  async (s) => {
    const key = getSecret("anthropic")

    if (key === undefined) throw new Error("Anthropic credentials required")

    const rows = await s.samples(
      Array.from({ length: positiveInteger("OI_E2E_SAMPLES", 3) }, (_, sample) => sample),
      async (child, sample) => {
        const store = new Store(child.sandbox.home)
        const examples = attributionExamples(store, child.sandbox.root)
        const results = []

        for (const entry of examples) {
          const verdict = await phoenixJudge(key)(readOnlyCriterion, entry.record, () => {})

          const row = {
            case: entry.name,
            sample,
            expected: entry.expected,
            actual: verdict.label,
            explanation: verdict.explanation ?? "",
          }

          results.push(row)
          s.results([row])
        }

        return results
      },
    )

    const results = rows.flat()
    const hits = results.filter((row) => row.expected === row.actual).length

    s.note(`attribution: ${hits}/${results.length}`)
    expect(hits).toBe(results.length)
  },
)
