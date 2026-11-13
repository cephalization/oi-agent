/**
 * Turns store events into terminal output. The host's own terminal and a
 * joined peer use this same class on the same events, which is why a shared
 * session looks identical on both ends.
 */
import {
  type AnnotationFile,
  branchTo,
  type EndedSpan,
  isoToNs,
  kindOf,
  loadSession,
  OI,
  readMetadata,
  type SpanFile,
  type Store,
  type StoreEvent,
  stringAttr,
} from "@oi-agent/engine"
import { clip, style, wrap } from "./ansi.ts"
import { MarkdownStream } from "./markdown.ts"
import type { Screen } from "./screen.ts"

interface ActiveTool {
  readonly span: SpanFile
  tail: string
}

const MAX_RESULT_LINES = 6

const seconds = (span: EndedSpan): string =>
  `${(Number(isoToNs(span.end_time) - isoToNs(span.start_time)) / 1e9).toFixed(1)}s`

const numberAttr = (span: SpanFile, key: string): number => {
  const value = Number(span.attributes[key] ?? 0)

  return Number.isFinite(value) ? value : 0
}

const compact = (count: number): string => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count))

/** A tool call on one line: the name and the most telling part of its input. */
const describeTool = (span: SpanFile, columns: number): string => {
  const input = (stringAttr(span, OI.INPUT_VALUE) ?? "").replaceAll(/\s+/g, " ")

  return `${style.magenta("⏵")} ${style.bold(span.name)} ${style.gray(clip(input, Math.max(columns - span.name.length - 6, 10)))}`
}

export class Transcript {
  private readonly screen: Screen
  private readonly self: string
  private readonly markdown = new MarkdownStream()
  private readonly turns = new Set<string>()
  private readonly tools = new Map<string, ActiveTool>()
  private pending = ""
  private thinking = ""
  private wroteText = false
  private tokens = 0
  private startedMs = 0
  private active = 0
  private bytes = 0

  constructor(screen: Screen, self: string) {
    this.screen = screen
    this.self = self
  }

  get running(): boolean {
    return this.active > 0
  }

  get elapsedSeconds(): number {
    return this.running ? Math.floor((Date.now() - this.startedMs) / 1000) : 0
  }

  /** Bytes the session occupies on disk, as of the last finished turn. */
  get sessionBytes(): number {
    return this.bytes
  }

  get totalTokens(): number {
    return this.tokens
  }

  /** Lines for the live region: whatever is still in motion. */
  live(): Array<string> {
    const lines: Array<string> = []
    const columns = this.screen.columns

    if (this.pending !== "") lines.push(this.markdown.line(this.pending))

    if (this.thinking !== "") lines.push(style.dim(style.italic(`✻ ${clip(this.thinking, columns - 4)}`)))

    for (const tool of this.tools.values()) {
      lines.push(describeTool(tool.span, columns))

      if (tool.tail !== "") lines.push(style.gray(`  ${clip(tool.tail, columns - 4)}`))
    }

    return lines
  }

  /** Model text for scrollback: wrapped at word boundaries, then styled. */
  private prose(lines: ReadonlyArray<string>): Array<string> {
    return lines
      .flatMap((line) => wrap(line, this.screen.columns - 1))
      .map((line) => this.markdown.line(line))
  }

  private prompt(span: SpanFile): void {
    const user = stringAttr(span, OI.USER_ID) ?? ""
    const who = user === this.self || user === "" ? "" : style.yellow(`${user} `)
    const [first = "", ...rest] = (stringAttr(span, OI.INPUT_VALUE) ?? "").split("\n")

    this.screen.commit([
      "",
      `${style.cyan("›")} ${who}${style.bold(first)}`,
      ...rest.map((line) => `  ${style.bold(line)}`),
      "",
    ])
  }

  private text(delta: string): void {
    const lines = `${this.pending}${delta}`.split("\n")

    this.pending = lines.pop() ?? ""
    this.thinking = ""
    this.wroteText ||= lines.length > 0
    this.screen.commit(this.prose(lines))
  }

  private flushText(): void {
    if (this.pending !== "") {
      this.screen.commit(this.prose([this.pending]))
      this.wroteText = true
    }

    this.pending = ""
    this.thinking = ""
    this.markdown.reset()
  }

  private toolEnded(span: EndedSpan): void {
    const failed = span.status_code === "ERROR"
    const mark = failed ? style.red("✗") : style.green("✓")
    const output = (stringAttr(span, OI.OUTPUT_VALUE) ?? span.status_message).trimEnd().split("\n")

    const shown = output
      .slice(0, MAX_RESULT_LINES)
      .map((line) => style.gray(`  ${clip(line, this.screen.columns - 4)}`))

    const more =
      output.length > MAX_RESULT_LINES
        ? [style.gray(`  … ${output.length - MAX_RESULT_LINES} more lines`)]
        : []

    this.tools.delete(span.context.span_id)
    this.screen.commit([
      `${describeTool(span, this.screen.columns - 10)} ${mark} ${style.gray(seconds(span))}`,
      ...shown,
      ...more,
    ])
  }

  private turnEnded(span: EndedSpan): void {
    this.flushText()
    this.active = Math.max(this.active - 1, 0)
    this.bytes = readMetadata(span).session_bytes ?? this.bytes
    this.tools.clear()

    if (span.status_code === "ERROR") {
      const reason = span.status_message === "interrupted" ? "interrupted" : `error: ${span.status_message}`

      this.screen.commit([style.red(`  ⎿ ${reason}`)])

      return
    }

    // A peer that joined after the text streamed still needs to see the answer.
    if (!this.wroteText) {
      this.screen.commit(this.prose((stringAttr(span, OI.OUTPUT_VALUE) ?? "").split("\n")))
    }

    this.screen.commit([style.gray(`  ⎿ ${seconds(span)}`)])
  }

  annotation(file: AnnotationFile): void {
    const failed = file.annotation.metadata?.["failed"] === true
    const mark = failed ? style.red("◆") : style.green("◆")
    const verdict = file.annotation.label ?? String(file.annotation.score ?? "")

    const reason =
      file.annotation.explanation === undefined ? "" : style.gray(` — ${file.annotation.explanation}`)

    this.screen.commit([`${mark} ${style.bold(file.annotation.name)}: ${verdict}${reason}`])
  }

  private opened(span: SpanFile): void {
    const kind = kindOf(span)

    if (kind === "AGENT" && span.parent_id === null) {
      this.turns.add(span.context.trace_id)
      this.active += 1
      this.startedMs = Date.now()
      this.wroteText = false
      this.prompt(span)
    }

    if (!this.turns.has(span.context.trace_id)) return

    if (kind === "TOOL") this.tools.set(span.context.span_id, { span, tail: "" })
  }

  private ended(span: EndedSpan): void {
    const kind = kindOf(span)

    if (kind === "LLM") this.tokens += numberAttr(span, OI.TOKENS_TOTAL)

    if (!this.turns.has(span.context.trace_id)) return

    if (kind === "LLM") this.flushText()

    if (kind === "TOOL") this.toolEnded(span)

    if (kind === "AGENT" && span.parent_id === null) this.turnEnded(span)
  }

  private delta(event: Extract<StoreEvent, { type: "delta" }>): void {
    if (!this.turns.has(event.trace_id)) return

    if (event.delta.k === "text") this.text(event.delta.d)

    if (event.delta.k === "thinking") {
      this.thinking = `${this.thinking}${event.delta.d}`.split("\n").at(-1) ?? ""
    }

    const tool = this.tools.get(event.span_id)

    if (event.delta.k === "stdout" && tool !== undefined) {
      tool.tail = event.delta.d.trimEnd().split("\n").at(-1) ?? tool.tail
    }
  }

  onEvent(event: StoreEvent): void {
    if (event.type === "span_open") this.opened(event.span)

    if (event.type === "span_end") this.ended(event.span)

    if (event.type === "delta") this.delta(event)

    if (event.type === "annotation") this.annotation(event.annotation)

    if (event.type === "inbox" && event.entry.user_id !== this.self) {
      this.screen.commit([style.gray(`  prompt queued from ${event.entry.user_id}`)])
    }
  }

  /** Print the conversation so far, from disk. */
  replay(store: Store, sessionId: string): Array<string> {
    const view = loadSession(store, sessionId)
    const branch = view.head === undefined ? [] : branchTo(view, view.head.trace_id)
    const annotations = store.listAnnotations(sessionId)

    for (const turn of branch) {
      this.turns.add(turn.trace_id)
      this.bytes = readMetadata(turn.root).session_bytes ?? this.bytes
      this.prompt(turn.root)
      this.screen.commit(this.prose((turn.output ?? "").split("\n")))
      this.markdown.reset()

      if (turn.state !== "complete") this.screen.commit([style.red(`  ⎿ ${turn.state}`)])

      for (const file of annotations) {
        if (file.target.trace_id === turn.trace_id) this.annotation(file)
      }

      if (readMetadata(turn.root).injected !== undefined) {
        this.screen.commit([style.gray("  (eval feedback was injected into this turn)")])
      }
    }

    return branch.map((turn) => turn.input)
  }
}

export { compact }
