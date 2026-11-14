/**
 * Queries over the span files a sandboxed CLI wrote. Spans are oi's only
 * state, so they are also the test oracle: scenarios assert on what the
 * agent did (which model served a turn, which tools ran, what the system
 * prompt held) rather than on what a model happened to say.
 */
import { setTimeout as sleep } from "node:timers/promises"
import {
  type EndedSpan,
  isoToNs,
  kindOf,
  loadSession,
  OI,
  readMetadata,
  type SpanFile,
  type SpanKind,
  STALE_AFTER_MS,
  Store,
  stringAttr,
  type TurnSummary,
} from "@oi-agent/engine"
import { Option, Schema } from "effect"

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
const decodeObject = Schema.decodeUnknownOption(JsonObject)

/** A JSON attribute (request bodies, invocation parameters) as an object; empty when absent. */
const jsonAttr = (span: SpanFile, key: string): ReadonlyMap<string, Schema.Json> =>
  new Map(Object.entries(Option.getOrElse(decodeObject(span.attributes[key]), () => ({}))))

const SystemBlocks = Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))
const decodeSystemBlocks = Schema.decodeUnknownOption(SystemBlocks)
const decodeString = Schema.decodeUnknownOption(Schema.String)

const EffortHolder = Schema.Struct({ effort: Schema.optionalKey(Schema.String) })
const decodeEffortHolder = Schema.decodeUnknownOption(EffortHolder)

const byStart = (a: SpanFile, b: SpanFile): number => {
  const [left, right] = [isoToNs(a.start_time), isoToNs(b.start_time)]

  if (left === right) return 0

  return left < right ? -1 : 1
}

const clip = (text: string, max = 80): string => {
  const flat = text.replaceAll(/\s+/g, " ").trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A model call as the tests care about it. */
export interface ModelUse {
  /** `provider/model`, as `-m` takes it. */
  readonly model: string
  readonly effort: string | undefined
}

/** A tool call: its name, and the raw `input.value` and `output.value`. */
export interface ToolCall {
  readonly name: string
  readonly input: string
  readonly output: string
  readonly span: EndedSpan
}

export class Spans {
  readonly store: Store

  constructor(home: string) {
    this.store = new Store(home)
  }

  sessions(): Array<string> {
    return this.store.listSessionIds()
  }

  /** The only session, failing when there is not exactly one. */
  onlySession(): string {
    const ids = this.sessions()

    if (ids.length !== 1) throw new Error(`Expected one session, found ${ids.length}: ${ids.join(", ")}`)

    return ids[0] ?? ""
  }

  /** Agent turns, oldest first. */
  turns(sessionId: string): ReadonlyArray<TurnSummary> {
    return loadSession(this.store, sessionId).turns
  }

  /** Every ended span of a session, oldest first. */
  ended(sessionId: string): Array<EndedSpan> {
    return this.store
      .listTraceIds(sessionId)
      .flatMap((traceId) => this.store.readTrace(sessionId, traceId).ended)
      .sort(byStart)
  }

  /** Spans still in flight (`.open.json` with no ended file). */
  open(sessionId: string): Array<SpanFile> {
    return this.store
      .listTraceIds(sessionId)
      .flatMap((traceId) => this.store.readTrace(sessionId, traceId).open.map((entry) => entry.span))
  }

  /**
   * Ended spans of the agent's own turns, oldest first. Evaluator and
   * steering traces are left out: they call a judge model of their own.
   */
  agent(sessionId: string): Array<EndedSpan> {
    return this.turns(sessionId)
      .flatMap((turn) => this.store.readTrace(sessionId, turn.trace_id).ended)
      .sort(byStart)
  }

  /** Spans of one kind in the agent's turns. */
  ofKind(sessionId: string, kind: SpanKind): Array<EndedSpan> {
    return this.agent(sessionId).filter((span) => kindOf(span) === kind)
  }

  /** Ended spans of one turn (trace), oldest first. */
  trace(sessionId: string, traceId: string): Array<EndedSpan> {
    return [...this.store.readTrace(sessionId, traceId).ended].sort(byStart)
  }

  /** Which model served an `LLM` span, and at what effort. */
  modelOf(span: SpanFile): ModelUse {
    const provider = readMetadata(span).provider ?? stringAttr(span, OI.LLM_PROVIDER) ?? "?"
    const model = stringAttr(span, OI.LLM_MODEL) ?? "?"
    const params = jsonAttr(span, OI.LLM_INVOCATION_PARAMETERS)

    // Anthropic: output_config.effort; OpenAI Responses: reasoning.effort.
    const holder = params.get("output_config") ?? params.get("reasoning")
    const effort = Option.getOrUndefined(decodeEffortHolder(holder))?.effort

    return { model: `${provider}/${model}`, effort }
  }

  /** The model that served the agent's most recent model call. */
  lastModel(sessionId: string): ModelUse | undefined {
    const last = this.ofKind(sessionId, "LLM").at(-1)

    return last === undefined ? undefined : this.modelOf(last)
  }

  /** The system prompt an `LLM` span sent, from its stored request body. */
  systemPrompt(span: SpanFile): string {
    const body = jsonAttr(span, OI.INPUT_VALUE)
    const system = body.get("system") ?? body.get("instructions")

    const blocks = Option.getOrUndefined(decodeSystemBlocks(system))

    if (blocks !== undefined) return blocks.map((block) => block.text ?? "").join("\n")

    return Option.getOrElse(decodeString(system), () => "")
  }

  /** Tool calls in order. */
  tools(sessionId: string): Array<ToolCall> {
    return this.ofKind(sessionId, "TOOL").map((span) => ({
      name: stringAttr(span, OI.TOOL_NAME) ?? span.name,
      input: stringAttr(span, OI.INPUT_VALUE) ?? "",
      output: stringAttr(span, OI.OUTPUT_VALUE) ?? "",
      span,
    }))
  }

  /** In-flight tool calls waiting for an approval, in turns that are still alive. */
  waiting(sessionId: string): Array<SpanFile> {
    const now = Date.now()

    return this.store
      .listTraceIds(sessionId)
      .flatMap((traceId) => this.store.readTrace(sessionId, traceId).open)
      .filter((entry) => now - entry.heartbeat_ms < STALE_AFTER_MS)
      .map((entry) => entry.span)
      .filter((span) => readMetadata(span).awaiting_approval === true)
  }

  /** The process that owns a session's in-flight turn, from its root span's metadata. */
  ownerPid(sessionId: string): number | undefined {
    const root = this.open(sessionId).find((span) => span.parent_id === null)

    return root === undefined ? undefined : readMetadata(root).pid
  }

  /** Poll until `check` returns a value, or fail after `timeoutMs` with a summary of the session tree. */
  async waitFor<T>(
    what: string,
    check: () => T | undefined | Promise<T | undefined>,
    timeoutMs = 90_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const value = await check()

      if (value !== undefined) return value

      await sleep(250)
    }

    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.\n${this.summary()}`)
  }

  /**
   * Wait until a session has `count` turns that are no longer running.
   * A tool call left waiting for approval for `approvalGraceMs` fails at
   * once, since nothing will answer it while the caller waits here.
   */
  async settledTurns(
    sessionId: string,
    count: number,
    timeoutMs = 120_000,
    approvalGraceMs = 10_000,
  ): Promise<ReadonlyArray<TurnSummary>> {
    const waitingSince = new Map<string, number>()

    return this.waitFor(
      `${count} finished turn(s) in ${sessionId}`,
      () => {
        for (const span of this.waiting(sessionId)) {
          const since = waitingSince.get(span.context.span_id) ?? Date.now()

          waitingSince.set(span.context.span_id, since)

          if (Date.now() - since > approvalGraceMs)
            throw new Error(
              `A ${stringAttr(span, OI.TOOL_NAME) ?? span.name} call is waiting for approval, ` +
                `and nothing in the scenario answers it: ${clip(stringAttr(span, OI.INPUT_VALUE) ?? "", 120)}\n${this.summary()}`,
            )
        }

        const turns = this.turns(sessionId)
        const settled = turns.filter((turn) => turn.state !== "running")

        return settled.length >= count && settled.length === turns.length ? turns : undefined
      },
      timeoutMs,
    )
  }

  /** A compact, human-readable outline of every session, for failure messages. */
  summary(): string {
    const lines: Array<string> = []

    for (const sessionId of this.sessions()) {
      lines.push(`session ${sessionId}`)

      for (const turn of this.turns(sessionId)) {
        lines.push(`  turn ${turn.trace_id.slice(0, 8)} [${turn.state}] ${clip(turn.input, 60)}`)

        for (const span of this.trace(sessionId, turn.trace_id)) {
          const kind = kindOf(span)

          if (kind === "LLM") {
            const use = this.modelOf(span)

            lines.push(
              `    LLM ${use.model}${use.effort === undefined ? "" : ` (${use.effort})`} ${span.status_code}`,
            )
          } else if (kind === "TOOL") {
            lines.push(
              `    TOOL ${stringAttr(span, OI.TOOL_NAME) ?? span.name} ${clip(stringAttr(span, OI.INPUT_VALUE) ?? "", 60)}`,
            )
          } else if (span.parent_id !== null) {
            lines.push(`    ${kind} ${span.name}`)
          }
        }

        if (turn.output !== undefined) lines.push(`    → ${clip(turn.output)}`)
      }
    }

    return lines.length === 0 ? "(no sessions)" : lines.join("\n")
  }

  close(): void {
    this.store.close()
  }
}
