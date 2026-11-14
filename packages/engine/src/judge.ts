/**
 * The default judge and rule distiller, backed by `@arizeai/phoenix-evals`
 * and a small, cheap model. Every model call is reported back to the engine
 * so evaluator cost shows up next to agent cost.
 */
import { createAnthropic } from "@ai-sdk/anthropic"
import { createClassificationEvaluator } from "@arizeai/phoenix-evals"
import { generateText, type LanguageModel, wrapLanguageModel } from "ai"
import { Option, Schema } from "effect"
import type { Distiller, Judge, UsageReporter } from "./evals.ts"
import { parser } from "./format.ts"
import { type Detector, looseVerdict, type SteeringInput, SteeringVerdict } from "./steering.ts"
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

/** What counts as a durable correction, shared by every detector so they judge the same thing. */
export const DURABLE_MEANS = `Durable: corrections of a habit or style of the agent's; the project's conventions, tools or commands; how the user wants answers or work done; things to always or never do. A complaint about something the agent did counts when the same thing could come up again in a different task. It does not need words like "always".`

export const NOT_DURABLE_MEANS = `Not durable: choices that only concern the current change (a particular name, wording or value, a one-time edit), questions, requests for new work, approval and thanks. Asking to redo the latest answer or change differently (more or less of something, another tone, another form) is about that answer only, unless the user signals it applies beyond it: that it keeps happening, or that it is how they always want things.`

const DETECTOR_PROMPT = `You watch a user steer a coding agent. Decide whether the user's latest message corrects the agent, or states a preference, in a way that should apply to the agent's future work in this project, and not only to the current task.

{{durable}}
{{not_durable}}

The agent's previous turn, for context:
<previous_turn>
{{previous}}
</previous_turn>

The user's latest message:
<message>
{{prompt}}
</message>

Evaluators that already exist in this project (name: description):
<evaluators>
{{existing}}
</evaluators>

If an existing evaluator already checks the same thing, set covered_by to its name.

If the message is durable, propose an evaluator that reviews each later turn and fails when the agent goes against the correction:
- kind "code", with a JavaScript regular expression "pattern" that matches a violation, and a "target": "tool_input" for commands the agent runs and edits it makes, "output" for its replies. Use it only when the pattern cannot match work that follows the correction.
- otherwise kind "llm", with "instructions": the criterion a judge applies to one turn, phrased so that meeting it passes. Say that turns where it does not apply pass.
Give it a short snake_case "name" and a one-sentence "description".

Reply with JSON only, no prose:
{"durable": true or false, "confidence": a number from 0 to 1, "statement": "the preference as one imperative sentence", "covered_by": a name or null, "evaluator": {"name": "...", "description": "...", "kind": "code" or "llm", "pattern": "...", "target": "...", "instructions": "..."} or null}`

/**
 * Fill `{{key}}` placeholders in one pass, with a function: text from the
 * user can hold `$&` or a placeholder of its own, and must come through as is.
 */
export const fillTemplate = (template: string, values: ReadonlyMap<string, string>): string =>
  template.replaceAll(/\{\{(\w+)\}\}/g, (whole, key: string) => values.get(key) ?? whole)

/** The first JSON object in a reply, which models sometimes wrap in a code fence. */
const jsonIn = (text: string): string => text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)

const parseJson = parser(Schema.Json)
const decodeVerdict = Schema.decodeUnknownOption(SteeringVerdict)

/** A verdict from a reply, forgiving `""` for fields that do not apply. */
export const parseVerdict = (text: string): SteeringVerdict | undefined => {
  const json = parseJson(jsonIn(text))

  return json === undefined ? undefined : Option.getOrUndefined(decodeVerdict(looseVerdict(json)))
}

/** The detector's prompt for one input. */
export const detectorPrompt = (input: SteeringInput): string => {
  const existing = input.existing.map((entry) => `${entry.name}: ${entry.description}`).join("\n")

  const values = new Map([
    ["durable", DURABLE_MEANS],
    ["not_durable", NOT_DURABLE_MEANS],
    ["previous", input.previous === "" ? "(none)" : input.previous],
    ["existing", existing === "" ? "(none)" : existing],
    ["prompt", input.prompt],
  ])

  return fillTemplate(DETECTOR_PROMPT, values)
}

export const modelDetector =
  (apiKey: string, model: string = DEFAULT_JUDGE_MODEL): Detector =>
  async (input, report) => {
    const { text } = await generateText({
      model: metered(apiKey, model, report.usage),
      prompt: detectorPrompt(input),
    })

    return parseVerdict(text)
  }
