/**
 * Where a session's time went, computed from its span files alone: every
 * span records when it started and ended, so nothing here is bookkeeping.
 *
 * A turn's time is split into model time (its `LLM` spans) and tool execution
 * time (its `TOOL` spans after approval). Traces that are not turns (evaluators, learning,
 * steering detection) run after a turn and are reported apart, as judge time.
 */
import { Option, Schema } from "effect"
import { loadSession, type TurnState } from "./fold.ts"
import { kindOf, numberAttr, OI, readMetadata, type SpanFile, stringAttr } from "./format.ts"
import { executionDurationMs } from "./timing.ts"
import { isoToNs } from "./ids.ts"
import type { Store, TraceFiles } from "./store.ts"

export interface TurnMetrics {
  readonly trace_id: string
  /** The first line of what was asked. */
  readonly prompt: string
  readonly user_id: string
  readonly state: TurnState
  readonly started_at: string
  readonly wall_ms: number
  readonly model_ms: number
  /** Execution only; approval latency remains in wall_ms and raw TOOL span latency. */
  readonly tool_ms: number
  readonly model_calls: number
  readonly tool_calls: number
  readonly tokens_in: number
  readonly tokens_out: number
  readonly tokens_cached: number
}

export interface ToolCallMetrics {
  readonly trace_id: string
  /** Position of its turn in the session, from 1. */
  readonly turn: number
  readonly tool: string
  /** What time is grouped under: the tool, or for `bash` the command family (`pnpm e2e`, `git`). */
  readonly kind: string
  /** One line saying what ran. */
  readonly summary: string
  readonly duration_ms: number
  /** Still open: a call in flight, or one cut off by a crash. */
  readonly unfinished: boolean
}

export interface KindMetrics {
  readonly kind: string
  readonly duration_ms: number
  readonly calls: number
}

/** A task this session delegated: its work is in a session of its own. */
export interface TaskMetrics {
  readonly id: string
  readonly session_id: string
  readonly title: string
  readonly wall_ms: number
  readonly model_ms: number
  /** Execution only; approval latency remains in wall_ms and raw TOOL span latency. */
  readonly tool_ms: number
  readonly tokens_in: number
  readonly tokens_out: number
}

export interface Totals {
  /** From the first turn's start to the last turn's end, idle time included. */
  readonly elapsed_ms: number
  /** The sum of the turns: time oi was working. */
  readonly wall_ms: number
  readonly model_ms: number
  /** Execution only; approval latency remains in wall_ms and raw TOOL span latency. */
  readonly tool_ms: number
  /** Evaluators, learning and steering detection: after the turns, not part of them. */
  readonly judge_ms: number
  readonly judge_calls: number
  readonly tokens_in: number
  readonly tokens_out: number
  readonly tokens_cached: number
  readonly judge_tokens_in: number
  readonly judge_tokens_out: number
  readonly bytes: number
}

export interface SessionMetrics {
  readonly session_id: string
  readonly turns: ReadonlyArray<TurnMetrics>
  /** The slowest tool calls, slowest first. */
  readonly slowest: ReadonlyArray<ToolCallMetrics>
  /** Tool time grouped by what ran, largest first. */
  readonly by_kind: ReadonlyArray<KindMetrics>
  readonly tasks: ReadonlyArray<TaskMetrics>
  readonly totals: Totals
}

export interface MetricsOptions {
  /** "Now", for spans still open. */
  readonly nowMs?: number
  /** How many of the slowest tool calls to keep. */
  readonly slowest?: number
}

const msOf = (iso: string): number => Number(isoToNs(iso) / 1_000_000n)

/**
 * How long each span of a trace took. A span still open in a running turn
 * has run until now; one left open by a crash ran, as far as anyone can
 * know, until the last thing the trace recorded.
 */
interface Timed {
  readonly span: SpanFile
  readonly ms: number
  /** Still open: in flight, or cut off by a crash. */
  readonly unfinished: boolean
}

const durations = (trace: TraceFiles, state: TurnState | undefined, nowMs: number): Array<Timed> => {
  const times = [
    ...trace.ended.flatMap((span) => [msOf(span.start_time), msOf(span.end_time)]),
    ...trace.open.flatMap((entry) => [msOf(entry.span.start_time), entry.heartbeat_ms]),
  ]

  const last = times.length === 0 ? nowMs : Math.max(...times)
  const until = state === "running" ? nowMs : last

  return [
    ...trace.ended.map((span) => ({
      span,
      ms: executionDurationMs(span, msOf(span.end_time)),
      unfinished: false,
    })),
    ...trace.open.map((entry) => ({
      span: entry.span,
      ms: executionDurationMs(entry.span, until),
      unfinished: true,
    })),
  ]
}

// --- what a bash command was ------------------------------------------------

/** Commands whose second word says what they do: `pnpm e2e`, `git commit`, `cargo test`. */
const RUNNERS = new Set([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "npx",
  "git",
  "gh",
  "cargo",
  "go",
  "docker",
  "kubectl",
  "make",
  "uv",
  "poetry",
  "brew",
  "vp",
  "rex",
])

/** Steps that set a command up, wait, or report on it: rarely what took the time. */
const INCIDENTAL = new Set([
  "cd",
  "export",
  "set",
  "echo",
  "printf",
  "true",
  "pushd",
  "popd",
  "source",
  "wait",
  "sleep",
  "date",
  "tail",
  "head",
  "cat",
  "grep",
  "sed",
  "awk",
  "ls",
  "wc",
  "sort",
  "cut",
  "tee",
  "pgrep",
  "kill",
  "rm",
  "mkdir",
  "test",
  "[",
  // What is left of a loop or a condition once it is split into steps.
  "while",
  "until",
  "for",
  "if",
  "done",
  "fi",
])

/** The incidental steps that do take time: when a command is nothing but waiting and reading, it was the waiting. */
const WAITING = new Set(["sleep", "wait", "while", "until"])

const BashInput = Schema.fromJsonString(Schema.Struct({ command: Schema.String }))
const decodeBashInput = Schema.decodeUnknownOption(BashInput)

/**
 * The steps of a shell command, in order: split at `&&`, `||`, `;` and
 * newlines outside quotes, without heredoc bodies and without what a step's
 * output is piped into. Not a shell parser: enough to name what ran.
 */
export const commandSteps = (command: string): Array<string> => {
  const text = command.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, "")
  const steps: Array<string> = []
  let step = ""
  let quote = ""
  let piped = false

  const end = (): void => {
    // `FOO=1 pnpm test`, `time pnpm test`, `( pnpm test )`
    const cleaned = step.trim().replace(/^(?:[({]\s*|(?:time|do|then|else)\s+|\w+=\S*\s+)+/, "")

    if (cleaned !== "") steps.push(cleaned)

    step = ""
    piped = false
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    const next = text.charAt(index + 1)

    if (quote !== "") {
      if (char === "\\" && quote === '"') {
        if (!piped) step += char + next

        index += 1
      } else {
        if (char === quote) quote = ""

        if (!piped) step += char
      }
    } else if (char === "'" || char === '"') {
      quote = char

      if (!piped) step += char
    } else if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      end()
      index += 1
    } else if (char === ";" || char === "\n") {
      end()
    } else if (char === "|") {
      piped = true
    } else if (!piped) {
      step += char
    }
  }

  end()

  return steps
}

const firstWord = (step: string): string => (step.split(/\s+/)[0] ?? "").split("/").at(-1) ?? ""

/**
 * The step of a command that most likely took the time. A build or test
 * runner if there is one, the last when several; otherwise the last step
 * that does something. A file written from a heredoc and then `pnpm e2e`,
 * with its log tailed afterwards, reads as the e2e run; `sleep 30; tail log`
 * reads as the sleep.
 */
const mainStep = (command: string): string => {
  const all = commandSteps(command)

  return (
    all.findLast((step) => RUNNERS.has(firstWord(step))) ??
    all.findLast((step) => !INCIDENTAL.has(firstWord(step))) ??
    all.findLast((step) => WAITING.has(firstWord(step))) ??
    all.at(-1) ??
    command.trim().split("\n")[0] ??
    ""
  )
}

/** `pnpm e2e` for `pnpm e2e scenarios/x.ts`, `rg` for `rg -n foo`: the first word, and the second after a runner. */
export const commandFamily = (command: string): string => {
  const step = mainStep(command)
  const name = firstWord(step)
  const second = step.split(/\s+/)[1] ?? ""

  return RUNNERS.has(name) && /^[a-z][\w:-]*$/i.test(second) ? `${name} ${second}` : name
}

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`

const describeCall = (span: SpanFile): Pick<ToolCallMetrics, "tool" | "kind" | "summary"> => {
  const tool = stringAttr(span, OI.TOOL_NAME) ?? span.name
  const input = stringAttr(span, OI.INPUT_VALUE) ?? ""

  if (tool !== "bash") return { tool, kind: tool, summary: `${tool} ${input.replace(/\s+/g, " ")}`.trim() }

  const command = Option.match(decodeBashInput(input), {
    onNone: () => input,
    onSome: (decoded) => decoded.command,
  })

  return { tool, kind: commandFamily(command) || "bash", summary: mainStep(command).replace(/\s+/g, " ") }
}

// --- the session --------------------------------------------------------------

interface Usage {
  readonly model_ms: number
  /** Execution only; approval latency remains in wall_ms and raw TOOL span latency. */
  readonly tool_ms: number
  readonly model_calls: number
  readonly tool_calls: number
  readonly tokens_in: number
  readonly tokens_out: number
  readonly tokens_cached: number
}

const usageOf = (spans: ReadonlyArray<Timed>): Usage => {
  const llm = spans.filter((entry) => kindOf(entry.span) === "LLM")
  const tools = spans.filter((entry) => kindOf(entry.span) === "TOOL")
  const sum = (key: string): number => llm.reduce((total, entry) => total + numberAttr(entry.span, key), 0)

  return {
    model_ms: llm.reduce((total, entry) => total + entry.ms, 0),
    tool_ms: tools.reduce((total, entry) => total + entry.ms, 0),
    model_calls: llm.length,
    tool_calls: tools.length,
    tokens_in: sum(OI.TOKENS_PROMPT),
    tokens_out: sum(OI.TOKENS_COMPLETION),
    tokens_cached: sum(OI.TOKENS_CACHE_READ),
  }
}

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? ""

/** The sessions a turn's tool calls started tasks in. */
const delegatedIn = (trace: TraceFiles): Array<{ id: string; session_id: string }> =>
  [...trace.ended, ...trace.open.map((entry) => entry.span)].flatMap((span) => {
    const task = readMetadata(span).task

    return kindOf(span) === "TOOL" && (stringAttr(span, OI.TOOL_NAME) ?? span.name) === "delegate" && task
      ? [{ id: task.id, session_id: task.session_id }]
      : []
  })

export const sessionMetrics = (
  store: Store,
  sessionId: string,
  options: MetricsOptions = {},
): SessionMetrics => {
  const nowMs = options.nowMs ?? Date.now()
  const view = loadSession(store, sessionId)
  const order = view.turns.toSorted((a, b) => a.root.start_time.localeCompare(b.root.start_time))
  const turnIds = new Set(order.map((turn) => turn.trace_id))

  const turns: Array<TurnMetrics> = []
  const calls: Array<ToolCallMetrics> = []
  const delegated: Array<{ id: string; session_id: string }> = []
  let lastEndMs = 0

  for (const [index, turn] of order.entries()) {
    const trace = store.readTrace(sessionId, turn.trace_id)
    const spans = durations(trace, turn.state, nowMs)
    const root = spans.find((entry) => entry.span.context.span_id === turn.root.context.span_id)
    const wall = root?.ms ?? 0

    lastEndMs = Math.max(lastEndMs, msOf(turn.root.start_time) + wall)
    delegated.push(...delegatedIn(trace))

    turns.push({
      trace_id: turn.trace_id,
      prompt:
        readMetadata(turn.root).delivers === undefined
          ? firstLine(turn.input)
          : "(results of background work)",
      user_id: turn.user_id,
      state: turn.state,
      started_at: turn.root.start_time,
      wall_ms: wall,
      ...usageOf(spans),
    })

    for (const entry of spans) {
      if (kindOf(entry.span) !== "TOOL") continue

      calls.push({
        trace_id: turn.trace_id,
        turn: index + 1,
        ...describeCall(entry.span),
        duration_ms: entry.ms,
        unfinished: entry.unfinished,
      })
    }
  }

  // Everything that is not a turn ran to judge one: evaluators, learning, steering detection.
  const judge = store
    .listTraceIds(sessionId)
    .filter((traceId) => !turnIds.has(traceId))
    .map((traceId) => {
      const spans = durations(store.readTrace(sessionId, traceId), undefined, nowMs)
      const root = spans.find((entry) => entry.span.parent_id === null)

      return { ms: root?.ms ?? 0, usage: usageOf(spans) }
    })

  const kinds = new Map<string, KindMetrics>()

  for (const call of calls) {
    const known = kinds.get(call.kind)

    kinds.set(call.kind, {
      kind: call.kind,
      duration_ms: (known?.duration_ms ?? 0) + call.duration_ms,
      calls: (known?.calls ?? 0) + 1,
    })
  }

  const tasks = delegated.flatMap((task): Array<TaskMetrics> => {
    const header = store.readHeader(task.session_id)

    if (header === undefined) return []

    const { totals } = sessionMetrics(store, task.session_id, { nowMs, slowest: 0 })

    return [
      {
        id: task.id,
        session_id: task.session_id,
        title: header.task?.title ?? "",
        wall_ms: totals.wall_ms,
        model_ms: totals.model_ms,
        tool_ms: totals.tool_ms,
        tokens_in: totals.tokens_in,
        tokens_out: totals.tokens_out,
      },
    ]
  })

  const total = (key: keyof Usage | "wall_ms"): number => turns.reduce((sum, turn) => sum + turn[key], 0)
  const first = order[0]

  return {
    session_id: sessionId,
    turns,
    slowest: calls.toSorted((a, b) => b.duration_ms - a.duration_ms).slice(0, options.slowest ?? 8),
    by_kind: [...kinds.values()].toSorted((a, b) => b.duration_ms - a.duration_ms),
    tasks,
    totals: {
      elapsed_ms: first === undefined ? 0 : lastEndMs - msOf(first.root.start_time),
      wall_ms: total("wall_ms"),
      model_ms: total("model_ms"),
      tool_ms: total("tool_ms"),
      judge_ms: judge.reduce((sum, entry) => sum + entry.ms, 0),
      judge_calls: judge.reduce((sum, entry) => sum + entry.usage.model_calls, 0),
      tokens_in: total("tokens_in"),
      tokens_out: total("tokens_out"),
      tokens_cached: total("tokens_cached"),
      judge_tokens_in: judge.reduce((sum, entry) => sum + entry.usage.tokens_in, 0),
      judge_tokens_out: judge.reduce((sum, entry) => sum + entry.usage.tokens_out, 0),
      bytes: store.sessionBytes(sessionId),
    },
  }
}

// --- rendering --------------------------------------------------------------

/** `8.4m`, `2.1h`, `16s`: short enough for a column. */
export const shortDuration = (ms: number): string => {
  const seconds = ms / 1000

  if (seconds < 0.95) return `${Math.round(ms)}ms`

  if (seconds < 59.5) return `${seconds < 9.95 ? seconds.toFixed(1) : Math.round(seconds)}s`

  const minutes = seconds / 60

  return minutes < 59.95 ? `${minutes.toFixed(1)}m` : `${(minutes / 60).toFixed(1)}h`
}

const count = (value: number): string =>
  value < 1000
    ? String(value)
    : value < 999_500
      ? `${(value / 1000).toFixed(value < 9950 ? 1 : 0)}k`
      : `${(value / 1_000_000).toFixed(1)}M`

const size = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

const MARK = new Map<TurnState, string>([
  ["running", " (running)"],
  ["interrupted", " (interrupted)"],
  ["failed", " (failed)"],
])

/** How many turns the table shows before summing the rest into one line. */
const TURN_ROWS = 12

/** The metrics as lines of plain text, no wider than `width`. */
export const renderMetrics = (metrics: SessionMetrics, width: number = 100): Array<string> => {
  const { totals } = metrics

  if (metrics.turns.length === 0) return ["No turns yet: nothing has taken any time."]

  const cell = (text: string): string => text.padStart(7)
  const fixed = 7 * 4 + 6
  const promptWidth = Math.max(16, Math.min(60, width - fixed - 2))
  const lines: Array<string> = []
  const ranked = metrics.turns.toSorted((a, b) => b.wall_ms - a.wall_ms)
  const shown = ranked.slice(0, TURN_ROWS)
  const rest = ranked.slice(TURN_ROWS)

  lines.push(
    `${"TURN".padEnd(promptWidth)}  ${cell("total")}${cell("model")}${cell("tools")}${"calls".padStart(6)}`,
  )

  for (const turn of shown) {
    const mark = MARK.get(turn.state) ?? ""
    const label = `${clip(turn.prompt === "" ? "(empty)" : turn.prompt, promptWidth - mark.length)}${mark}`

    lines.push(
      `${label.padEnd(promptWidth)}  ${cell(shortDuration(turn.wall_ms))}${cell(shortDuration(turn.model_ms))}${cell(shortDuration(turn.tool_ms))}${String(turn.tool_calls).padStart(6)}`,
    )
  }

  if (rest.length > 0) {
    const sum = (key: "wall_ms" | "model_ms" | "tool_ms" | "tool_calls"): number =>
      rest.reduce((total, turn) => total + turn[key], 0)

    lines.push(
      `${`… ${rest.length} shorter turn${rest.length === 1 ? "" : "s"}`.padEnd(promptWidth)}  ${cell(shortDuration(sum("wall_ms")))}${cell(shortDuration(sum("model_ms")))}${cell(shortDuration(sum("tool_ms")))}${String(sum("tool_calls")).padStart(6)}`,
    )
  }

  if (metrics.by_kind.length > 0) {
    lines.push("", "WHERE THE TOOL TIME WENT")

    const top = metrics.by_kind.slice(0, 8)
    const others = metrics.by_kind.slice(8)

    const row = (kind: string, ms: number, calls: number): string =>
      `${cell(shortDuration(ms))} ${String(totals.tool_ms === 0 ? 0 : Math.round((ms / totals.tool_ms) * 100)).padStart(3)}%  ${clip(kind, Math.max(12, width - 30))} (${calls} call${calls === 1 ? "" : "s"})`

    for (const kind of top) lines.push(row(kind.kind, kind.duration_ms, kind.calls))

    if (others.length > 0)
      lines.push(
        row(
          "everything else",
          others.reduce((total, kind) => total + kind.duration_ms, 0),
          others.reduce((total, kind) => total + kind.calls, 0),
        ),
      )
  }

  if (metrics.slowest.length > 0) {
    lines.push("", "SLOWEST TOOL CALLS")

    for (const call of metrics.slowest)
      lines.push(
        `${cell(shortDuration(call.duration_ms))}  turn ${String(call.turn).padEnd(3)} ${clip(`${call.summary}${call.unfinished ? " (unfinished)" : ""}`, Math.max(20, width - 20))}`,
      )
  }

  if (metrics.tasks.length > 0) {
    lines.push("", "DELEGATED TASKS (their own sessions, not counted above)")

    for (const task of metrics.tasks)
      lines.push(
        `${cell(shortDuration(task.wall_ms))}  ${clip(`${task.id} ${task.title}`, Math.max(20, width - 44))}  model ${shortDuration(task.model_ms)}, tools ${shortDuration(task.tool_ms)}`,
      )
  }

  lines.push(
    "",
    `${metrics.turns.length} turn${metrics.turns.length === 1 ? "" : "s"}: ${shortDuration(totals.wall_ms)} of work over ${shortDuration(totals.elapsed_ms)}`,
    `  model ${shortDuration(totals.model_ms)} · tools ${shortDuration(totals.tool_ms)} · judges ${shortDuration(totals.judge_ms)} (${totals.judge_calls} call${totals.judge_calls === 1 ? "" : "s"}, after the turns)`,
    `  tokens ${count(totals.tokens_in)} in (${count(totals.tokens_cached)} cached), ${count(totals.tokens_out)} out · judges ${count(totals.judge_tokens_in)} in, ${count(totals.judge_tokens_out)} out`,
    `  on disk ${size(totals.bytes)}`,
  )

  return lines.map((line) => clip(line, width))
}
