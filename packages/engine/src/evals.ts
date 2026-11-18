/**
 * Evaluators that run on every finished turn.
 *
 * An evaluator is a small JSON file kept per project in the config directory
 * (`~/.config/oi-agent/projects/<project>/evals/<name>.json`),
 * which is what lets the agent create one from a sentence. Results are
 * OpenInference annotations on the turn's trace. A failing result is fed
 * back into the next turn and, when the evaluator says so, distilled into a
 * standing rule.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Match, Option, Schema } from "effect"
import { formatBytes } from "./bytes.ts"
import { projectDir } from "./config.ts"
import { branchTo, loadSession, renderSaid, SAID_MID_TURN, type TurnSummary } from "./fold.ts"
import {
  type AnnotationBody,
  type AnnotationFile,
  type AttachmentRef,
  type Billing,
  type EndedSpan,
  type SessionSpanRef,
  type SpanFile,
  kindOf,
  OI,
  parser,
  readMetadata,
  stringAttr,
  writeMetadata,
} from "./format.ts"
import { newId, newSpanId, nowNs, nsToIso } from "./ids.ts"
import { addRule, readRules } from "./rules.ts"
import type { Store, TraceFiles } from "./store.ts"
import { truncate } from "./tools.ts"
import { diskTracer } from "./tracer.ts"
import type { Detector } from "./steering.ts"

/**
 * When an evaluator applies. A turn qualifies when any predicate in `any`
 * holds (or `any` is empty) and every predicate in `all` holds. Predicates:
 * `writes`, `commit`, `tool:<name>`, `always`. Absent means every turn.
 */
export const Trigger = Schema.String

export const isTrigger = (trigger: string): boolean =>
  ["writes", "commit", "always"].includes(trigger) || /^tool:[A-Za-z0-9_-]+$/.test(trigger)

export const Applicability = Schema.Struct({
  any: Schema.Array(Trigger),
  all: Schema.optionalKey(Schema.Array(Trigger)),
})

export type Applicability = typeof Applicability.Type

// --- definitions -----------------------------------------------------------

const common = {
  applicability: Schema.optionalKey(Applicability),
  name: Schema.String,
  description: Schema.String,
  /** Labels that count as a failure. */
  fail_labels: Schema.Array(Schema.String),
  /** Tell the agent about a failure at the start of its next turn. */
  feedback: Schema.Boolean,
  /** Turn failures into standing rules in the project's `rules.md`. */
  learn: Schema.Boolean,
  /** Where it came from, when not from `create_eval`: the user prompt it was learned from. */
  origin: Schema.optionalKey(
    Schema.Struct({ kind: Schema.Literal("steering"), session_id: Schema.String, trace_id: Schema.String }),
  ),
}

export const LlmEval = Schema.Struct({
  ...common,
  kind: Schema.Literal("llm"),
  /** Outcome checks only: defer until directly launched background work is delivered. */
  wait_for_background: Schema.optionalKey(Schema.Boolean),
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

/** A numeric fact about the turn that an evaluator can put a limit on. */
export const Metric = Schema.Literals(["session_bytes", "tool_calls"])

export type Metric = typeof Metric.Type

export const ThresholdEval = Schema.Struct({
  ...common,
  kind: Schema.Literal("threshold"),
  metric: Metric,
  /** The turn fails when the metric is greater than this. */
  max: Schema.Finite,
})

export type ThresholdEval = typeof ThresholdEval.Type

export const EvalDefinition = Schema.Union([LlmEval, CodeEval, ThresholdEval])

export type EvalDefinition = typeof EvalDefinition.Type

export const evalsDir = (cwd: string): string => path.join(projectDir(cwd), "evals")

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

/** An evaluator as `create_eval` and the steering detector describe one. */
export const EvalInput = Schema.Struct({
  applicability: Schema.optionalKey(Applicability),
  name: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["llm", "code", "threshold"]),
  wait_for_background: Schema.optionalKey(Schema.Boolean),
  metric: Schema.optionalKey(Metric),
  max: Schema.optionalKey(Schema.Finite),
  instructions: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.Literals(["output", "tool_input", "tool_output", "transcript"])),
  learn: Schema.optionalKey(Schema.Boolean),
})

/** A full evaluator definition from a short description, or why it cannot be one. */
export const definitionFrom = (input: typeof EvalInput.Type): EvalDefinition | string => {
  const common = {
    name: input.name,
    description: input.description,
    fail_labels: ["fail"],
    feedback: true,
    learn: input.learn ?? true,
  }

  const applicability = input.applicability ?? { any: [] }

  const unknown = [...applicability.any, ...(applicability.all ?? [])].filter(
    (trigger) => !isTrigger(trigger),
  )

  if (unknown.length > 0)
    return `Unknown applicability predicate ${unknown.join(", ")}: use writes, commit, tool:<name> or always.`
  const scoped = { ...common, applicability }

  if (input.wait_for_background === true && input.kind !== "llm")
    return "wait_for_background is only supported for llm outcome checks."

  if (input.kind === "llm") {
    return input.instructions === undefined
      ? "An llm evaluator needs instructions."
      : {
          ...scoped,
          kind: "llm",
          wait_for_background: input.wait_for_background ?? false,
          instructions: input.instructions,
          choices: { pass: 1, fail: 0 },
        }
  }

  if (input.kind === "threshold") {
    return input.metric === undefined || input.max === undefined
      ? "A threshold evaluator needs a metric and a max."
      : // A limit is not something the agent can learn its way under, so it only gives feedback.
        { ...scoped, learn: input.learn ?? false, kind: "threshold", metric: input.metric, max: input.max }
  }

  if (input.pattern === undefined) return "A code evaluator needs a pattern."

  try {
    new RegExp(input.pattern, "m")
  } catch {
    return `Not a valid regular expression: ${input.pattern}`
  }

  return {
    ...scoped,
    kind: "code",
    pattern: input.pattern,
    target: input.target ?? "transcript",
    match_label: "fail",
    otherwise_label: "pass",
  }
}

// --- what an evaluator sees ------------------------------------------------

export interface TurnRecord {
  readonly activity?: ReadonlyMap<string, string>
  readonly input: string
  readonly output: string
  readonly tool_input: string
  readonly tool_output: string
  readonly transcript: string
  /** What a judge reads, when not the transcript: a recheck shows the failing turn too. */
  readonly judged?: string
  /** Numeric facts about the turn and its session. */
  readonly metrics: { readonly [M in Metric]: number }
  /** The same facts as text, for a judge to read. */
  readonly facts: string
}

/** A single linked span, never its model history or further provenance. */
const linkedEvidence = (store: Store, ref: SessionSpanRef) => {
  const span = store
    .readTrace(ref.session_id, ref.trace_id)
    .ended.find((entry) => entry.context.span_id === ref.span_id)

  return {
    ...ref,
    available: span !== undefined,
    name: span?.name,
    input: span === undefined ? undefined : truncate(stringAttr(span, OI.INPUT_VALUE) ?? "", 4000),
    output: span === undefined ? undefined : truncate(stringAttr(span, OI.OUTPUT_VALUE) ?? "", 2000),
  }
}

/** Told to a judge only about a turn its person steered. */
const STEERED_FACT =
  " The user said more while the agent was working (input.said_while_working, and marked in a transcript). Each message is an instruction from the user that binds the agent from the point it was given: after_calls is how many of the turn's tool calls had already been made by then, and those earlier calls cannot have gone against it."

/** A turn's spans, as its record reads them. */
interface TurnSpans {
  readonly trace: TraceFiles
  readonly root: EndedSpan | undefined
  /** Evaluators judge the work, not their own creation: a `create_eval` call holds the very pattern it forbids. */
  readonly tools: ReadonlyArray<EndedSpan>
}

const turnSpans = (store: Store, sessionId: string, traceId: string): TurnSpans => {
  const trace = store.readTrace(sessionId, traceId)

  return {
    trace,
    root: trace.ended.find((span) => span.parent_id === null),
    tools: trace.ended.filter(
      (span) => kindOf(span) === "TOOL" && stringAttr(span, OI.TOOL_NAME) !== "create_eval",
    ),
  }
}

/** A message given to the turn while it ran, placed among its tool calls. */
interface SaidMidTurn {
  /** The message, with a note of any images sent with it. */
  readonly text: string
  /** How many of the turn's tool calls had been made when the agent was given it. */
  readonly after_calls: number
}

/**
 * Where each steering message falls in the turn. A message follows a model
 * call's tool results and is read by the next model call, so every tool that
 * started before that next call came first.
 */
const saidMidTurn = ({ trace, root, tools }: TurnSpans): Array<SaidMidTurn> => {
  const steered = root === undefined ? [] : (readMetadata(root).steered ?? [])

  if (steered.length === 0) return []

  const calls = trace.ended
    .filter((span) => kindOf(span) === "LLM")
    .toSorted((left, right) => left.start_time.localeCompare(right.start_time))

  return steered.map((entry) => {
    const followed = calls.findIndex((call) => call.context.span_id === entry.after)
    const reader = followed === -1 ? undefined : calls[followed + 1]

    return {
      text: `${entry.text}${imagesNote(entry.attachments)}`,
      // No later model call: the turn was stopped before the message was read, after everything it did.
      after_calls:
        reader === undefined
          ? tools.length
          : tools.filter((tool) => tool.start_time < reader.start_time).length,
    }
  })
}

/** ` [with images: a.png, b.png]`: a judge cannot see them, but should know the words were not all that was said. */
const imagesNote = (refs: ReadonlyArray<AttachmentRef> = []): string =>
  refs.length === 0 ? "" : ` [with images: ${refs.map((ref) => ref.name).join(", ")}]`

const stepOf = (tool: EndedSpan): string =>
  `[tool call] ${tool.name} ${stringAttr(tool, OI.INPUT_VALUE) ?? ""}\n[tool result] ${truncate(stringAttr(tool, OI.OUTPUT_VALUE) ?? "", 2000)}`

/** The turn as lines of a transcript, up to but not including the agent's answer. */
const turnLines = (spans: TurnSpans, said: ReadonlyArray<SaidMidTurn>, upTo = said.length): Array<string> => {
  const input = spans.root === undefined ? "" : (stringAttr(spans.root, OI.INPUT_VALUE) ?? "")
  const heard = said.slice(0, upTo)
  const tools = upTo === said.length ? spans.tools : spans.tools.slice(0, said[upTo]?.after_calls)

  const saidAfter = (count: number): Array<string> =>
    heard.flatMap((entry) => (entry.after_calls === count ? [`${SAID_MID_TURN} ${entry.text}`] : []))

  const images = spans.root === undefined ? "" : imagesNote(readMetadata(spans.root).attachments)

  return [
    `[user] ${input}${images}`,
    ...saidAfter(0),
    ...tools.flatMap((tool, index) => [stepOf(tool), ...saidAfter(index + 1)]),
  ]
}

/** A message said to a running turn, with the turn as it stood when the message was given. */
export interface MidTurnMessage {
  readonly text: string
  readonly before: string
}

/** What was said to a turn while it ran, each with the transcript the person was reacting to. */
export const midTurnMessages = (store: Store, sessionId: string, traceId: string): Array<MidTurnMessage> => {
  const spans = turnSpans(store, sessionId, traceId)
  const said = saidMidTurn(spans)

  return said.map((entry, index) => ({
    text: entry.text,
    before: turnLines(spans, said, index).join("\n\n"),
  }))
}

/** A turn rendered as text, from its spans. */
export const turnRecord = (store: Store, sessionId: string, traceId: string): TurnRecord => {
  const spans = turnSpans(store, sessionId, traceId)
  const { root, tools } = spans
  const said = saidMidTurn(spans)

  const prompt = root === undefined ? "" : (stringAttr(root, OI.INPUT_VALUE) ?? "")
  const input = renderSaid(prompt, said)
  const output = root === undefined ? "" : (stringAttr(root, OI.OUTPUT_VALUE) ?? "")
  const calls = tools.map((span) => `${span.name} ${stringAttr(span, OI.INPUT_VALUE) ?? ""}`)
  const results = tools.map((span) => stringAttr(span, OI.OUTPUT_VALUE) ?? "")

  const sessionBytes =
    (root === undefined ? undefined : readMetadata(root).session_bytes) ?? store.sessionBytes(sessionId)

  const metadata = root === undefined ? undefined : readMetadata(root)

  const deliveries = [
    ...(metadata?.delivers ?? []),
    ...tools.flatMap((tool) => readMetadata(tool).delivers ?? []),
  ].map((delivery) => ({
    kind: delivery.kind,
    id: delivery.id,
    launch: linkedEvidence(store, {
      session_id: sessionId,
      trace_id: delivery.trace_id,
      span_id: delivery.span_id,
    }),
    result: delivery.result === undefined ? undefined : linkedEvidence(store, delivery.result),
  }))

  // Only direct provenance edges: never recurse into a child's conversation.
  const judged = JSON.stringify(
    {
      current_turn: { session_id: sessionId, trace_id: traceId },
      input: {
        role: (metadata?.delivers?.length ?? 0) > 0 ? "delivered_results" : "prompt",
        text: prompt,
        // Absent (and so dropped from the JSON) on a turn nobody steered.
        said_while_working: said.length === 0 ? undefined : said,
      },
      initiated_this_turn: tools.map((span) => ({
        span_id: span.context.span_id,
        name: span.name,
        input: stringAttr(span, OI.INPUT_VALUE) ?? "",
        result: truncate(stringAttr(span, OI.OUTPUT_VALUE) ?? "", 2000),
      })),
      delivered_now: deliveries,
      prompt_origin: metadata?.origin === undefined ? undefined : linkedEvidence(store, metadata.origin),
      assistant_report: output,
    },
    null,
    2,
  )

  const activity = new Map<string, string>()

  for (const event of ["writes", "commit"]) {
    const values = tools.map(
      (tool) =>
        readMetadata(tool).evidence?.[event === "writes" ? "writes" : "commit"] ??
        (readMetadata(tool).approval?.decision === "deny" ? "no" : "unknown"),
    )

    activity.set(event, values.includes("yes") ? "yes" : values.includes("unknown") ? "unknown" : "no")
  }

  for (const tool of tools) activity.set(`tool:${stringAttr(tool, OI.TOOL_NAME) ?? tool.name}`, "yes")

  return {
    activity,
    judged,
    metrics: { session_bytes: sessionBytes, tool_calls: tools.length },
    facts: `Session storage on disk: ${formatBytes(sessionBytes)} (${sessionBytes} bytes). Tool calls this turn: ${tools.length}.${said.length === 0 ? "" : STEERED_FACT}`,
    input,
    output,
    tool_input: calls.join("\n"),
    tool_output: results.join("\n"),
    transcript: [...turnLines(spans, said), `[assistant] ${output}`].join("\n\n"),
  }
}

/** Unknown predicates or old spans run the evaluator, never silently skip it. */
export const applicabilityFor = (condition: Applicability | undefined, record: TurnRecord): Verdict => {
  const evidence = new Map<string, string>()

  const test = (trigger: string): string => {
    const value =
      trigger === "always"
        ? "yes"
        : (record.activity?.get(trigger) ??
          (trigger.startsWith("tool:") && record.activity !== undefined ? "no" : "unknown"))

    evidence.set(trigger, value)

    return value
  }

  const any = condition?.any.map(test) ?? []
  const all = condition?.all?.map(test) ?? []
  const skipped = (any.length > 0 && any.every((value) => value === "no")) || all.includes("no")

  return {
    label: skipped ? "skipped" : "applicable",
    explanation: JSON.stringify({
      condition: condition ?? "always (legacy)",
      evidence: Object.fromEntries(evidence),
    }),
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
  /** The model family or API, for `llm.system`. */
  readonly system: string
  /** Who served the call, for `llm.provider`. */
  readonly vendor: string
  /** The configured provider's id. */
  readonly provider: string
  readonly billing: Billing
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
  /** Reads each prompt for durable steering; absent when steering is off. */
  readonly detect?: Detector | undefined
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
    [OI.LLM_SYSTEM]: usage.system,
    [OI.LLM_PROVIDER]: usage.vendor,
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
    [OI.METADATA]: writeMetadata(undefined, { provider: usage.provider, billing: usage.billing }),
  },
})

/** Report each model call an evaluator makes as an `LLM` span under the current one. */
export const reporterFor = (runtime: EvalRuntime, sessionId: string) =>
  Effect.gen(function* () {
    const span = yield* Effect.orDie(Effect.currentSpan)

    return (usage: ModelUsage): void => runtime.store.endSpan(sessionId, usageSpan(sessionId, span, usage))
  })

const describeMetric = (metric: Metric, value: number): string =>
  metric === "session_bytes"
    ? `session storage is ${formatBytes(value)}`
    : `the turn made ${value} tool calls`

const limitOf = (definition: ThresholdEval): string =>
  definition.metric === "session_bytes" ? formatBytes(definition.max) : String(definition.max)

const runThreshold = (definition: ThresholdEval, record: TurnRecord): Verdict => {
  const value = record.metrics[definition.metric]
  const over = value > definition.max

  return {
    label: over ? "fail" : "pass",
    score: value,
    explanation: `${definition.description} Currently ${describeMetric(definition.metric, value)}, ${over ? "over" : "within"} the limit of ${limitOf(definition)}.`,
  }
}

const evaluate = (
  runtime: EvalRuntime,
  definition: EvalDefinition,
  record: TurnRecord,
  report: UsageReporter,
): Promise<Verdict> =>
  Match.value(definition).pipe(
    Match.discriminatorsExhaustive("kind")({
      code: (code) => Promise.resolve(runCode(code, record)),
      threshold: (threshold) => Promise.resolve(runThreshold(threshold, record)),
      llm: (llm) => runtime.judge(llm, record, report),
    }),
  )

type MutableAnnotation = { -readonly [K in keyof AnnotationBody]: AnnotationBody[K] }

const annotationFor = (
  sessionId: string,
  traceId: string,
  definition: EvalDefinition,
  verdict: Verdict,
  gate: Verdict,
  rechecks: string | undefined,
  deferredFrom: string | undefined,
): AnnotationFile => {
  const failed =
    !["skipped", "pending"].includes(verdict.label) && definition.fail_labels.includes(verdict.label)

  const body: MutableAnnotation = {
    name: definition.name,
    label: verdict.label,
    annotator_kind: definition.kind === "llm" ? "LLM" : "CODE",
    // One turn can carry several results of one evaluator, one per launch turn it
    // settles: Phoenix keeps one annotation per name, trace and identifier.
    identifier: deferredFrom === undefined ? "oi-agent" : `oi-agent:deferred:${deferredFrom}`,
    metadata: {
      failed,
      feedback: definition.feedback && failed,
      skipped: verdict.label === "skipped",
      pending: verdict.label === "pending",
      applicability: gate.explanation ?? "",
    },
  }

  if (deferredFrom !== undefined) body.metadata = { ...body.metadata, deferred_from: deferredFrom }

  if (rechecks !== undefined) body.metadata = { ...body.metadata, rechecks }

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

interface RunOptions {
  /** The failed result this run rechecks. */
  readonly rechecks?: string
  /** The launch turn whose background outcome this run judges. */
  readonly deferredFrom?: string
  /** A verdict that needs no evaluation: still waiting, or can no longer be judged. */
  readonly settled?: Verdict | undefined
}

const WAITING: Verdict = {
  label: "pending",
  explanation: "Waiting for results of directly launched background work to be delivered.",
}

const ABANDONED: Verdict = {
  label: "skipped",
  explanation:
    "The background work's result was delivered on another branch of this session, so its outcome cannot be judged here.",
}

/** One evaluator run, recorded as its own `EVALUATOR` trace. */
const runOne = (
  runtime: EvalRuntime,
  sessionId: string,
  traceId: string,
  definition: EvalDefinition,
  record: TurnRecord,
  options: RunOptions = {},
): Effect.Effect<AnnotationFile | undefined> =>
  Effect.gen(function* () {
    const report = yield* reporterFor(runtime, sessionId)
    const gate = applicabilityFor(definition.applicability, record)

    const verdict =
      options.settled ??
      (gate.label === "skipped"
        ? gate
        : yield* Effect.promise(() => evaluate(runtime, definition, record, report)))

    yield* Effect.annotateCurrentSpan(OI.OUTPUT_VALUE, JSON.stringify(verdict))
    yield* Effect.annotateCurrentSpan(OI.OUTPUT_MIME, "application/json")

    const annotation = annotationFor(
      sessionId,
      traceId,
      definition,
      verdict,
      gate,
      options.rechecks,
      options.deferredFrom,
    )

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

/** The evaluator, run regardless of its trigger, as a recheck of an earlier failure. */
const obligation = (definition: EvalDefinition): EvalDefinition => {
  const always = { ...definition, applicability: { any: ["always"] } }

  return always.kind === "llm"
    ? {
        ...always,
        instructions: `${always.instructions}\n\nThis is a recheck: the transcript holds an earlier turn that failed this check, then a corrective turn. Pass only if the obligation is now met, considering both.`,
      }
    : always
}

/** For a judge, the failing turn followed by the correction; code and limits only see the correction. */
const recheckRecord = (
  runtime: EvalRuntime,
  sessionId: string,
  previous: AnnotationFile,
  record: TurnRecord,
): TurnRecord => {
  const deferred = previous.annotation.metadata?.["deferred_from"]

  const original = Schema.is(Schema.String)(deferred)
    ? backgroundOutcome(runtime, sessionId, deferred, previous.target.trace_id ?? "").record
    : turnRecord(runtime.store, sessionId, previous.target.trace_id ?? "")

  return {
    ...record,
    facts: `${record.facts} Rechecks failed result ${previous.id}: ${previous.annotation.explanation ?? ""}`,
    judged: `[failing turn]\n${original.judged ?? original.transcript}\n\n[corrective turn]\n${record.judged ?? record.transcript}`,
  }
}

type BackgroundRef = EndedSpan["context"]

/** Only background launches, including follow-ups that actually start a fresh runner. */
const backgroundLaunches = (store: Store, sessionId: string, traceId: string): Array<BackgroundRef> =>
  store
    .readTrace(sessionId, traceId)
    .ended.filter((span) => {
      if (kindOf(span) !== "TOOL") return false
      const metadata = readMetadata(span)

      return (
        metadata.job !== undefined ||
        (metadata.task !== undefined &&
          ((stringAttr(span, OI.TOOL_NAME) ?? span.name) === "delegate" ||
            metadata.task.started_runner === true))
      )
    })
    .map((span) => span.context)

const sameLaunch = (left: BackgroundRef, right: BackgroundRef): boolean =>
  left.trace_id === right.trace_id && left.span_id === right.span_id

/**
 * Root deliveries and observing TOOL deliveries are the completion boundary.
 * Raw job logs are never judge evidence.
 */
const backgroundOutcome = (runtime: EvalRuntime, sessionId: string, origin: string, traceId: string) => {
  const launches = backgroundLaunches(runtime.store, sessionId, origin)
  const view = loadSession(runtime.store, sessionId)
  const branch = branchTo(view, traceId)

  /** The root and tool spans of a turn that say they delivered a result. */
  const observers = (turn: TurnSummary): Array<SpanFile> => [
    turn.root,
    // A root lists what its tool calls observed, so only those traces need reading.
    ...((readMetadata(turn.root).observed_results ?? []).length === 0
      ? []
      : runtime.store.readTrace(sessionId, turn.trace_id).ended.filter((span) => kindOf(span) === "TOOL")),
  ]

  const deliveries = branch.flatMap((turn) =>
    observers(turn).flatMap((observer) =>
      (readMetadata(observer).delivers ?? [])
        .filter((delivery) => launches.some((launch) => sameLaunch(launch, delivery)))
        .map((delivery) => ({
          launch: linkedEvidence(runtime.store, {
            session_id: sessionId,
            trace_id: delivery.trace_id,
            span_id: delivery.span_id,
          }),
          result: delivery.result === undefined ? undefined : linkedEvidence(runtime.store, delivery.result),
          delivered_in: turn.trace_id,
          // Job results live in the delivery input; child reports have a direct result link too.
          input: truncate(stringAttr(observer, OI.INPUT_VALUE) ?? "", 8000),
          report: truncate(stringAttr(observer, OI.OUTPUT_VALUE) ?? "", 2000),
        })),
    ),
  )

  const undelivered = launches.filter(
    (launch) => !deliveries.some((delivery) => sameLaunch(launch, delivery.launch)),
  )

  // A result is delivered once per session. One that went to another branch never arrives on this one.
  const elsewhere =
    undelivered.length === 0
      ? []
      : view.turns
          .filter((turn) => !branch.includes(turn))
          .flatMap((turn) => observers(turn).flatMap((observer) => readMetadata(observer).delivers ?? []))

  const abandoned =
    undelivered.length > 0 &&
    undelivered.every((launch) => elsewhere.some((delivery) => sameLaunch(launch, delivery)))

  const waiting = undelivered.length > 0

  const original = turnRecord(runtime.store, sessionId, origin)
  const evidence = JSON.stringify(deliveries, null, 2)

  const record: TurnRecord = {
    ...original,
    judged: `[original launch turn]\n${original.judged ?? original.transcript}\n\n[delivered outcomes; context, not new initiations]\n${evidence}`,
    transcript: `${original.transcript}\n\n[delivered outcomes]\n${evidence}`,
  }

  return { waiting, abandoned, record }
}

interface BackgroundEvals {
  /** The turn being evaluated launched background work, so its own verdict waits for the outcome. */
  readonly defersCurrent: boolean
  readonly results: Effect.Effect<Array<AnnotationFile | undefined>>
}

/** One independent obligation per launch turn, recoverable solely from annotations and spans. */
const backgroundEvals = (
  runtime: EvalRuntime,
  sessionId: string,
  traceId: string,
  definition: LlmEval,
  record: TurnRecord,
): BackgroundEvals => {
  const branch = new Set(
    branchTo(loadSession(runtime.store, sessionId), traceId).map((turn) => turn.trace_id),
  )

  const latest = new Map<string, AnnotationFile>()

  for (const annotation of runtime.store.listAnnotations(sessionId)) {
    const origin = annotation.annotation.metadata?.["deferred_from"]

    if (
      annotation.annotation.name !== definition.name ||
      !branch.has(annotation.target.trace_id ?? "") ||
      !Schema.is(Schema.String)(origin) ||
      !branch.has(origin)
    )
      continue
    latest.set(origin, annotation)
  }

  const origins = [...latest].flatMap(([origin, annotation]) =>
    annotation.annotation.label === "pending" ? [origin] : [],
  )

  const launches = backgroundLaunches(runtime.store, sessionId, traceId)
  const applicable = applicabilityFor(definition.applicability, record).label !== "skipped"

  const defersCurrent = launches.length > 0 && applicable

  if (defersCurrent && !origins.includes(traceId)) origins.push(traceId)

  const results = Effect.forEach(origins, (origin) => {
    const outcome = backgroundOutcome(runtime, sessionId, origin, traceId)

    // Still waiting, and already recorded as waiting: another annotation and trace would say nothing new.
    if (outcome.waiting && !outcome.abandoned && origin !== traceId) return Effect.succeed(undefined)

    const settled = outcome.abandoned ? ABANDONED : outcome.waiting ? WAITING : undefined

    return runOne(runtime, sessionId, traceId, definition, outcome.record, { deferredFrom: origin, settled })
  })

  return { defersCurrent, results }
}

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
    Effect.forEach(
      definitions,
      (definition) => {
        // Outcome checks of earlier launch turns are settled as well as judging this turn, not instead of it.
        const background =
          definition.kind === "llm" && definition.wait_for_background === true
            ? backgroundEvals(runtime, sessionId, traceId, definition, record)
            : undefined

        if (background?.defersCurrent === true) return background.results

        const earlier = background?.results ?? Effect.succeed([])

        const branch = new Set(loadSession(runtime.store, sessionId).turns.map((turn) => turn.trace_id))

        const previous = runtime.store
          .listAnnotations(sessionId)
          .filter(
            (a) =>
              a.annotation.name === definition.name &&
              a.target.trace_id !== traceId &&
              branch.has(a.target.trace_id ?? "") &&
              a.annotation.label !== "skipped" &&
              a.annotation.label !== "pending",
          )
          .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]

        const skipped = applicabilityFor(definition.applicability, record).label === "skipped"

        // A failed result is an open obligation: a follow-up turn that would
        // be skipped (no new commit, say) is judged on whether it resolved it.
        if (skipped && previous !== undefined && failed(previous))
          return runOne(
            runtime,
            sessionId,
            traceId,
            obligation(definition),
            recheckRecord(runtime, sessionId, previous, record),
            { rechecks: previous.id },
          ).pipe(Effect.zipWith(earlier, (result, settled) => [...settled, result]))

        return runOne(runtime, sessionId, traceId, definition, record).pipe(
          Effect.zipWith(earlier, (result, settled) => [...settled, result]),
        )
      },
      { concurrency: 4 },
    ),
  )

  const annotations: Array<AnnotationFile> = []

  for (const [index, group] of results.entries()) {
    const definition = definitions[index]

    if (definition === undefined) continue

    for (const annotation of group) {
      if (annotation === undefined) continue
      annotations.push(annotation)

      if (definition.learn && failed(annotation)) {
        const origin = annotation.annotation.metadata?.["deferred_from"]

        const learnedRecord = Schema.is(Schema.String)(origin)
          ? backgroundOutcome(runtime, sessionId, origin, traceId).record
          : record

        await Effect.runPromise(learn(runtime, sessionId, cwd, definition, annotation, learnedRecord))
      }
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
