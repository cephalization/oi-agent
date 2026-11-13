/**
 * Evaluators that run on every finished turn.
 *
 * An evaluator is a small JSON file in the project (`.oi/evals/<name>.json`),
 * which is what lets the agent create one from a sentence. Results are
 * OpenInference annotations on the turn's trace. A failing result is fed
 * back into the next turn and, when the evaluator says so, distilled into a
 * standing rule.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import { loadSession } from "./fold.ts"
import {
  type AnnotationBody,
  type AnnotationFile,
  type EndedSpan,
  kindOf,
  OI,
  parser,
  readMetadata,
  stringAttr,
  writeMetadata,
} from "./format.ts"
import { newId, newSpanId, nowNs, nsToIso } from "./ids.ts"
import { addRule, readRules } from "./rules.ts"
import type { Store } from "./store.ts"
import { truncate } from "./tools.ts"
import { diskTracer } from "./tracer.ts"

// --- definitions -----------------------------------------------------------

const common = {
  name: Schema.String,
  description: Schema.String,
  /** Labels that count as a failure. */
  fail_labels: Schema.Array(Schema.String),
  /** Tell the agent about a failure at the start of its next turn. */
  feedback: Schema.Boolean,
  /** Turn failures into standing rules in `.oi/rules.md`. */
  learn: Schema.Boolean,
}

export const LlmEval = Schema.Struct({
  ...common,
  kind: Schema.Literal("llm"),
  /** What the judge should decide, in plain language. */
  instructions: Schema.String,
  /** Label to score, for example `{ "pass": 1, "fail": 0 }`. */
  choices: Schema.Record(Schema.String, Schema.Finite),
})

export type LlmEval = typeof LlmEval.Type

export const CodeEval = Schema.Struct({
  ...common,
  kind: Schema.Literal("code"),
  /** Regular expression tested against the target text. */
  pattern: Schema.String,
  target: Schema.Literals(["output", "tool_input", "tool_output", "transcript"]),
  /** Label when the pattern matches; the other label applies otherwise. */
  match_label: Schema.String,
  otherwise_label: Schema.String,
})

export type CodeEval = typeof CodeEval.Type

export const EvalDefinition = Schema.Union([LlmEval, CodeEval])

export type EvalDefinition = typeof EvalDefinition.Type

export const evalsDir = (cwd: string): string => path.join(cwd, ".oi", "evals")

const parseDefinition = parser(EvalDefinition)
const encodeDefinition = Schema.encodeSync(EvalDefinition)

export const loadEvals = (cwd: string): Array<EvalDefinition> => {
  const definitions: Array<EvalDefinition> = []
  let names: Array<string> = []

  try {
    names = fs.readdirSync(evalsDir(cwd)).sort()
  } catch {
    return definitions
  }

  for (const name of names) {
    const definition = name.endsWith(".json")
      ? parseDefinition(fs.readFileSync(path.join(evalsDir(cwd), name), "utf8"))
      : undefined

    if (definition !== undefined) definitions.push(definition)
  }

  return definitions
}

export const saveEval = (cwd: string, definition: EvalDefinition): string => {
  const file = path.join(evalsDir(cwd), `${definition.name.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}.json`)

  fs.mkdirSync(evalsDir(cwd), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(encodeDefinition(definition), null, 2)}\n`)

  return file
}

// --- what an evaluator sees ------------------------------------------------

export interface TurnRecord {
  readonly input: string
  readonly output: string
  readonly tool_input: string
  readonly tool_output: string
  readonly transcript: string
}

/** A turn rendered as text, from its spans. */
export const turnRecord = (store: Store, sessionId: string, traceId: string): TurnRecord => {
  const trace = store.readTrace(sessionId, traceId)
  const root = trace.ended.find((span) => span.parent_id === null)
  const tools = trace.ended.filter((span) => kindOf(span) === "TOOL")
  const input = root === undefined ? "" : (stringAttr(root, OI.INPUT_VALUE) ?? "")
  const output = root === undefined ? "" : (stringAttr(root, OI.OUTPUT_VALUE) ?? "")
  const calls = tools.map((span) => `${span.name} ${stringAttr(span, OI.INPUT_VALUE) ?? ""}`)
  const results = tools.map((span) => stringAttr(span, OI.OUTPUT_VALUE) ?? "")

  const steps = tools.map(
    (span, index) =>
      `[tool call] ${calls[index] ?? ""}\n[tool result] ${truncate(results[index] ?? "", 2000)}`,
  )

  return {
    input,
    output,
    tool_input: calls.join("\n"),
    tool_output: results.join("\n"),
    transcript: [`[user] ${input}`, ...steps, `[assistant] ${output}`].join("\n\n"),
  }
}

// --- running ---------------------------------------------------------------

export interface Verdict {
  readonly label: string
  readonly score?: number | undefined
  readonly explanation?: string | undefined
}

/** One model call made on behalf of an evaluator, reported so it can be traced and costed. */
export interface ModelUsage {
  readonly provider: string
  readonly model: string
  readonly prompt: string
  readonly completion: string
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_tokens: number
  readonly cache_write_tokens: number
  readonly start_ns: bigint
  readonly end_ns: bigint
}

export type UsageReporter = (usage: ModelUsage) => void

/** Runs an LLM evaluator. Injected so the engine does not own a judge model. */
export type Judge = (definition: LlmEval, record: TurnRecord, report: UsageReporter) => Promise<Verdict>

/**
 * Turns a failure into a one-line rule, or `undefined` when the existing
 * rules already cover it.
 */
export type Distiller = (
  definition: EvalDefinition,
  verdict: Verdict,
  record: TurnRecord,
  existing: string,
  report: UsageReporter,
) => Promise<string | undefined>

export interface EvalRuntime {
  readonly store: Store
  readonly judge: Judge
  readonly distill: Distiller
}

const runCode = (definition: CodeEval, record: TurnRecord): Verdict => {
  const matched = new RegExp(definition.pattern, "m").test(record[definition.target])

  return {
    label: matched ? definition.match_label : definition.otherwise_label,
    explanation: `/${definition.pattern}/ ${matched ? "matched" : "did not match"} the turn's ${definition.target}.`,
  }
}

/** An `LLM` span for a model call an evaluator made, so its tokens and cost are visible. */
const usageSpan = (
  sessionId: string,
  parent: { traceId: string; spanId: string },
  usage: ModelUsage,
): EndedSpan => ({
  name: "llm",
  context: { trace_id: parent.traceId, span_id: newSpanId() },
  span_kind: "SPAN_KIND_INTERNAL",
  parent_id: parent.spanId,
  start_time: nsToIso(usage.start_ns),
  end_time: nsToIso(usage.end_ns),
  status_code: "OK",
  status_message: "",
  events: [],
  attributes: {
    [OI.SESSION_ID]: sessionId,
    [OI.SPAN_KIND]: "LLM",
    [OI.LLM_SYSTEM]: usage.provider,
    [OI.LLM_PROVIDER]: usage.provider,
    [OI.LLM_MODEL]: usage.model,
    [OI.INPUT_VALUE]: usage.prompt,
    [OI.INPUT_MIME]: "text/plain",
    [OI.OUTPUT_VALUE]: usage.completion,
    [OI.OUTPUT_MIME]: "text/plain",
    [`${OI.LLM_INPUT_MESSAGES}.0.message.role`]: "user",
    [`${OI.LLM_INPUT_MESSAGES}.0.message.content`]: usage.prompt,
    [`${OI.LLM_OUTPUT_MESSAGES}.0.message.role`]: "assistant",
    [`${OI.LLM_OUTPUT_MESSAGES}.0.message.content`]: usage.completion,
    [OI.TOKENS_PROMPT]: usage.input_tokens,
    [OI.TOKENS_COMPLETION]: usage.output_tokens,
    [OI.TOKENS_TOTAL]: usage.input_tokens + usage.output_tokens,
    [OI.TOKENS_CACHE_READ]: usage.cache_read_tokens,
    [OI.TOKENS_CACHE_WRITE]: usage.cache_write_tokens,
  },
})

const reporterFor = (runtime: EvalRuntime, sessionId: string) =>
  Effect.gen(function* () {
    const span = yield* Effect.orDie(Effect.currentSpan)

    return (usage: ModelUsage): void => runtime.store.endSpan(sessionId, usageSpan(sessionId, span, usage))
  })

const evaluate = (
  runtime: EvalRuntime,
  definition: EvalDefinition,
  record: TurnRecord,
  report: UsageReporter,
): Promise<Verdict> =>
  definition.kind === "code"
    ? Promise.resolve(runCode(definition, record))
    : runtime.judge(definition, record, report)

type MutableAnnotation = { -readonly [K in keyof AnnotationBody]: AnnotationBody[K] }

const annotationFor = (
  sessionId: string,
  traceId: string,
  definition: EvalDefinition,
  verdict: Verdict,
): AnnotationFile => {
  const failed = definition.fail_labels.includes(verdict.label)

  const body: MutableAnnotation = {
    name: definition.name,
    label: verdict.label,
    annotator_kind: definition.kind === "llm" ? "LLM" : "CODE",
    identifier: "oi-agent",
    metadata: { failed, feedback: definition.feedback && failed },
  }

  if (verdict.score !== undefined) body.score = verdict.score

  if (verdict.explanation !== undefined) body.explanation = verdict.explanation

  return {
    id: newId(),
    scope: "trace",
    target: { session_id: sessionId, trace_id: traceId },
    created_at: nsToIso(nowNs()),
    annotation: body,
  }
}

/** One evaluator run, recorded as its own `EVALUATOR` trace. */
const runOne = (
  runtime: EvalRuntime,
  sessionId: string,
  traceId: string,
  definition: EvalDefinition,
  record: TurnRecord,
): Effect.Effect<AnnotationFile | undefined> =>
  Effect.gen(function* () {
    const report = yield* reporterFor(runtime, sessionId)
    const verdict = yield* Effect.promise(() => evaluate(runtime, definition, record, report))

    yield* Effect.annotateCurrentSpan(OI.OUTPUT_VALUE, JSON.stringify(verdict))
    yield* Effect.annotateCurrentSpan(OI.OUTPUT_MIME, "application/json")

    const annotation = annotationFor(sessionId, traceId, definition, verdict)

    runtime.store.writeAnnotation(annotation)

    return annotation
  }).pipe(
    Effect.withSpan(
      `eval ${definition.name}`,
      {
        root: true,
        attributes: {
          [OI.SPAN_KIND]: "EVALUATOR",
          [OI.INPUT_VALUE]: record.transcript,
          [OI.INPUT_MIME]: "text/plain",
          [OI.METADATA]: writeMetadata(undefined, { evaluates: traceId }),
        },
      },
      { captureStackTrace: false },
    ),
    Effect.withTracer(diskTracer(runtime.store, sessionId)),
    // A broken evaluator must never break the session it is watching.
    Effect.catchDefect(() => Effect.succeed(undefined)),
  )

/** Distill a failure into a rule, recorded as a `CHAIN` trace of its own. */
const learn = (
  runtime: EvalRuntime,
  sessionId: string,
  cwd: string,
  definition: EvalDefinition,
  annotation: AnnotationFile,
  record: TurnRecord,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const report = yield* reporterFor(runtime, sessionId)

    const verdict: Verdict = {
      label: annotation.annotation.label ?? "",
      explanation: annotation.annotation.explanation,
    }

    const rule = yield* Effect.promise(() =>
      runtime.distill(definition, verdict, record, readRules(cwd), report),
    )

    const text = rule?.trim() ?? ""

    yield* Effect.annotateCurrentSpan(OI.OUTPUT_VALUE, text === "" ? "(no new rule)" : text)

    if (text === "") return

    const version = addRule(cwd, { text, source: definition.name })

    yield* Effect.annotateCurrentSpan(OI.METADATA, writeMetadata(undefined, { prompt_version: version }))
  }).pipe(
    Effect.withSpan(
      `learn ${definition.name}`,
      {
        root: true,
        attributes: {
          [OI.SPAN_KIND]: "CHAIN",
          [OI.INPUT_VALUE]: annotation.annotation.explanation ?? annotation.annotation.label ?? "",
          [OI.INPUT_MIME]: "text/plain",
          [OI.OUTPUT_MIME]: "text/plain",
        },
      },
      { captureStackTrace: false },
    ),
    Effect.withTracer(diskTracer(runtime.store, sessionId)),
    Effect.catchDefect(() => Effect.void),
  )

const failed = (annotation: AnnotationFile): boolean => annotation.annotation.metadata?.["failed"] === true

/** Run every evaluator in the project against a finished turn. */
export const runEvals = async (
  runtime: EvalRuntime,
  sessionId: string,
  traceId: string,
): Promise<Array<AnnotationFile>> => {
  const cwd = runtime.store.readHeader(sessionId)?.cwd
  const definitions = cwd === undefined ? [] : loadEvals(cwd)

  if (cwd === undefined || definitions.length === 0) return []

  const record = turnRecord(runtime.store, sessionId, traceId)

  const results = await Effect.runPromise(
    Effect.forEach(definitions, (definition) => runOne(runtime, sessionId, traceId, definition, record), {
      concurrency: 4,
    }),
  )

  const annotations: Array<AnnotationFile> = []

  for (const [index, annotation] of results.entries()) {
    const definition = definitions[index]

    if (annotation === undefined || definition === undefined) continue

    annotations.push(annotation)

    if (definition.learn && failed(annotation)) {
      await Effect.runPromise(learn(runtime, sessionId, cwd, definition, annotation, record))
    }
  }

  return annotations
}

// --- feedback --------------------------------------------------------------

const wantsFeedback = (annotation: AnnotationFile): boolean =>
  annotation.annotation.metadata?.["feedback"] === true

/**
 * Failing results the agent has not been told about yet: feedback-enabled
 * annotations on this branch's turns that no later turn has injected.
 */
export const pendingFeedback = (store: Store, sessionId: string): Array<AnnotationFile> => {
  const view = loadSession(store, sessionId)

  const delivered = new Set(
    view.turns.flatMap((turn) =>
      (readMetadata(turn.root).injected ?? []).map((entry) => entry.annotation_id),
    ),
  )

  const head = view.head?.trace_id

  return store
    .listAnnotations(sessionId)
    .filter(
      (annotation) =>
        wantsFeedback(annotation) && !delivered.has(annotation.id) && annotation.target.trace_id === head,
    )
}

export const decodeEvalDefinition = (input: Schema.Json): EvalDefinition | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(EvalDefinition)(input))
