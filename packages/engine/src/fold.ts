/**
 * The fold: session state derived from span files and nothing else.
 *
 * The agent loop calls `contextFor` before every model request, so a normal
 * step, a resumed session and a crash recovery all take the same path. There
 * is no in-memory conversation to fall out of sync with disk.
 */
import { Option } from "effect"
import {
  type AnnotationFile,
  type EndedSpan,
  kindOf,
  OI,
  readMetadata,
  type SessionHeader,
  type SpanFile,
  stringAttr,
} from "./format.ts"
import { isoToNs } from "./ids.ts"
import { type OpenSpan, STALE_AFTER_MS, type Store, type TraceFiles } from "./store.ts"
import { type Json, parseRequest, parseResponse, type ResponseBody, toolUses } from "./wire.ts"

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

const INTERRUPTED_RESULT = "This tool call was interrupted before it completed. Its effects are unknown."

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

    if (found !== undefined) turns.push(summarize(found.root, found.open?.heartbeat_ms, nowMs))
  }

  const continued = new Set(turns.map((turn) => turn.previous))
  const leaves = turns.filter((turn) => !continued.has(turn.trace_id))

  return { header: store.readHeader(sessionId), turns, head: leaves.at(-1), leaves }
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

// --- model context ---------------------------------------------------------

interface LastCall {
  readonly span: EndedSpan
  readonly messages: ReadonlyArray<Json>
  readonly response: ResponseBody
}

const lastModelCall = (trace: TraceFiles): LastCall | undefined => {
  const calls = trace.ended
    .filter((span) => kindOf(span) === "LLM" && span.status_code !== "ERROR")
    .sort(byStart)

  for (const span of calls.toReversed()) {
    const request = Option.getOrUndefined(parseRequest(span.attributes[OI.INPUT_VALUE]))
    const response = Option.getOrUndefined(parseResponse(span.attributes[OI.OUTPUT_VALUE]))

    if (request !== undefined && response !== undefined) return { span, messages: request.messages, response }
  }

  return undefined
}

const toolResultsFor = (trace: TraceFiles, call: LastCall): Array<Json> => {
  const results: Array<Json> = []

  for (const use of toolUses(call.response.content)) {
    const span = trace.ended.find((candidate) => candidate.attributes[OI.TOOL_ID] === use.id)

    results.push({
      type: "tool_result",
      tool_use_id: use.id,
      content: span === undefined ? INTERRUPTED_RESULT : (stringAttr(span, OI.OUTPUT_VALUE) ?? ""),
      is_error: span === undefined || readMetadata(span).is_error === true,
    })
  }

  return results
}

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

const userMessage = (store: Store, sessionId: string, root: SpanFile): Json => {
  const injected = readMetadata(root).injected ?? []
  const text = stringAttr(root, OI.INPUT_VALUE) ?? ""

  if (injected.length === 0) return { role: "user", content: text }

  const ids = new Set(injected.map((entry) => entry.annotation_id))
  const annotations = store.listAnnotations(sessionId).filter((annotation) => ids.has(annotation.id))

  return {
    role: "user",
    content: [
      { type: "text", text: renderFeedback(annotations) },
      { type: "text", text },
    ],
  }
}

/**
 * The messages to send next for a turn, derived from disk.
 *
 * If the turn has a completed model call, the context is that call's request
 * plus its response plus the results of the tools it asked for. Otherwise the
 * turn has not reached the model yet: the context is everything the previous
 * turn ended with, plus this turn's input.
 */
export const contextFor = (store: Store, sessionId: string, traceId: string): Array<Json> => {
  const trace = store.readTrace(sessionId, traceId)
  const call = lastModelCall(trace)

  if (call !== undefined) {
    const messages = [...call.messages]
    const results = toolResultsFor(trace, call)

    if (call.response.content.length > 0)
      messages.push({ role: "assistant", content: [...call.response.content] })

    if (results.length > 0) messages.push({ role: "user", content: results })

    return messages
  }

  const found = rootOf(trace)

  if (found === undefined) return []

  const previous = readMetadata(found.root).previous?.trace_id
  const base = previous === undefined ? [] : contextFor(store, sessionId, previous)

  return [...base, userMessage(store, sessionId, found.root)]
}

/** The stop reason of a turn's most recent model call, if it has one. */
export const lastStopReason = (store: Store, sessionId: string, traceId: string): string | undefined =>
  lastModelCall(store.readTrace(sessionId, traceId))?.response.stop_reason ?? undefined
