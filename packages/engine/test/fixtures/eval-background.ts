import { Match } from "effect"
import type { LlmEval } from "../../src/evals.ts"
import { type Delivery, type EndedSpan, OI, writeMetadata } from "../../src/format.ts"
import { newSpanId, newTraceId, nowNs, nsToIso } from "../../src/ids.ts"
import type { Store } from "../../src/store.ts"

export const outcomeCheck: LlmEval = {
  name: "tests_succeed",
  kind: "llm",
  description: "The delegated test command completed successfully.",
  instructions:
    "Pass only if the test command launched in the original turn completed successfully. A launch or promise is not success. A failed or canceled command fails. Judge the original launch and its delivered results, not new calls in the delivery turn.",
  wait_for_background: true,
  applicability: { any: ["tool:bash", "tool:delegate"] },
  choices: { pass: 1, fail: 0 },
  fail_labels: ["fail"],
  feedback: true,
  learn: false,
}

interface BackgroundTurn {
  readonly previous?: EndedSpan["context"] | null
  readonly launches?: ReadonlyArray<"job" | "task" | "steer" | "followup">
  readonly deliveries?: ReadonlyArray<Delivery>
  readonly observed?: ReadonlyArray<Delivery>
  readonly observationTool?: "job_status" | "job_kill"
  readonly input?: string
  readonly output?: string
}

/** Durable span fixture. No real processes, mutable job state, or unredacted logs. */
export class BackgroundFixture {
  readonly sessionId: string
  private readonly store: Store
  private previous: EndedSpan["context"] | null = null

  constructor(store: Store, cwd: string) {
    this.store = store
    this.sessionId = store.createSession(cwd).id
  }

  turn(options: BackgroundTurn = {}) {
    const traceId = newTraceId()
    const rootId = newSpanId()

    const root: EndedSpan = {
      name: "agent",
      context: { trace_id: traceId, span_id: rootId },
      parent_id: null,
      span_kind: "SPAN_KIND_INTERNAL",
      start_time: nsToIso(nowNs()),
      end_time: nsToIso(nowNs()),
      status_code: "OK",
      status_message: "",
      events: [],
      attributes: {
        [OI.SPAN_KIND]: "AGENT",
        [OI.SESSION_ID]: this.sessionId,
        [OI.INPUT_VALUE]: options.input ?? "Run the tests and verify success.",
        [OI.OUTPUT_VALUE]: options.output ?? "Waiting for verification.",
        [OI.METADATA]: writeMetadata(undefined, {
          previous: options.previous === undefined ? this.previous : options.previous,
          delivers: (options.deliveries ?? []).map((delivery) => ({ ...delivery, inbox_id: delivery.id })),
        }),
      },
    }

    this.store.endSpan(this.sessionId, root)
    this.previous = root.context
    const deliveries: Array<Delivery> = []

    for (const kind of options.launches ?? []) {
      const id = newSpanId()

      const name = Match.value(kind).pipe(
        Match.when("job", () => "bash"),
        Match.when("task", () => "delegate"),
        Match.orElse(() => "task_message"),
      )

      const metadata =
        kind === "job"
          ? { job: { id, log: "/never-read-raw-log", reason: "requested" as const } }
          : {
              task: {
                id,
                session_id: this.store.createSession("/fixture-child").id,
                started_runner: kind === "followup",
              },
            }

      const tool: EndedSpan = {
        ...root,
        name,
        context: { trace_id: traceId, span_id: id },
        parent_id: rootId,
        attributes: {
          [OI.SPAN_KIND]: "TOOL",
          [OI.SESSION_ID]: this.sessionId,
          [OI.TOOL_NAME]: name,
          [OI.INPUT_VALUE]:
            kind === "job"
              ? '{"command":"pnpm test","background":true}'
              : '{"prompt":"Run pnpm test and verify success."}',
          [OI.OUTPUT_VALUE]: "Background work started.",
          [OI.METADATA]: writeMetadata(undefined, metadata),
        },
      }

      this.store.endSpan(this.sessionId, tool)
      deliveries.push({ kind: kind === "job" ? "job" : "task", id, trace_id: traceId, span_id: id })
    }

    if ((options.observed?.length ?? 0) > 0) {
      const name = options.observationTool ?? "job_status"

      const observer: EndedSpan = {
        ...root,
        name,
        context: { trace_id: traceId, span_id: newSpanId() },
        parent_id: rootId,
        attributes: {
          [OI.SPAN_KIND]: "TOOL",
          [OI.SESSION_ID]: this.sessionId,
          [OI.TOOL_NAME]: name,
          [OI.INPUT_VALUE]: "Inspect the background job.",
          [OI.OUTPUT_VALUE]: options.output ?? "",
          [OI.METADATA]: writeMetadata(undefined, {
            delivers: (options.observed ?? []).map((delivery) => ({ ...delivery, inbox_id: delivery.id })),
          }),
        },
      }

      this.store.endSpan(this.sessionId, observer)
    }

    return { traceId, ref: root.context, deliveries }
  }
}
