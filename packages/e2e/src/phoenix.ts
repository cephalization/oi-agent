/**
 * Phoenix for scenarios: whether one is running, a project name per run so
 * test data never mixes with real sessions, and a span per scenario that
 * the harness sends about itself.
 *
 * The scenario span carries the `session.id` of the first oi session it
 * drove, so Phoenix's session view shows the harness's verdict next to the
 * agent's own turns.
 */
import { Schema } from "effect"
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
  readonly results: ReadonlyArray<Schema.Json>
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
          results: record.results,
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

// --- a Phoenix that asks for a login ----------------------------------------------

/**
 * A second Phoenix, started with `PHOENIX_ENABLE_AUTH=true`, for the scenarios
 * about logging in (see the README). Its admin is the account the scenarios
 * log in as.
 */
export const PHOENIX_AUTH_ENDPOINT = process.env["OI_E2E_PHOENIX_AUTH"] ?? "http://localhost:6007"

const ADMIN = {
  email: process.env["OI_E2E_PHOENIX_AUTH_EMAIL"] ?? "admin@localhost",
  password: process.env["OI_E2E_PHOENIX_AUTH_PASSWORD"] ?? "",
}

/** The cookies of a logged-in browser session, or undefined when the server or the password is not there. */
const signIn = async (): Promise<string | undefined> => {
  try {
    const response = await fetch(`${PHOENIX_AUTH_ENDPOINT}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
      signal: AbortSignal.timeout(5000),
    })

    return response.ok
      ? response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; ")
      : undefined
  } catch {
    return undefined
  }
}

let authReachable: Promise<boolean> | undefined

export const phoenixAuthUp = (): Promise<boolean> => {
  authReachable ??= signIn().then((cookies) => cookies !== undefined)

  return authReachable
}

const Decision = Schema.Struct({ redirect_to: Schema.String })

/**
 * Be the browser: log in as the admin, then approve (or refuse) what the
 * authorize URL asks for on Phoenix's consent page, and follow the redirect
 * back to the machine that asked. With `deliver: false` the redirect is
 * returned without being followed, as for a browser that cannot reach oi.
 */
export const answerLogin = async (
  authorizeUrl: string,
  options: { readonly approved?: boolean; readonly deliver?: boolean } = {},
): Promise<string> => {
  const cookies = await signIn()

  if (cookies === undefined) throw new Error(`Could not log in to Phoenix at ${PHOENIX_AUTH_ENDPOINT}.`)

  const asked = new URL(authorizeUrl).searchParams

  const response = await fetch(`${PHOENIX_AUTH_ENDPOINT}/oauth2/authorize/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookies, origin: PHOENIX_AUTH_ENDPOINT },
    body: JSON.stringify({
      client_id: asked.get("client_id"),
      redirect_uri: asked.get("redirect_uri"),
      state: asked.get("state"),
      code_challenge: asked.get("code_challenge"),
      code_challenge_method: asked.get("code_challenge_method"),
      response_type: asked.get("response_type"),
      approved: options.approved ?? true,
    }),
  })

  if (!response.ok)
    throw new Error(`Phoenix refused the consent decision: HTTP ${response.status} ${await response.text()}`)

  const { redirect_to } = Schema.decodeUnknownSync(Decision)(await response.json())

  if (options.deliver !== false) await fetch(redirect_to)

  return redirect_to
}

const SpanList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ context: Schema.Struct({ span_id: Schema.String }) })),
})

/** The span ids a Phoenix project holds, read with an API key when the server asks for one. */
export const spanIdsIn = async (
  endpoint: string,
  project: string,
  apiKey?: string,
): Promise<Array<string>> => {
  const headers = new Headers()

  if (apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`)

  const response = await fetch(`${endpoint}/v1/projects/${encodeURIComponent(project)}/spans?limit=1000`, {
    headers,
  })

  if (!response.ok) return []

  return Schema.decodeUnknownSync(SpanList)(await response.json()).data.map((span) => span.context.span_id)
}
