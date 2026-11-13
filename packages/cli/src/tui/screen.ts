/**
 * A scrollback-native screen.
 *
 * Finished output is written to the terminal's normal scrollback and never
 * touched again, so scrolling, selection and search behave as in any shell.
 * Only a small live region at the bottom (streaming text, status, the input
 * line) is redrawn, and each redraw is one synchronized frame.
 */
import { control, rowsOf } from "./ansi.ts"

export interface LiveFrame {
  readonly lines: ReadonlyArray<string>
  /** Cursor position inside the frame: line index and 1-based column. */
  readonly cursor: { readonly line: number; readonly column: number }
}

export class Screen {
  private readonly out: NodeJS.WriteStream
  private liveRows = 0
  private cursorRow = 0
  private last: LiveFrame = { lines: [], cursor: { line: 0, column: 1 } }

  constructor(out: NodeJS.WriteStream) {
    this.out = out
  }

  get columns(): number {
    return Math.max(this.out.columns ?? 80, 20)
  }

  /** Move to the top of the live region and clear it. */
  private erase(): string {
    return `${control.up(this.cursorRow)}${control.column(1)}${control.clearDown}`
  }

  private paint(frame: LiveFrame): string {
    const rows = frame.lines.map((line) => rowsOf(line, this.columns))
    const total = rows.reduce((sum, count) => sum + count, 0)
    const before = rows.slice(0, frame.cursor.line).reduce((sum, count) => sum + count, 0)
    const cursorRow = before + Math.floor((frame.cursor.column - 1) / this.columns)
    const cursorColumn = ((frame.cursor.column - 1) % this.columns) + 1

    this.liveRows = total
    this.cursorRow = cursorRow
    this.last = frame

    // After writing every line the cursor sits on the last row of the frame.
    return `${frame.lines.join("\r\n")}${control.up(total - 1 - cursorRow)}${control.column(cursorColumn)}`
  }

  /** Redraw the live region. */
  render(frame: LiveFrame): void {
    this.out.write(`${control.beginFrame}${this.erase()}${this.paint(frame)}${control.endFrame}`)
  }

  /** Append finished lines to scrollback, above the live region. */
  commit(lines: ReadonlyArray<string>): void {
    if (lines.length === 0) return

    const text = lines.map((line) => `${line}\r\n`).join("")

    this.out.write(`${control.beginFrame}${this.erase()}${text}${this.paint(this.last)}${control.endFrame}`)
  }

  /** Remove the live region, leaving the cursor where it started. */
  clear(): void {
    this.out.write(this.erase())
    this.liveRows = 0
    this.cursorRow = 0
  }
}
