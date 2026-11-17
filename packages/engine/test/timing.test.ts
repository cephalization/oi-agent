import { describe, expect, it } from "vite-plus/test"
import { type SpanFile, OI, writeMetadata } from "../src/format.ts"
import { executionDurationMs } from "../src/timing.ts"

const start = "2026-11-01T10:00:00.000Z"
const executing = "2026-11-01T10:00:10.000Z"
const until = Date.parse("2026-11-01T10:00:12.000Z")

const span: SpanFile = {
  name: "bash",
  context: { trace_id: "trace", span_id: "span" },
  parent_id: null,
  span_kind: "SPAN_KIND_INTERNAL",
  start_time: start,
  end_time: null,
  status_code: "UNSET",
  status_message: "",
  events: [],
  attributes: { [OI.SPAN_KIND]: "TOOL" },
}

describe("execution duration", () => {
  it("excludes approval wait for open, ended and interrupted tools", () => {
    const tool = {
      ...span,
      attributes: {
        ...span.attributes,
        [OI.METADATA]: writeMetadata(undefined, { execution_started_at: executing }),
      },
    }

    expect(executionDurationMs(tool, until)).toBe(2000)
    expect(executionDurationMs({ ...tool, end_time: new Date(until).toISOString() }, until)).toBe(2000)
    expect(executionDurationMs(tool, Date.parse(executing) + 500)).toBe(500)
    expect(executionDurationMs(tool, Date.parse(start))).toBe(0)
  })

  it("counts no execution for waiting, denied or interrupted-before-execution calls", () => {
    const tool = {
      ...span,
      attributes: {
        ...span.attributes,
        [OI.METADATA]: writeMetadata(undefined, { execution_started_at: null }),
      },
    }

    expect(executionDurationMs(tool, until)).toBe(0)
    expect(executionDurationMs({ ...tool, end_time: new Date(until).toISOString() }, until)).toBe(0)
  })

  it("preserves inclusive latency for legacy tools and non-tool spans", () => {
    expect(executionDurationMs(span, until)).toBe(12000)
    expect(
      executionDurationMs(
        {
          ...span,
          attributes: {
            [OI.SPAN_KIND]: "AGENT",
            [OI.METADATA]: writeMetadata(undefined, { execution_started_at: executing }),
          },
        },
        until,
      ),
    ).toBe(12000)
  })
})
