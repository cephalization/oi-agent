/** A single-buffer line editor with history and bracketed paste. */

export type EditorAction =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "interrupt" }
  | { readonly type: "exit" }
  | { readonly type: "redraw" }

// One key: a CSI sequence, an alt-modified key, or a single character.
// oxlint-disable-next-line no-control-regex
const KEYS = /\u001B\[[0-9;]*[A-Za-z~]|\u001B[\s\S]|[\s\S]/gu

const PASTE_START = "\u001B[200~"
const PASTE_END = "\u001B[201~"

export class Editor {
  private buffer = ""
  private position = 0
  private readonly history: Array<string> = []
  private historyIndex = 0
  private draft = ""
  private pasting = false

  get text(): string {
    return this.buffer
  }

  get cursor(): number {
    return this.position
  }

  seedHistory(entries: ReadonlyArray<string>): void {
    for (const entry of entries) this.history.push(entry)

    this.historyIndex = this.history.length
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.position) + text + this.buffer.slice(this.position)
    this.position += text.length
  }

  private remove(from: number, to: number): void {
    this.buffer = this.buffer.slice(0, Math.max(from, 0)) + this.buffer.slice(to)
    this.position = Math.max(from, 0)
  }

  private wordStart(): number {
    const before = this.buffer.slice(0, this.position)

    return before.length - (/\S+\s*$/.exec(before)?.[0].length ?? 0)
  }

  private recall(offset: number): void {
    const next = this.historyIndex + offset

    if (next < 0 || next > this.history.length) return

    if (this.historyIndex === this.history.length) this.draft = this.buffer

    this.historyIndex = next
    this.buffer = this.history[next] ?? this.draft
    this.position = this.buffer.length
  }

  private submit(): EditorAction {
    const text = this.buffer.trim()

    this.buffer = ""
    this.position = 0

    if (text === "") return { type: "redraw" }

    if (this.history.at(-1) !== text) this.history.push(text)

    this.historyIndex = this.history.length
    this.draft = ""

    return { type: "submit", text }
  }

  private key(key: string): EditorAction {
    const handlers = new Map<string, () => EditorAction | void>([
      ["\r", () => this.submit()],
      ["\n", () => this.insert("\n")],
      ["\u001B\r", () => this.insert("\n")],
      ["\u007F", () => this.remove(this.position - 1, this.position)],
      ["\b", () => this.remove(this.position - 1, this.position)],
      ["\u0001", () => void (this.position = 0)],
      ["\u0005", () => void (this.position = this.buffer.length)],
      ["\u000B", () => this.remove(this.position, this.buffer.length)],
      ["\u0015", () => this.remove(0, this.position)],
      ["\u0017", () => this.remove(this.wordStart(), this.position)],
      ["\u001B\u007F", () => this.remove(this.wordStart(), this.position)],
      ["\u001B[D", () => void (this.position = Math.max(this.position - 1, 0))],
      ["\u001B[C", () => void (this.position = Math.min(this.position + 1, this.buffer.length))],
      ["\u001B[H", () => void (this.position = 0)],
      ["\u001B[F", () => void (this.position = this.buffer.length)],
      ["\u001B[A", () => this.recall(-1)],
      ["\u001B[B", () => this.recall(1)],
      ["\u001B[3~", () => this.remove(this.position, this.position + 1)],
      ["\u001B", () => ({ type: "interrupt" })],
      ["\u0003", () => (this.buffer === "" ? { type: "exit" } : this.remove(0, this.buffer.length))],
      ["\u0004", () => (this.buffer === "" ? { type: "exit" } : undefined)],
    ])

    const handler = handlers.get(key)

    if (handler !== undefined) return handler() ?? { type: "redraw" }

    // Printable input; unknown escape sequences are dropped.
    if (!key.startsWith("\u001B") && key >= " ") this.insert(key)

    return { type: "redraw" }
  }

  /** Feed raw terminal input. Returns what the application should do. */
  feed(data: string): EditorAction {
    if (this.pasting || data.includes(PASTE_START)) {
      const start = data.indexOf(PASTE_START)
      const end = data.indexOf(PASTE_END)
      const from = start === -1 ? 0 : start + PASTE_START.length

      this.insert(data.slice(from, end === -1 ? undefined : end).replaceAll("\r", "\n"))
      this.pasting = end === -1

      return { type: "redraw" }
    }

    // A chunk can carry several keys (fast typing, or text followed by enter).
    let action: EditorAction = { type: "redraw" }

    for (const key of data.match(KEYS) ?? []) {
      action = this.key(key)

      if (action.type !== "redraw") return action
    }

    return action
  }
}
