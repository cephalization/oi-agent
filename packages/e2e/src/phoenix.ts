/**
 * Phoenix for scenarios: whether one is running, a project name per run so
 * test data never mixes with real sessions, and a span per scenario that
 * the harness sends about itself.
 *
 * The scenario span carries the `session.id` of the first oi session it
 * drove, so Phoenix's session view shows the harness's verdict next to the
 * agent's own turns.
 */
import {
  encodeTraceRequest,
  type EndedSpan,
  newSpanId,
  newTraceId,
  nowNs,
  nsToIso,
  OI,
} from "@oi-agent/engine"

export const PHOENIX_ENDPOINT = process.env["OI_E2E_PHOENIX"] ?? "http://localhost:6006"

/** All scenario runs and the sessions they drive go to this project. */
export const PHOENIX_PROJECT = process.env["OI_E2E_PHOENIX_PROJECT"] ?? "oi-agent-e2e"

let reachable: boolean | undefined

export const phoenixUp = async (): Promise<boolean> => {
  if (reachable !== undefined) return reachable

  try {
    reachable = (await fetch(`${PHOENIX_ENDPOINT}/healthz`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    reachable = false
  }

  return reachable
}

export interface ScenarioRecord {
  readonly name: string
  readonly file: string
  readonly mode: string
  readonly startNs: bigint
  readonly sessionIds: ReadonlyArray<string>
  readonly error: string | undefined
  /** Notes the scenario added, such as scores. */
  readonly notes: ReadonlyArray<string>
  readonly sandbox: string
}

/** Send one `CHAIN` span describing a scenario run. Never fails the test. */
export const reportScenario = async (record: ScenarioRecord): Promise<void> => {
  if (process.env["OI_E2E_TRACE"] === "0" || !(await phoenixUp())) return

  const attributes = new Map<string, string>([
    [OI.SPAN_KIND, "CHAIN"],
    [OI.INPUT_VALUE, record.name],
    [OI.OUTPUT_VALUE, [record.error ?? "passed", ...record.notes].join("\n")],
    [
      OI.METADATA,
      JSON.stringify({
        oi_e2e: {
          file: record.file,
          mode: record.mode,
          sessions: record.sessionIds,
          sandbox: record.sandbox,
        },
      }),
    ],
  ])

  const [session] = record.sessionIds

  if (session !== undefined) attributes.set(OI.SESSION_ID, session)

  const span: EndedSpan = {
    name: `e2e: ${record.name}`,
    context: { trace_id: newTraceId(), span_id: newSpanId() },
    span_kind: "SPAN_KIND_INTERNAL",
    parent_id: null,
    start_time: nsToIso(record.startNs),
    end_time: nsToIso(nowNs()),
    status_code: record.error === undefined ? "OK" : "ERROR",
    status_message: record.error === undefined ? "" : (record.error.split("\n")[0] ?? ""),
    attributes: Object.fromEntries(attributes),
    events: [],
  }

  try {
    await fetch(`${PHOENIX_ENDPOINT}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: new Uint8Array(encodeTraceRequest([span], { project: PHOENIX_PROJECT, serviceName: "oi-e2e" })),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Reporting is a convenience; Phoenix being down must not fail a scenario.
  }
}
