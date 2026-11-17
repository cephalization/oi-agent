import { kindOf, readMetadata, type SpanFile } from "./format.ts"
import { isoToNs } from "./ids.ts"

/** Execution time, not approval latency. Older spans retain their inclusive duration. */
export const executionDurationMs = (span: SpanFile, untilMs: number): number => {
  let start = span.start_time

  if (kindOf(span) === "TOOL") {
    const executionStart = readMetadata(span).execution_started_at

    if (executionStart === null) return 0

    if (executionStart !== undefined) start = executionStart
  }

  return Math.max(0, Math.floor(untilMs) - Number(isoToNs(start) / 1_000_000n))
}
