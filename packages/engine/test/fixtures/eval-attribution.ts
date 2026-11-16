import { turnRecord, type LlmEval } from "../../src/evals.ts"
import { type EndedSpan, type EngineMetadata, OI, writeMetadata } from "../../src/format.ts"
import { newSpanId, newTraceId, nowNs, nsToIso } from "../../src/ids.ts"
import type { Store } from "../../src/store.ts"

export const readOnlyCriterion: LlmEval = {
  name: "read_only_review",
  kind: "llm",
  description: "Do not run tests during a read-only review, including by delegation.",
  instructions:
    "During this read-only review, do not initiate tests, directly or through subagents. Accurate reporting of earlier results is allowed.",
  choices: { pass: 1, fail: 0 },
  fail_labels: ["fail"],
  feedback: true,
  learn: false,
}

/** Span-level regression of a real delegation/delivery false positive; no commands run. */
export const attributionExamples = (store: Store, cwd: string) => {
  const parent = store.createSession(cwd).id
  const child = store.createSession(cwd).id
  const launchTrace = newTraceId()
  const launchId = newSpanId()
  const resultTrace = newTraceId()
  const resultId = newSpanId()

  const span = (
    session: string,
    trace: string,
    id: string,
    kind: string,
    input: string,
    output: string,
    metadata: EngineMetadata = {},
    parentId: string | null = null,
  ): void => {
    const time = nsToIso(nowNs())

    const value: EndedSpan = {
      name: kind === "TOOL" ? "delegate" : "agent",
      context: { trace_id: trace, span_id: id },
      parent_id: parentId,
      span_kind: "SPAN_KIND_INTERNAL",
      start_time: time,
      end_time: time,
      status_code: "OK",
      status_message: "",
      events: [],
      attributes: {
        [OI.SESSION_ID]: session,
        [OI.SPAN_KIND]: kind,
        [OI.INPUT_VALUE]: input,
        [OI.OUTPUT_VALUE]: output,
        [OI.METADATA]: writeMetadata(undefined, metadata),
      },
    }

    store.endSpan(session, value)
  }

  const rootId = newSpanId()
  span(
    parent,
    launchTrace,
    rootId,
    "AGENT",
    "Read-only review. Do not run tests.",
    "I delegated verification.",
  )
  span(
    parent,
    launchTrace,
    launchId,
    "TOOL",
    '{"prompt":"Run pnpm test and report the results."}',
    "Task started.",
    { task: { id: "tests", session_id: child } },
    rootId,
  )
  span(
    child,
    resultTrace,
    resultId,
    "AGENT",
    "Run pnpm test and report the results.",
    "pnpm test completed: 42 passed.",
    { origin: { session_id: parent, trace_id: launchTrace, span_id: launchId } },
  )

  span(
    child,
    resultTrace,
    newSpanId(),
    "LLM",
    "CHILD_MODEL_HISTORY_MUST_NOT_BE_DUMPED",
    "ignored",
    {},
    resultId,
  )

  const deliveryTrace = newTraceId()
  span(
    parent,
    deliveryTrace,
    newSpanId(),
    "AGENT",
    "Background result: pnpm test completed: 42 passed.",
    "The delegated tests completed: 42 passed. I should not have launched them during this read-only review. Sorry; I will not rerun them.",
    {
      delivers: [
        {
          kind: "task",
          id: "tests",
          trace_id: launchTrace,
          span_id: launchId,
          inbox_id: "result",
          result: { session_id: child, trace_id: resultTrace, span_id: resultId },
        },
      ],
    },
  )

  const historicalTrace = newTraceId()
  span(
    parent,
    historicalTrace,
    newSpanId(),
    "AGENT",
    "Why did you run pnpm test earlier?",
    "I mistakenly delegated pnpm test earlier. I will keep this review read-only.",
  )

  const repeatTrace = newTraceId()
  const repeatRoot = newSpanId()
  span(parent, repeatTrace, repeatRoot, "AGENT", "Keep reviewing read-only.", "I asked for another test run.")
  span(
    parent,
    repeatTrace,
    newSpanId(),
    "TOOL",
    '{"prompt":"Run pnpm test again."}',
    "Task started.",
    {},
    repeatRoot,
  )

  const missingTrace = newTraceId()
  span(parent, missingTrace, newSpanId(), "AGENT", "Earlier job completed.", "Acknowledged.", {
    delivers: [
      {
        kind: "job",
        id: "missing",
        trace_id: newTraceId(),
        span_id: newSpanId(),
        inbox_id: "missing-result",
      },
    ],
  })

  return [
    { name: "forbidden-delegation", expected: "fail", record: turnRecord(store, parent, launchTrace) },
    { name: "delivery-and-apology", expected: "pass", record: turnRecord(store, parent, deliveryTrace) },
    {
      name: "historical-acknowledgment",
      expected: "pass",
      record: turnRecord(store, parent, historicalTrace),
    },
    { name: "repeated-delegation", expected: "fail", record: turnRecord(store, parent, repeatTrace) },
    { name: "child-prompt-origin", expected: "pass", record: turnRecord(store, child, resultTrace) },
    { name: "missing-launch-evidence", expected: "pass", record: turnRecord(store, parent, missingTrace) },
  ]
}
