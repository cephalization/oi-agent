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

/** Keep existing shortcuts working when the terminal uses CSI-u modified keys. */
export const normalizeKeys = (data: string): string => {
  const keys = new Map([
    ["\u001B[27u", "\u001B"],
    ["\u001B[9;2u", "\u001B[Z"],
    ["\u001B[127;3u", "\u001B\u007F"],
    ["\u001B[13;3u", "\u001B\r"],
  ])

  for (const letter of "abcdefghijklmnopqrstuvwxyz")
    keys.set(`\u001B[${letter.charCodeAt(0)};5u`, String.fromCharCode(letter.charCodeAt(0) - 96))

  let normalized = data

  for (const [key, value] of keys) normalized = normalized.replaceAll(key, value)

  return normalized
}

export class Editor {
  private buffer = ""
  private position = 0
  private readonly history: Array<string> = []
  private historyIndex = 0
  private draft = ""
  private pasting = false
  private pasted = ""

  /**
   * What a finished paste puts in the line. The application can take a paste
   * for something else (files dropped on the terminal paste their paths) and
   * return what is left to insert, which may be nothing.
   */
  onPaste: (text: string) => string = (text) => text

  /** The app may allow an empty line (e.g. with attachments) or stop a failed drop from sending. */
  canSubmit: (text: string) => boolean = (text) => text !== ""

  get inPaste(): boolean {
    return this.pasting
  }

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

  /** Replace the whole line, with the cursor at the end. */
  set(text: string): void {
    this.buffer = text
    this.position = text.length
  }

  /** Restore the latest withdrawn prompt; Up reaches the earlier ones. */
  restore(entries: ReadonlyArray<string>): void {
    if (entries.length === 0) return

    if (this.buffer !== "" && !this.history.includes(this.buffer)) this.history.push(this.buffer)

    for (const entry of entries) {
      if (!this.history.includes(entry)) this.history.push(entry)
    }

    const latest = entries.at(-1) ?? ""

    this.historyIndex = this.history.lastIndexOf(latest)
    this.draft = ""
    this.set(latest)
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

    if (!this.canSubmit(text)) return { type: "redraw" }

    this.buffer = ""
    this.position = 0

    if (text !== "" && this.history.at(-1) !== text) this.history.push(text)

    this.historyIndex = this.history.length
    this.draft = ""

    return { type: "submit", text }
  }

  private key(key: string): EditorAction {
    const handlers = new Map<string, () => EditorAction | void>([
      ["\r", () => this.submit()],
      ["\n", () => this.insert("\n")],
      ["\u001B[13;2u", () => this.insert("\n")],
      ["\u001B[27;2;13~", () => this.insert("\n")],
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
      ["\u001B[27u", () => ({ type: "interrupt" })],
      ["\u0003", () => (this.buffer === "" ? { type: "exit" } : this.remove(0, this.buffer.length))],
      ["\u0004", () => (this.buffer === "" ? { type: "exit" } : undefined)],
    ])

    const handler = handlers.get(key)

    if (handler !== undefined) return handler() ?? { type: "redraw" }

    // Printable input; unknown escape sequences are dropped.
    if (!key.startsWith("\u001B") && key >= " ") this.insert(key)

    return { type: "redraw" }
  }

  private keys(data: string): EditorAction {
    for (const key of normalizeKeys(data).match(KEYS) ?? []) {
      const action = this.key(key)

      if (action.type !== "redraw") return action
    }

    return { type: "redraw" }
  }

  /** Feed raw terminal input, keeping keys outside a paste in their original order. */
  feed(raw: string): EditorAction {
    let data = raw

    while (this.pasting || data.includes(PASTE_START)) {
      if (!this.pasting) {
        const start = data.indexOf(PASTE_START)
        const action = this.keys(data.slice(0, start))

        if (action.type !== "redraw") return action

        data = data.slice(start + PASTE_START.length)
        this.pasting = true
      }

      // Search across the chunk boundary, including a partial end marker.
      const from = Math.max(0, this.pasted.length - PASTE_END.length + 1)

      this.pasted += data

      const end = this.pasted.indexOf(PASTE_END, from)

      if (end === -1) return { type: "redraw" }

      const pasted = this.pasted.slice(0, end)

      data = this.pasted.slice(end + PASTE_END.length)
      this.pasted = ""
      this.pasting = false
      this.insert(this.onPaste(pasted).replaceAll("\r", "\n"))
    }

    return this.keys(data)
  }
}
