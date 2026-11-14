/**
 * Learning from steering: after each turn, a small model reads the user's
 * prompt and decides whether it corrects the agent in a way that applies
 * beyond the current task ("we use pnpm here", "too long again"). If so, it
 * proposes an evaluator, which is saved like one from `create_eval`, so the
 * correction is checked on every later turn and can become a rule.
 *
 * It runs on the judge model, not on the model driving the session, so how
 * well oi learns does not depend on which model that is (see
 * docs/experiments/steering.md). Each detection is an `EVALUATOR` trace
 * with the prompt as input and the verdict as output; a learned evaluator is
 * also an annotation on the turn, which is how the terminal and Phoenix show
 * it, and the evaluator file records the turn it came from.
 */
import { Effect, Option, Schema } from "effect"
import {
  definitionFrom,
  EvalInput,
  type EvalRuntime,
  loadEvals,
  reporterFor,
  saveEval,
  turnRecord,
  type UsageReporter,
} from "./evals.ts"
import { type AnnotationFile, OI, readMetadata, stringAttr, writeMetadata } from "./format.ts"
import { newId, nowNs, nsToIso } from "./ids.ts"
import { truncate } from "./tools.ts"
import { diskTracer } from "./tracer.ts"

/** What the detector reads. */
export interface SteeringInput {
  /** The user's prompt for the turn. */
  readonly prompt: string
  /** The turn before it, as text, so that "no, not like that" can be resolved. Empty for a first turn. */
  readonly previous: string
  /** Evaluators the project already has, so a correction they cover is not learned twice. */
  readonly existing: ReadonlyArray<{ readonly name: string; readonly description: string }>
}

export const SteeringVerdict = Schema.Struct({
  /** The prompt corrects something that will matter in later, unrelated tasks too. */
  durable: Schema.Boolean,
  confidence: Schema.Finite,
  /** The correction as one imperative sentence. */
  statement: Schema.String,
  /** The existing evaluator that already checks this, if one does. */
  covered_by: Schema.optionalKey(Schema.NullOr(Schema.String)),
  evaluator: Schema.optionalKey(Schema.NullOr(EvalInput)),
})

export type SteeringVerdict = typeof SteeringVerdict.Type

const asObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

/** A verdict as models write it: fields of the evaluator that do not apply often come back as `""`, not absent. */
export const looseVerdict = (value: Schema.Json): Schema.Json =>
  Option.match(asObject(value), {
    onNone: () => value,
    onSome: (verdict) =>
      Option.match(asObject(verdict["evaluator"]), {
        onNone: () => value,
        onSome: (evaluator) => ({
          ...verdict,
          evaluator: Object.fromEntries(
            Object.entries(evaluator).filter(([, field]) => field !== "" && field !== null),
          ),
        }),
      }),
  })

/** Reads one prompt. Injected, like the judge, so the engine does not own a model. */
export type Detector = (input: SteeringInput, report: UsageReporter) => Promise<SteeringVerdict | undefined>

/** Below this the detector is not sure enough to change how every later turn is judged. */
export const STEERING_CONFIDENCE = 0.7

/** How much of the previous turn the detector sees. */
const PREVIOUS_CHARS = 4000

const inputFor = (runtime: EvalRuntime, sessionId: string, traceId: string, cwd: string): SteeringInput => {
  const trace = runtime.store.readTrace(sessionId, traceId)
  const root = trace.ended.find((span) => span.parent_id === null)
  const previous = root === undefined ? undefined : readMetadata(root).previous?.trace_id

  return {
    prompt: root === undefined ? "" : (stringAttr(root, OI.INPUT_VALUE) ?? ""),
    previous:
      previous === undefined
        ? ""
        : truncate(turnRecord(runtime.store, sessionId, previous).transcript, PREVIOUS_CHARS),
    existing: loadEvals(cwd).map((definition) => ({
      name: definition.name,
      description: definition.description,
    })),
  }
}

/** The outcome, for the span's output and for tests. */
export type SteeringOutcome =
  | { readonly learned: true; readonly name: string; readonly statement: string; readonly file: string }
  | { readonly learned: false; readonly reason: string }

/** Why a verdict does not become an evaluator, or the evaluator to save. */
const decide = (
  verdict: SteeringVerdict | undefined,
  input: SteeringInput,
): { readonly reason: string } | { readonly evaluator: typeof EvalInput.Type } => {
  if (verdict === undefined) return { reason: "the detector gave no usable answer" }

  if (!verdict.durable) return { reason: "not a durable correction" }

  if (verdict.confidence < STEERING_CONFIDENCE)
    return { reason: `confidence ${verdict.confidence} is below ${STEERING_CONFIDENCE}` }

  const covered = verdict.covered_by ?? undefined

  if (covered !== undefined && input.existing.some((entry) => entry.name === covered))
    return { reason: `already checked by ${covered}` }

  const evaluator = verdict.evaluator ?? undefined

  if (evaluator === undefined) return { reason: "durable, but no evaluator was proposed" }

  if (input.existing.some((entry) => entry.name === evaluator.name))
    return { reason: `an evaluator named ${evaluator.name} already exists` }

  return { evaluator }
}

/**
 * Every verdict, as an annotation on the turn it read: `learned`, or what the
 * detector made of the prompt (`durable` but not learned, or `one-off`), with
 * its confidence as the score. In Phoenix these are columns on the turn; the
 * terminal shows only what was learned (`shownInTerminal`).
 */
const verdictAnnotation = (
  sessionId: string,
  traceId: string,
  verdict: SteeringVerdict,
  outcome: SteeringOutcome,
): AnnotationFile => {
  const label = outcome.learned ? "learned" : verdict.durable ? "durable" : "one-off"

  const explanation = outcome.learned
    ? `${outcome.statement} Checked from now on by evaluator ${outcome.name}.`
    : verdict.durable
      ? `${verdict.statement} Not learned: ${outcome.reason}.`
      : "About the current task only."

  // Not a failure, and nothing for the agent to be told: it is a note for the people watching.
  const metadata = new Map<string, Schema.Json>([
    ["failed", false],
    ["feedback", false],
  ])

  if (outcome.learned) metadata.set("evaluator", outcome.name)

  return {
    id: newId(),
    scope: "trace",
    target: { session_id: sessionId, trace_id: traceId },
    created_at: nsToIso(nowNs()),
    annotation: {
      name: "steering",
      label,
      score: verdict.confidence,
      annotator_kind: "LLM",
      identifier: "oi-agent",
      explanation,
      metadata: Object.fromEntries(metadata),
    },
  }
}

/** Whether a person at the terminal needs to see this annotation: steering verdicts only when something was learned. */
export const shownInTerminal = (file: AnnotationFile): boolean =>
  file.annotation.name !== "steering" || file.annotation.label === "learned"

/** Read a finished turn's prompt for durable steering, and learn it as an evaluator. */
export const detectSteering = (
  runtime: EvalRuntime,
  detect: Detector,
  sessionId: string,
  traceId: string,
): Promise<SteeringOutcome> => {
  const cwd = runtime.store.readHeader(sessionId)?.cwd

  if (cwd === undefined) return Promise.resolve({ learned: false, reason: "no such session" })

  const input = inputFor(runtime, sessionId, traceId, cwd)

  const run = Effect.gen(function* () {
    const report = yield* reporterFor(runtime, sessionId)

    const verdict = yield* Effect.promise(() => detect(input, report))
    const decision = decide(verdict, input)

    let outcome: SteeringOutcome

    if ("reason" in decision) {
      outcome = { learned: false, reason: decision.reason }
    } else {
      const definition = definitionFrom(decision.evaluator)

      if (Schema.is(Schema.String)(definition)) {
        outcome = { learned: false, reason: `the proposed evaluator is invalid: ${definition}` }
      } else {
        const file = saveEval(cwd, {
          ...definition,
          origin: { kind: "steering", session_id: sessionId, trace_id: traceId },
        })

        outcome = { learned: true, name: definition.name, statement: verdict?.statement ?? "", file }
      }
    }

    // A verdict, whatever came of it, is an annotation on the turn; no verdict leaves nothing to say.
    if (verdict !== undefined)
      runtime.store.writeAnnotation(verdictAnnotation(sessionId, traceId, verdict, outcome))

    yield* Effect.annotateCurrentSpan(OI.OUTPUT_VALUE, JSON.stringify({ verdict: verdict ?? null, outcome }))
    yield* Effect.annotateCurrentSpan(OI.OUTPUT_MIME, "application/json")

    return outcome
  }).pipe(
    Effect.withSpan(
      "steering",
      {
        root: true,
        attributes: {
          [OI.SPAN_KIND]: "EVALUATOR",
          [OI.INPUT_VALUE]: input.prompt,
          [OI.INPUT_MIME]: "text/plain",
          [OI.METADATA]: writeMetadata(undefined, { evaluates: traceId }),
        },
      },
      { captureStackTrace: false },
    ),
    Effect.withTracer(diskTracer(runtime.store, sessionId)),
    // Detection must never break the session it watches.
    Effect.catchDefect((): Effect.Effect<SteeringOutcome> =>
      Effect.succeed({ learned: false, reason: "the detector failed" }),
    ),
  )

  return Effect.runPromise(run)
}
