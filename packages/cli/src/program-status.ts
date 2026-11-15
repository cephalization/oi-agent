/** Terminal status is a projection of live store events, never additional session state. */
import { kindOf, OI, Redactor, type StoreEvent, stringAttr } from "@oi-agent/engine"
import { programStatus, type ProgramReport, type ProgramState } from "./tui/ansi.ts"

export class ProgramStatus {
  private state: ProgramState = "idle"
  private last = ""
  private closed = false
  private readonly write: (text: string) => void
  private readonly redactor: Redactor

  constructor(write: (text: string) => void, redactor = new Redactor()) {
    this.write = write
    this.redactor = redactor
  }

  report(state: ProgramState, msg?: string, kind?: ProgramReport["kind"]): void {
    if (this.closed) return

    const report: ProgramReport = { state }

    if (msg !== undefined) report.msg = this.redactor.scrub(msg)

    if (kind !== undefined) report.kind = kind

    const encoded = programStatus(report)

    this.state = state

    if (encoded === this.last) return

    this.last = encoded
    this.write(encoded)
  }

  /** The next key acknowledges a result, but must not hide an active approval. */
  acknowledge(): void {
    if (this.state === "done" || this.state === "error") this.report("idle")
  }

  event(event: StoreEvent): void {
    if (event.type !== "span_open" && event.type !== "span_end") return

    const span = event.span

    if (kindOf(span) !== "AGENT" || span.parent_id !== null) return

    if (event.type === "span_open") {
      this.report("working", stringAttr(span, OI.INPUT_VALUE))
    } else if (event.span.status_code === "ERROR") {
      this.report(event.span.status_message === "interrupted" ? "idle" : "error", event.span.status_message)
    } else {
      this.report("done", stringAttr(span, OI.OUTPUT_VALUE))
    }
  }

  /** Ignore late completion events once the terminal has been left. */
  clear(): void {
    this.report("clear")
    this.closed = true
  }
}
