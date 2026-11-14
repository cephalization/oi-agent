/**
 * Decision models (issue #12): a System One-compatible API, such as
 * TypeSafe's Jev (`POST /v1/systemone`), answers typed yes/no questions
 * about a state with calibrated probabilities instead of generated text.
 * oi asks it the small, frequent questions that do not need a full model
 * call: may this tool call run without asking, and is this prompt a durable
 * correction. Code sets the thresholds and acts on the answers.
 *
 * Each call is a `DECISION` span (OpenInference's span kind for decision
 * models) under the span that asked, with the exact request and response
 * bodies and `decision.*` attributes, never `llm.*` ones: the fold never
 * replays it, and its cost is reported apart from model cost.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Option, Schema } from "effect"
import { type AttrValue, type EndedSpan, OI, writeMetadata } from "./format.ts"
import { newSpanId, nowNs, nsToIso } from "./ids.ts"
import { Redactor } from "./redact.ts"
import type { Json } from "./wire.ts"

export const DecisionSettings = Schema.Struct({
  /** The API shape. Only System One for now. */
  kind: Schema.Literal("systemone"),
  /** The API root, for TypeSafe's service, a proxy or a self-hosted server. */
  base_url: Schema.String,
  /** The model to ask, for example `jev-latest`. */
  model: Schema.String,
})

export type DecisionSettings = typeof DecisionSettings.Type

export const DEFAULT_DECISION: DecisionSettings = {
  kind: "systemone",
  base_url: "https://api.typesafe.ai",
  model: "jev-latest",
}

/** The keychain account holding the decision service's key (`$TYPESAFE_API_KEY` overrides it). */
export const DECISION_ACCOUNT = "typesafe"

/** What a decision was for, recorded on its span. */
export type DecisionPurpose = "approval" | "steering"

/** A yes/no question; the answer is the probability of yes. */
export interface Noul {
  readonly type: "noul"
  readonly instructions: string
  readonly criteria: { readonly true: string; readonly false: string }
}

const SystemOneResponse = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    answers: Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.Literal("noul"),
        noul: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      }),
    ),
    usage: Schema.optionalKey(Schema.Struct({ input_tokens: Schema.Int, output_tokens: Schema.Int })),
  }),
)

const decodeResponse = Schema.decodeUnknownOption(SystemOneResponse)

/** One request to a decision model, answered or not. */
export interface DecisionCall {
  readonly purpose: DecisionPurpose
  readonly settings: DecisionSettings
  /** The exact request body sent. */
  readonly request: string
  /** The exact response body, or empty when none arrived. */
  readonly response: string
  /** The model that answered, as the response names it. */
  readonly model: string | undefined
  /** Probability of yes for each question that got one. */
  readonly nouls: ReadonlyMap<string, number>
  readonly input_tokens: number
  readonly output_tokens: number
  readonly start_ns: bigint
  readonly end_ns: bigint
  /** Why there are no answers, when there are none. */
  readonly error?: string
}

const DECISION_TIMEOUT_MS = 20_000

/**
 * Ask a System One server every question at once about one state. Never
 * throws: a failure comes back as a call with `error` set and no answers,
 * and every caller then does what it would without a decision model.
 */
export const askDecision = async (
  settings: DecisionSettings,
  apiKey: string,
  purpose: DecisionPurpose,
  state: Json,
  questions: ReadonlyMap<string, Noul>,
  redactor: Redactor = new Redactor(),
): Promise<DecisionCall> => {
  redactor.add(apiKey)

  const request = redactor.scrub(
    JSON.stringify({ model: settings.model, state, questions: Object.fromEntries(questions) }),
  )

  const start = nowNs()

  const failed = (error: string, response = ""): DecisionCall => ({
    purpose,
    settings,
    request,
    response,
    model: undefined,
    nouls: new Map(),
    input_tokens: 0,
    output_tokens: 0,
    start_ns: start,
    end_ns: nowNs(),
    error,
  })

  let status: number
  let body: string

  try {
    const reply = await fetch(`${settings.base_url.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: request,
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    })

    status = reply.status
    body = redactor.scrub(await reply.text())
  } catch (error) {
    return failed(redactor.scrub(error instanceof Error ? error.message : String(error)))
  }

  if (status < 200 || status >= 300) return failed(`the decision model answered HTTP ${status}`, body)

  return Option.match(decodeResponse(body), {
    onNone: () => failed("the decision model's answer was not in the System One shape", body),
    onSome: (parsed) => {
      const nouls = new Map<string, number>()

      for (const [name, answer] of Object.entries(parsed.answers))
        if (answer.noul !== undefined) nouls.set(name, answer.noul)

      return {
        purpose,
        settings,
        request,
        response: body,
        model: parsed.model,
        nouls,
        input_tokens: parsed.usage?.input_tokens ?? 0,
        output_tokens: parsed.usage?.output_tokens ?? 0,
        start_ns: start,
        end_ns: nowNs(),
      }
    },
  })
}

/** Who hosts a decision model, from its URL: `typesafe` for TypeSafe's service, else the host name. */
const providerOf = (settings: DecisionSettings): string => {
  try {
    const host = new URL(settings.base_url).hostname

    return host === "typesafe.ai" || host.endsWith(".typesafe.ai") ? "typesafe" : host
  } catch {
    return "unknown"
  }
}

/** The attribute names of the OpenInference decision span spec. */
export const DECISION_ATTR = {
  SYSTEM: "decision.system",
  PROVIDER: "decision.provider",
  REQUEST_MODEL: "decision.request.model_name",
  RESPONSE_MODEL: "decision.response.model_name",
  MODEL: "decision.model_name",
  TOKENS_INPUT: "decision.token_count.input",
  TOKENS_OUTPUT: "decision.token_count.output",
} as const

/** A `DECISION` span for a call, under `parent`. */
export const decisionSpan = (
  sessionId: string,
  parent: { readonly traceId: string; readonly spanId: string },
  call: DecisionCall,
): EndedSpan => {
  const attributes = new Map<string, AttrValue>([
    [OI.SESSION_ID, sessionId],
    [OI.SPAN_KIND, "DECISION"],
    // `typesafe` names the API shape (/v1/systemone), whoever serves it.
    [DECISION_ATTR.SYSTEM, "typesafe"],
    [DECISION_ATTR.PROVIDER, providerOf(call.settings)],
    [DECISION_ATTR.REQUEST_MODEL, call.settings.model],
    [DECISION_ATTR.TOKENS_INPUT, call.input_tokens],
    [DECISION_ATTR.TOKENS_OUTPUT, call.output_tokens],
    [OI.INPUT_VALUE, call.request],
    [OI.INPUT_MIME, "application/json"],
    [OI.METADATA, writeMetadata(undefined, { purpose: call.purpose })],
  ])

  if (call.model !== undefined) {
    attributes.set(DECISION_ATTR.RESPONSE_MODEL, call.model)
    attributes.set(DECISION_ATTR.MODEL, call.model)
  }

  if (call.response !== "") {
    attributes.set(OI.OUTPUT_VALUE, call.response)
    attributes.set(OI.OUTPUT_MIME, "application/json")
  }

  return {
    name: `decision ${call.purpose}`,
    context: { trace_id: parent.traceId, span_id: newSpanId() },
    span_kind: "SPAN_KIND_INTERNAL",
    parent_id: parent.spanId,
    start_time: nsToIso(call.start_ns),
    end_time: nsToIso(call.end_ns),
    status_code: call.error === undefined ? "OK" : "ERROR",
    status_message: call.error ?? "",
    events: [],
    attributes: Object.fromEntries(attributes),
  }
}

// --- auto approvals --------------------------------------------------------

/** The questions asked about a tool call. Each is a Noul: the probability that it is true. */
export const APPROVAL_QUESTIONS: ReadonlyMap<string, Noul> = new Map([
  [
    "irreversible",
    {
      type: "noul",
      instructions:
        "Would running this tool call destroy or overwrite data that neither git nor the user could easily recover?",
      criteria: {
        true: "It deletes, overwrites or corrupts data that is not tracked by git or otherwise recoverable.",
        false: "Its effects are harmless, confined to tracked files, or easy to undo.",
      },
    },
  ],
  [
    "outside_workspace",
    {
      type: "noul",
      instructions:
        "Does this tool call write outside the working directory, change an external system, or transmit workspace/private data to a remote destination? Requested read-only queries of an intended service do not count as external changes just because they use the network.",
      criteria: {
        true: "It writes outside the working directory, changes remote or system state, or uploads private/workspace data.",
        false:
          "Its changes stay inside the working directory, or it only reads the service the user asked about using ordinary client authentication.",
      },
    },
  ],
  [
    "exposes_secrets",
    {
      type: "noul",
      instructions:
        "Could this tool call reveal credentials, keys or tokens in output or files, or send them to an unintended recipient? Ordinary authentication by a client to its intended service is not secret exposure.",
      criteria: {
        true: "It could reveal or transmit a secret.",
        false:
          "It does not reveal secrets. It may use stored credentials for ordinary authentication to the intended service without printing or copying them.",
      },
    },
  ],
  [
    "requested",
    {
      type: "noul",
      instructions:
        "Is this tool call what the user asked for in their latest prompt, or a direct step toward it?",
      criteria: {
        true: "It does what the user asked, or is plainly needed to do it.",
        false: "It goes beyond or against what the user asked.",
      },
    },
  ],
])

/**
 * Allow only when every answer is on the safe side of its threshold:
 * `max` for the risks, `min` for whether it was asked for. Anything else,
 * including a missing answer, goes to the human.
 */
export const APPROVAL_THRESHOLDS: ReadonlyMap<string, { readonly max?: number; readonly min?: number }> =
  new Map([
    ["irreversible", { max: 0.1 }],
    ["outside_workspace", { max: 0.2 }],
    ["exposes_secrets", { max: 0.1 }],
    ["requested", { min: 0.8 }],
  ])

/** Whether a decision model's answers clear every approval threshold. */
export const clearsThresholds = (nouls: ReadonlyMap<string, number>): boolean =>
  [...APPROVAL_THRESHOLDS].every(([name, { max, min }]) => {
    const value = nouls.get(name)

    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 1) return false

    return (max === undefined || value < max) && (min === undefined || value > min)
  })

/** The failed approval thresholds, for the human prompt and the recorded reason. */
export const approvalConcerns = (nouls: ReadonlyMap<string, number>): Array<string> =>
  [...APPROVAL_THRESHOLDS].flatMap(([name, { max, min }]) => {
    const value = nouls.get(name)

    if (value === undefined) return [`${name}: no answer`]

    if (!Number.isFinite(value) || value < 0 || value > 1) return [`${name}: invalid probability`]

    if (max !== undefined && value >= max) return [`${name}=${value.toFixed(2)} (needs < ${max.toFixed(2)})`]

    if (min !== undefined && value <= min) return [`${name}=${value.toFixed(2)} (needs > ${min.toFixed(2)})`]

    return []
  })

const BashInput = Schema.Struct({ command: Schema.String })
const PathInput = Schema.Struct({ path: Schema.String })
const decodeBash = Schema.decodeUnknownOption(BashInput)
const decodePath = Schema.decodeUnknownOption(PathInput)

/** Commands that always go to the human in auto mode, whatever a decision model says. */
const ALWAYS_ASK: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /\bgit\s+push\b[^\n;&|]*\s(?:--force|--force-with-lease|-f)\b/, reason: "a force push" },
  { pattern: /\bsudo\b/, reason: "sudo" },
  { pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-\S*f)/, reason: "discarding uncommitted work" },
]

/** A target that is not inside the working directory: absolute, in the home directory, or above. */
const OUTSIDE = /^["']?(?:\/|~|\$HOME|\$\{HOME\}|\.\.(?:\/|$))/

/** Whether a command runs `rm` with both recursive and force on something outside the working directory. */
export const deletesOutside = (command: string): boolean =>
  command.split(/[;&|\n]+/).some((segment) => {
    const words = segment.trim().split(/\s+/)
    const at = words.indexOf("rm")

    if (at === -1) return false

    const args = words.slice(at + 1)
    const flags = args.filter((word) => word.startsWith("-"))
    const short = flags.filter((flag) => !flag.startsWith("--")).join("")
    const recursive = /[rR]/.test(short) || flags.includes("--recursive")
    const force = short.includes("f") || flags.includes("--force")

    return recursive && force && args.some((word) => !word.startsWith("-") && OUTSIDE.test(word))
  })

/**
 * Why a tool call must be asked about even in auto mode, or undefined when a
 * decision model may approve it. These rules are code, so no answer from a
 * model can override them.
 */
export const mustAsk = (tool: string, input: Json, cwd: string): string | undefined => {
  if (tool === "bash")
    return Option.match(decodeBash(input), {
      onNone: () => "the command could not be read",
      onSome: ({ command }) =>
        deletesOutside(command)
          ? "a recursive forced delete outside the working directory"
          : ALWAYS_ASK.find((rule) => rule.pattern.test(command))?.reason,
    })

  return Option.match(decodePath(input), {
    onNone: () => undefined,
    onSome: ({ path: target }) => {
      const root = realPath(path.resolve(cwd))
      const resolved = realPath(path.resolve(cwd, target))

      return resolved === root || resolved.startsWith(`${root}${path.sep}`)
        ? undefined
        : "a write outside the working directory"
    },
  })
}

/** Resolve existing symlinks, even when the file being created does not exist yet. */
const realPath = (target: string): string => {
  try {
    return fs.realpathSync(target)
  } catch {
    const parent = path.dirname(target)

    return parent === target ? target : path.join(realPath(parent), path.basename(target))
  }
}
