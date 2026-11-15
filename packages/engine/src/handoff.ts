import { handoffSeedFor } from "./fold.ts"
import {
  type EndedSpan,
  type EngineMetadata,
  OI,
  readMetadata,
  type SpanFile,
  stringAttr,
  writeMetadata,
} from "./format.ts"
import { newSpanId, newTraceId, nowNs, nsToIso, sessionIdForTrace } from "./ids.ts"
import { readMarker } from "./remote/storage.ts"
import type { Store } from "./store.ts"

/** Finish a committed handoff intent. Safe to repeat after any destination initialization write. */
export const completeHandoff = (
  store: Store,
  sourceSessionId: string,
  command: SpanFile,
): string | undefined => {
  const metadata = readMetadata(command)
  const destination = metadata.handoff_target

  if (metadata.operation !== "handoff" || destination !== sessionIdForTrace(command.context.trace_id))
    return undefined

  // A deliberately archived destination is not an interrupted initialization.
  if (readMarker(store, destination) !== undefined || handoffSeedFor(store, destination) !== undefined)
    return destination

  const brief = store.readTrace(sourceSessionId, command.context.trace_id).ended.find((span) => {
    const compaction = readMetadata(span).compaction

    // Older handoffs recorded the target but not a checkpoint ref on their root.
    const selected =
      metadata.checkpoint === undefined
        ? span.name === "context.compact"
        : span.context.span_id === metadata.checkpoint.span_id &&
          span.context.trace_id === metadata.checkpoint.trace_id

    return (
      selected &&
      span.parent_id === command.context.span_id &&
      span.status_code !== "ERROR" &&
      compaction?.source.trace_id === metadata.previous?.trace_id &&
      compaction?.source.span_id === metadata.previous?.span_id
    )
  })

  const summary = brief === undefined ? undefined : stringAttr(brief, OI.OUTPUT_VALUE)
  const query = stringAttr(command, OI.INPUT_VALUE)
  const header = store.readHeader(sourceSessionId)

  if (
    brief === undefined ||
    summary === undefined ||
    summary.trim() === "" ||
    query === undefined ||
    header === undefined
  )
    return undefined

  if (store.readHeader(destination) === undefined) store.createSession(header.cwd, destination)

  const seedMetadata: EngineMetadata = {
    handoff: { source_session_id: sourceSessionId, checkpoint: brief.context },
  }

  const workspace = metadata.workspace

  if (workspace !== undefined) seedMetadata.workspace = workspace

  const start = nsToIso(nowNs())

  const seed: EndedSpan = {
    name: "handoff.seed",
    context: { trace_id: newTraceId(), span_id: newSpanId() },
    span_kind: "SPAN_KIND_INTERNAL",
    parent_id: null,
    start_time: start,
    end_time: nsToIso(nowNs()),
    status_code: "OK",
    status_message: "",
    attributes: {
      [OI.SESSION_ID]: destination,
      [OI.SPAN_KIND]: "CHAIN",
      [OI.USER_ID]: stringAttr(command, OI.USER_ID) ?? "",
      [OI.INPUT_VALUE]: query,
      [OI.INPUT_MIME]: "text/plain",
      [OI.OUTPUT_VALUE]: summary,
      [OI.OUTPUT_MIME]: "text/plain",
      [OI.METADATA]: writeMetadata(undefined, seedMetadata),
    },
    events: [],
  }

  // Synchronous append: no model execution, no rewriting an old seed or command.
  store.endSpan(destination, seed)

  return destination
}

/** A destination header alone is not enough: recover its durable intent from the source spans. */
export const recoverHandoff = (store: Store, destination: string): void => {
  const timePrefix = destination.replaceAll("-", "").slice(0, 12)

  for (const sourceSessionId of store.listSessionIds()) {
    for (const traceId of store.listTraceIds(sourceSessionId).filter((id) => id.startsWith(timePrefix))) {
      const trace = store.readTraceRoots(sourceSessionId, traceId)
      const command = trace.ended[0] ?? trace.open[0]?.span

      if (command !== undefined && readMetadata(command).handoff_target === destination) {
        completeHandoff(store, sourceSessionId, command)

        return
      }
    }
  }
}
