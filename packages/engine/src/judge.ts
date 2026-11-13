/**
 * The default judge and rule distiller, backed by `@arizeai/phoenix-evals`
 * and a small, cheap model. Every model call is reported back to the engine
 * so evaluator cost shows up next to agent cost.
 */
import { createAnthropic } from "@ai-sdk/anthropic"
import { createClassificationEvaluator } from "@arizeai/phoenix-evals"
import { generateText, type LanguageModel, wrapLanguageModel } from "ai"
import type { Distiller, Judge, UsageReporter } from "./evals.ts"
import { nowNs } from "./ids.ts"

export const DEFAULT_JUDGE_MODEL = "claude-haiku-5-5"

const JUDGE_TEMPLATE = `You are reviewing one turn of a coding agent's work.

Criterion: {{instructions}}

Facts about the session, measured by the harness:
{{facts}}

The turn:
<turn>
{{transcript}}
</turn>

Judge only whether this turn meets the criterion. If the criterion does not apply to what the turn was about, choose the label that means it was satisfied.`

/** Wrap a model so each call it serves is reported with its token usage. */
const metered = (apiKey: string, modelId: string, report: UsageReporter): LanguageModel =>
  wrapLanguageModel({
    model: createAnthropic({ apiKey })(modelId),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate, params }) => {
        const startNs = nowNs()
        const result = await doGenerate()

        report({
          provider: "anthropic",
          model: result.response?.modelId ?? modelId,
          prompt: JSON.stringify(params.prompt),
          completion: JSON.stringify(result.content),
          input_tokens: result.usage.inputTokens.total ?? 0,
          output_tokens: result.usage.outputTokens.total ?? 0,
          cache_read_tokens: result.usage.inputTokens.cacheRead ?? 0,
          cache_write_tokens: result.usage.inputTokens.cacheWrite ?? 0,
          start_ns: startNs,
          end_ns: nowNs(),
        })

        return result
      },
    },
  })

export const phoenixJudge =
  (apiKey: string, model: string = DEFAULT_JUDGE_MODEL): Judge =>
  async (definition, record, report) => {
    const evaluator = createClassificationEvaluator({
      name: definition.name,
      model: metered(apiKey, model, report),
      choices: { ...definition.choices },
      promptTemplate: JUDGE_TEMPLATE,
    })

    const result = await evaluator.evaluate({
      instructions: definition.instructions,
      transcript: record.transcript,
      facts: record.facts,
    })

    return {
      label: result.label ?? "",
      score: result.score ?? undefined,
      explanation: result.explanation ?? undefined,
    }
  }

const criterionOf = (definition: Parameters<Distiller>[0]): string =>
  definition.kind === "llm" ? definition.instructions : definition.description

export const modelDistiller =
  (apiKey: string, model: string = DEFAULT_JUDGE_MODEL): Distiller =>
  async (definition, verdict, record, existing, report) => {
    const { text } = await generateText({
      model: metered(apiKey, model, report),
      prompt: `A coding agent failed an automated check on one of its turns.

Check: ${definition.name} — ${criterionOf(definition)}
Why it failed: ${verdict.explanation ?? verdict.label}

The turn:
<turn>
${record.transcript}
</turn>

Rules the agent already follows:
<rules>
${existing.trim() === "" ? "(none)" : existing}
</rules>

Write one rule, a single imperative sentence of at most 25 words, that would have prevented this failure and applies to future work in general, not just this task. If an existing rule already covers it, reply with exactly NONE. Reply with the rule text only.`,
    })

    const rule = text.trim()

    return rule === "" || rule.toUpperCase() === "NONE" ? undefined : rule
  }
