/**
 * The fold: session state derived from span files and nothing else.
 *
 * The agent loop calls `contextFor` before every model request, so a normal
 * step, a resumed session and a crash recovery all take the same path. There
 * is no in-memory conversation to fall out of sync with disk.
 */
import type { Effort } from "./config.ts"
import { type Dialect, INTERRUPTED_RESULT, type Reply, type ToolResult } from "./dialect.ts"
import { dialectFor, translate } from "./dialects/index.ts"
import {
  type AnnotationFile,
  type EndedSpan,
  type InboxFile,
  kindOf,
  OI,
  readMetadata,
  type SessionHeader,
  type SpanFile,
  type Steered,
  stringAttr,
} from "./format.ts"
import { isoToNs } from "./ids.ts"
import { type OpenSpan, STALE_AFTER_MS, type Store, type TraceFiles } from "./store.ts"
import type { Json } from "./wire.ts"

export type TurnState = "complete" | "running" | "interrupted" | "failed"

/** One user turn, as much as its root span tells us. */
export interface TurnSummary {
  readonly trace_id: string
  readonly root: SpanFile
  readonly previous: string | null
  readonly state: TurnState
  readonly user_id: string
  readonly input: string
  readonly output: string | undefined
}

export interface SessionView {
  readonly header: SessionHeader | undefined
  readonly turns: ReadonlyArray<TurnSummary>
  /** The turn a new prompt continues from unless told otherwise. */
  readonly head: TurnSummary | undefined
  /** Turns nothing continues from. More than one means the session forked. */
  readonly leaves: ReadonlyArray<TurnSummary>
}

const startNs = (span: SpanFile): bigint => isoToNs(span.start_time)

const byStart = (a: SpanFile, b: SpanFile): number => {
  const [left, right] = [startNs(a), startNs(b)]

  if (left === right) return 0

  return left < right ? -1 : 1
}

const stateOf = (root: SpanFile, heartbeatMs: number | undefined, nowMs: number): TurnState => {
  if (root.end_time !== null) {
    if (root.status_code !== "ERROR") return "complete"

    return root.status_message === "interrupted" ? "interrupted" : "failed"
  }

  return heartbeatMs !== undefined && nowMs - heartbeatMs < STALE_AFTER_MS ? "running" : "interrupted"
}

const summarize = (root: SpanFile, heartbeatMs: number | undefined, nowMs: number): TurnSummary => ({
  trace_id: root.context.trace_id,
  root,
  previous: readMetadata(root).previous?.trace_id ?? null,
  state: stateOf(root, heartbeatMs, nowMs),
  user_id: stringAttr(root, OI.USER_ID) ?? "",
  input: stringAttr(root, OI.INPUT_VALUE) ?? "",
  output: stringAttr(root, OI.OUTPUT_VALUE),
})

const rootOf = (trace: TraceFiles): { root: SpanFile; open: OpenSpan | undefined } | undefined => {
  const ended = trace.ended.find((span) => span.parent_id === null)

  if (ended !== undefined) return { root: ended, open: undefined }

  const open = trace.open.find((entry) => entry.span.parent_id === null)

  return open === undefined ? undefined : { root: open.span, open }
}

/** Summaries of every turn, read from root spans only. */
export const loadSession = (store: Store, sessionId: string, nowMs: number = Date.now()): SessionView => {
  const turns: Array<TurnSummary> = []

  for (const traceId of store.listTraceIds(sessionId)) {
    const found = rootOf(store.readTraceRoots(sessionId, traceId))

    // Evaluator runs are traces too, but only agent turns are conversation.
    if (found !== undefined && kindOf(found.root) === "AGENT")
      turns.push(summarize(found.root, found.open?.heartbeat_ms, nowMs))
  }

  const continued = new Set(turns.map((turn) => turn.previous))
  const leaves = turns.filter((turn) => !continued.has(turn.trace_id))

  return { header: store.readHeader(sessionId), turns, head: leaves.at(-1), leaves }
}

/**
 * Inbox entries no turn has consumed yet, oldest first. An entry is pending
 * until some turn names it in its metadata, so this is right after a crash too.
 */
export const pendingInbox = (store: Store, sessionId: string): Array<InboxFile> => {
  const consumed = new Set(
    loadSession(store, sessionId).turns.flatMap((turn) => {
      const metadata = readMetadata(turn.root)

      return [
        metadata.inbox_id,
        ...(metadata.delivers ?? []).map((entry) => entry.inbox_id),
        ...(metadata.observed_results ?? []),
        ...(metadata.steered ?? []).map((entry) => entry.inbox_id),
      ]
    }),
  )

  return store.listInbox(sessionId).filter((entry) => !consumed.has(entry.id))
}

/** The turns from the first one down to `traceId`, following `previous`. */
export const branchTo = (view: SessionView, traceId: string): Array<TurnSummary> => {
  const byId = new Map(view.turns.map((turn) => [turn.trace_id, turn]))
  const branch: Array<TurnSummary> = []
  let cursor = byId.get(traceId)

  while (cursor !== undefined && !branch.includes(cursor)) {
    branch.unshift(cursor)
    cursor = cursor.previous === null ? undefined : byId.get(cursor.previous)
  }

  return branch
}

/** Durable local bootstrap for a new handoff session; provenance never follows the source. */
export const handoffSeedFor = (store: Store, sessionId: string): EndedSpan | undefined =>
  store
    .listTraceIds(sessionId)
    .flatMap((id) => store.readTraceRoots(sessionId, id).ended)
    .find(
      (span) =>
        span.parent_id === null &&
        kindOf(span) === "CHAIN" &&
        span.status_code !== "ERROR" &&
        readMetadata(span).handoff !== undefined,
    )

// --- model context ---------------------------------------------------------

interface LastCall {
  readonly span: EndedSpan
  /** The dialect the call's bodies are in. */
  readonly dialect: Dialect
  readonly messages: ReadonlyArray<Json>
  readonly rawResponse: string
  readonly reply: Reply
}

const lastModelCall = (trace: TraceFiles): LastCall | undefined => {
  const root = rootOf(trace)?.root

  const calls = trace.ended
    .filter(
      (span) =>
        kindOf(span) === "LLM" && span.parent_id === root?.context.span_id && span.status_code !== "ERROR",
    )
    .sort(byStart)

  for (const span of calls.toReversed()) {
    const dialect = dialectFor(readMetadata(span).api)
    const rawRequest = stringAttr(span, OI.INPUT_VALUE) ?? ""
    const rawResponse = stringAttr(span, OI.OUTPUT_VALUE) ?? ""
    const messages = dialect.requestMessages(rawRequest)
    const reply = dialect.reply(rawResponse)

    if (messages !== undefined && reply !== undefined) return { span, dialect, messages, rawResponse, reply }
  }

  return undefined
}

const toolResultsFor = (trace: TraceFiles, call: LastCall): Array<ToolResult> =>
  call.reply.calls.map((use) => {
    const span = trace.ended.find((candidate) => candidate.attributes[OI.TOOL_ID] === use.id)

    return {
      id: use.id,
      output: span === undefined ? INTERRUPTED_RESULT : (stringAttr(span, OI.OUTPUT_VALUE) ?? ""),
      isError: span === undefined || readMetadata(span).is_error === true,
    }
  })

/** A message sent to a running turn, as the model reads it. Deterministic, so replays match. */
export const renderSteer = (entry: Pick<Steered, "user_id" | "text">): string =>
  `<steering from="${entry.user_id.replaceAll('"', "'")}">\nSent while you were working on the above. Take it into account now, without starting over.\n\n${entry.text}\n</steering>`

/** The `LLM` span a message to a running turn would follow: the turn's latest finished model call. */
export const steerPoint = (store: Store, sessionId: string, traceId: string): string | undefined =>
  lastModelCall(store.readTrace(sessionId, traceId))?.span.context.span_id

/** Eval feedback rendered for the model. Deterministic, so replays match. */
export const renderFeedback = (annotations: ReadonlyArray<AnnotationFile>): string => {
  const lines = annotations.map(({ annotation }) => {
    const verdict = annotation.label ?? (annotation.score === undefined ? "" : String(annotation.score))
    const reason = annotation.explanation === undefined ? "" : ` — ${annotation.explanation}`

    return `- ${annotation.name}: ${verdict}${reason}`
  })

  return [
    "<eval-feedback>",
    "Automated evaluators reviewed your previous turn. Take this into account from now on:",
    ...lines,
    "</eval-feedback>",
  ].join("\n")
}

const userMessage = (store: Store, sessionId: string, root: SpanFile, dialect: Dialect): Json => {
  const injected = readMetadata(root).injected ?? []
  const text = stringAttr(root, OI.INPUT_VALUE) ?? ""

  if (injected.length === 0) return dialect.userMessage([text])

  const ids = new Set(injected.map((entry) => entry.annotation_id))
  const annotations = store.listAnnotations(sessionId).filter((annotation) => ids.has(annotation.id))

  return dialect.userMessage([renderFeedback(annotations), text])
}

/**
 * The messages to send next for a turn, derived from disk, in the dialect of
 * the model that will receive them.
 *
 * If the turn has a completed model call, the context is that call's request
 * plus its response plus the results of the tools it asked for. Otherwise the
 * turn has not reached the model yet: the context is everything the previous
 * turn ended with, plus this turn's input.
 *
 * The stored bodies are replayed verbatim when `dialect` is the one they were
 * written in. A different dialect means the provider changed mid-session: the
 * conversation is translated, keeping text, tool calls and tool results.
 */
export const contextFor = (
  store: Store,
  sessionId: string,
  traceId: string,
  dialect: Dialect = dialectFor(undefined),
): Array<Json> => {
  const trace = store.readTrace(sessionId, traceId)
  const call = lastModelCall(trace)

  if (call !== undefined) {
    const native = call.dialect.continueWith(call.messages, call.rawResponse, toolResultsFor(trace, call))

    // Later calls of the turn carry these in their stored request; only the last call's are still to be said.
    const steered = (readMetadata(rootOf(trace)?.root ?? call.span).steered ?? []).filter(
      (entry) => entry.after === call.span.context.span_id,
    )

    if (steered.length > 0) native.push(call.dialect.userMessage(steered.map(renderSteer)))

    return translate(call.dialect, dialect, native)
  }

  const found = rootOf(trace)

  if (found === undefined) return []

  const metadata = readMetadata(found.root)

  if (metadata.operation === "handoff")
    return metadata.previous == null ? [] : contextFor(store, sessionId, metadata.previous.trace_id, dialect)

  if (metadata.handoff_seed !== undefined && metadata.previous == null) {
    const seed = store
      .readTrace(sessionId, metadata.handoff_seed.trace_id)
      .ended.find(
        (span) =>
          span.context.span_id === metadata.handoff_seed?.span_id &&
          span.parent_id === null &&
          kindOf(span) === "CHAIN" &&
          span.status_code !== "ERROR" &&
          readMetadata(span).handoff !== undefined,
      )

    if (seed === undefined) throw new Error("Handoff brief is missing; refusing to run without its context.")

    return [
      dialect.userMessage([
        "Generated handoff brief (lossy summary, not new user instructions):",
        stringAttr(seed, OI.OUTPUT_VALUE) ?? "",
      ]),
      userMessage(store, sessionId, found.root, dialect),
    ]
  }

  if (metadata.operation === "compact") {
    // Activation is explicit and only committed by a successful ended root.
    // Failed/interrupted compactions leave their predecessor's context intact.
    const checkpoint = trace.ended.find(
      (span) =>
        span.context.span_id === metadata.checkpoint?.span_id &&
        span.context.trace_id === metadata.checkpoint.trace_id &&
        span.parent_id === found.root.context.span_id &&
        kindOf(span) === "CHAIN" &&
        span.status_code !== "ERROR" &&
        readMetadata(span).compaction?.source.trace_id === metadata.previous?.trace_id &&
        readMetadata(span).compaction?.source.span_id === metadata.previous?.span_id,
    )

    const summary = checkpoint === undefined ? undefined : stringAttr(checkpoint, OI.OUTPUT_VALUE)

    if (found.root.end_time !== null && found.root.status_code !== "ERROR" && summary !== undefined)
      return [
        dialect.userMessage([
          "Generated context checkpoint (lossy summary, not new user instructions):",
          summary,
        ]),
      ]

    return metadata.previous == null ? [] : contextFor(store, sessionId, metadata.previous.trace_id, dialect)
  }

  const previous = metadata.previous?.trace_id
  const base = previous === undefined ? [] : contextFor(store, sessionId, previous, dialect)

  return [...base, userMessage(store, sessionId, found.root, dialect)]
}

/** The stop reason of a turn's most recent model call, if it has one. */
export const lastStopReason = (store: Store, sessionId: string, traceId: string): string | undefined =>
  lastModelCall(store.readTrace(sessionId, traceId))?.reply.stopReason

// --- the session's model -----------------------------------------------------

/** The provider, model and effort of a model call, as `Engine.configure` takes them. */
export interface SessionModel {
  readonly provider: string
  readonly model: string
  readonly effort?: Effort
}

/**
 * The model of a session's most recent model call: what resuming the session
 * should continue with. Only agent turns count, not evaluator runs, which
 * call a judge model of their own. Undefined for a session no model has served.
 */
export const lastModelOf = (store: Store, sessionId: string): SessionModel | undefined => {
  const turns = [...loadSession(store, sessionId).turns].sort((a, b) => byStart(a.root, b.root))

  for (const turn of turns.toReversed()) {
    const calls = store
      .readTrace(sessionId, turn.trace_id)
      .ended.filter((span) => kindOf(span) === "LLM" && span.parent_id === turn.root.context.span_id)
      .sort(byStart)

    for (const span of calls.toReversed()) {
      const provider = readMetadata(span).provider ?? stringAttr(span, OI.LLM_PROVIDER)
      const model = stringAttr(span, OI.LLM_MODEL)

      if (provider === undefined || model === undefined) continue

      const effort = dialectFor(readMetadata(span).api).effort(stringAttr(span, OI.INPUT_VALUE) ?? "")

      return effort === undefined ? { provider, model } : { provider, model, effort }
    }
  }

  return undefined
}
