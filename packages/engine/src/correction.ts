import { createHash } from "node:crypto"
import { Effect } from "effect"
import { type EngineMetadata, kindOf, OI, readMetadata, stringAttr, writeMetadata } from "./format.ts"
import type { Store } from "./store.ts"
import { diskTracer } from "./tracer.ts"

export type CorrectionCheckpoint = NonNullable<EngineMetadata["correction_checkpoint"]>

export type CorrectionStop = NonNullable<CorrectionCheckpoint["stop"]>

/** Only completed decisions can authorize a new turn. */
export const correctionAfter = (store: Store, sessionId: string, traceId: string) => {
  // Trace IDs sort by milliseconds, but within a millisecond their suffix is random.
  let latest: { state: CorrectionCheckpoint; ref: CorrectionCheckpoint["after"]; ended: string } | undefined

  for (const id of store.listTraceIds(sessionId).toReversed()) {
    if (id.slice(0, 12) < traceId.slice(0, 12)) break

    for (const span of store.readTraceRoots(sessionId, id).ended) {
      if (span.name !== "correction.decision") continue

      const state = readMetadata(span).correction_checkpoint

      if (state?.after.trace_id === traceId && (latest === undefined || latest.ended < span.end_time))
        latest = { state, ref: span.context, ended: span.end_time }
    }
  }

  return latest
}

export const recordCorrection = (store: Store, sessionId: string, state: CorrectionCheckpoint) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const span = yield* Effect.orDie(Effect.currentSpan)

      yield* Effect.annotateCurrentSpan(OI.OUTPUT_VALUE, state.stop ?? "continue")
      yield* Effect.annotateCurrentSpan(
        OI.METADATA,
        writeMetadata(undefined, { correction_checkpoint: state }),
      )

      return { trace_id: span.traceId, span_id: span.spanId }
    }).pipe(
      Effect.withSpan("correction.decision", { root: true, attributes: { [OI.SPAN_KIND]: "CHAIN" } }),
      Effect.withTracer(diskTracer(store, sessionId)),
    ),
  )

/** Consecutive identical failed obligations and recorded work are a stall, not progress. */
export const correctionEvidence = (store: Store, sessionId: string, state: CorrectionCheckpoint) => {
  const spans = store.readTrace(sessionId, state.after.trace_id).ended
  const root = spans.find((span) => span.context.span_id === state.after.span_id)
  const tools = spans.filter((span) => kindOf(span) === "TOOL")

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        state.obligations.filter((entry) => entry.latest !== undefined).map((entry) => entry.original),
        root === undefined ? "" : stringAttr(root, OI.OUTPUT_VALUE)?.trim(),
        tools.map((tool) => [tool.name, stringAttr(tool, OI.INPUT_VALUE), stringAttr(tool, OI.OUTPUT_VALUE)]),
      ]),
    )
    .digest("hex")

  return { fingerprint, denied: tools.some((tool) => readMetadata(tool).approval?.decision === "deny") }
}
