/**
 * Steering detectors beyond the default one (`modelDetector` in judge.ts):
 *
 * - `llmDetector`: the same prompt on any configured provider and model, so
 *   learning from corrections does not need an Anthropic key.
 * - `decisionDetector`: a decision model screens every prompt with one
 *   calibrated yes/no question, and a model writes the evaluator only for
 *   prompts the screen marks durable (the "Noul screen" pattern).
 *
 * Each records what it called under the detection's `EVALUATOR` span: an
 * `LLM` span with the exact request and response bodies, or a `DECISION`
 * span.
 */
import { Effect, Exit, Option } from "effect"
import { askDecision, decisionSpan, type DecisionSettings, type Noul } from "./decision.ts"
import type { AttrValue, EndedSpan } from "./format.ts"
import { OI, writeMetadata } from "./format.ts"
import { newSpanId, nowNs, nsToIso } from "./ids.ts"
import { DURABLE_MEANS, detectorPrompt, NOT_DURABLE_MEANS, parseVerdict } from "./judge.ts"
import { Model, type ModelLayer } from "./model.ts"
import { Redactor } from "./redact.ts"
import {
  type Detector,
  type DetectorReport,
  type SpanParent,
  STEERING_CONFIDENCE,
  type SteeringInput,
  type SteeringVerdict,
} from "./steering.ts"

const SYSTEM = "You classify messages a user sends to a coding agent. Reply with JSON only."

/** One model call that answered: its span attributes and the reply's text. */
interface Completion {
  readonly attributes: Map<string, AttrValue>
  readonly text: string
}

/** Run one prompt through a model layer and record it as an `LLM` span under the detection. */
const complete = async (model: ModelLayer, prompt: string, report: DetectorReport): Promise<string> => {
  const start = nowNs()
  let request = ""

  const call = Effect.gen(function* () {
    const service = yield* Model

    const raw = yield* service.run(
      { system: SYSTEM, tools: [], messages: [service.dialect.userMessage([prompt])] },
      { onRequest: (body) => (request = body), onDelta: () => undefined },
    )

    const attributes = new Map([
      ...service.dialect.requestAttributes(request, service.provider),
      ...service.dialect.responseAttributes(raw),
    ])

    attributes.set(
      OI.METADATA,
      writeMetadata(undefined, { api: service.dialect.api, provider: service.provider }),
    )

    const completion: Completion = { attributes, text: service.dialect.reply(raw)?.text ?? "" }

    return completion
  }).pipe(Effect.provide(model))

  const exit = await Effect.runPromiseExit(call)

  const span =
    (attributes: Map<string, AttrValue>, error: string | undefined) =>
    (parent: SpanParent): EndedSpan => {
      attributes.set(OI.SESSION_ID, parent.sessionId)
      attributes.set(OI.SPAN_KIND, "LLM")

      return {
        name: "llm",
        context: { trace_id: parent.traceId, span_id: newSpanId() },
        span_kind: "SPAN_KIND_INTERNAL",
        parent_id: parent.spanId,
        start_time: nsToIso(start),
        end_time: nsToIso(nowNs()),
        status_code: error === undefined ? "OK" : "ERROR",
        status_message: error ?? "",
        events: [],
        attributes: Object.fromEntries(attributes),
      }
    }

  return Exit.match(exit, {
    onSuccess: (completion) => {
      report.span(span(completion.attributes, undefined))

      return completion.text
    },
    onFailure: () => {
      const message = Option.match(Exit.findErrorOption(exit), {
        onNone: () => "the call did not complete",
        onSome: (error) => error.message,
      })

      report.span(span(new Map([[OI.INPUT_VALUE, request]]), message))

      throw new Error(`the steering model failed: ${message}`)
    },
  })
}

/** The steering detector on any model a provider serves. */
export const llmDetector =
  (model: ModelLayer): Detector =>
  async (input, report) =>
    parseVerdict(await complete(model, detectorPrompt(input), report))

const DURABLE_QUESTION: Noul = {
  type: "noul",
  instructions:
    "Does the user's latest message correct the coding agent, or state a preference, in a way that should apply to the agent's future work in this project and not only to the current task?",
  criteria: { true: DURABLE_MEANS, false: NOT_DURABLE_MEANS },
}

const stateOf = (input: SteeringInput) => ({
  previous_turn: input.previous === "" ? "(none)" : input.previous,
  user_message: input.prompt,
  existing_evaluators: input.existing.map((entry) => `${entry.name}: ${entry.description}`),
})

/**
 * Screen with the decision model; write with `writer` only when the screen is
 * confident the prompt is durable. The verdict's confidence is the decision
 * model's calibrated probability, not the writer's own estimate. When the
 * decision call fails, the writer decides alone, as it would without one.
 */
export const decisionDetector =
  (
    settings: DecisionSettings,
    apiKey: string,
    writer: Detector | undefined,
    redactor: Redactor = new Redactor(),
  ): Detector =>
  async (input, report) => {
    const call = await askDecision(
      settings,
      apiKey,
      "steering",
      stateOf(input),
      new Map([["durable", DURABLE_QUESTION]]),
      redactor,
    )

    report.span((parent) => decisionSpan(parent.sessionId, parent, call))

    const durable = call.nouls.get("durable")

    if (call.error !== undefined || durable === undefined)
      return writer === undefined ? undefined : writer(input, report)

    const verdict: SteeringVerdict = {
      durable: durable >= 0.5,
      confidence: durable >= 0.5 ? durable : 1 - durable,
      statement: "",
    }

    if (!verdict.durable || durable < STEERING_CONFIDENCE || writer === undefined) return verdict

    const written = await writer(input, report)

    if (written === undefined) return verdict

    return { ...written, durable: true, confidence: durable }
  }
