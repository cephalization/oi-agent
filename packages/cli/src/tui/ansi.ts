/** Terminal escape sequences and text measurement. */

const ESC = "\u001B["

export const style = {
  dim: (text: string): string => `${ESC}2m${text}${ESC}22m`,
  bold: (text: string): string => `${ESC}1m${text}${ESC}22m`,
  italic: (text: string): string => `${ESC}3m${text}${ESC}23m`,
  red: (text: string): string => `${ESC}31m${text}${ESC}39m`,
  green: (text: string): string => `${ESC}32m${text}${ESC}39m`,
  yellow: (text: string): string => `${ESC}33m${text}${ESC}39m`,
  blue: (text: string): string => `${ESC}34m${text}${ESC}39m`,
  magenta: (text: string): string => `${ESC}35m${text}${ESC}39m`,
  cyan: (text: string): string => `${ESC}36m${text}${ESC}39m`,
  gray: (text: string): string => `${ESC}90m${text}${ESC}39m`,
  inverse: (text: string): string => `${ESC}7m${text}${ESC}27m`,
}

export const control = {
  up: (rows: number): string => (rows > 0 ? `${ESC}${rows}A` : ""),
  column: (column: number): string => `${ESC}${column}G`,
  clearDown: `${ESC}0J`,
  clearLine: `${ESC}2K`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
  /** Synchronized output: the terminal paints the whole frame at once. */
  beginFrame: `${ESC}?2026h`,
  endFrame: `${ESC}?2026l`,
  bracketedPasteOn: `${ESC}?2004h`,
  bracketedPasteOff: `${ESC}?2004l`,
}

// oxlint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g

export const strip = (text: string): string => text.replace(ANSI, "")

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]/u

/** Columns a string occupies, ignoring escape sequences. */
export const width = (text: string): number => {
  let columns = 0

  for (const char of strip(text)) columns += WIDE.test(char) ? 2 : 1

  return columns
}

/** Rows a line occupies once the terminal wraps it. */
export const rowsOf = (line: string, columns: number): number => Math.max(1, Math.ceil(width(line) / columns))

/** Cut a plain string to fit a number of columns, adding an ellipsis. */
export const clip = (text: string, columns: number): string => {
  if (width(text) <= columns) return text

  let out = ""
  let used = 0

  for (const char of text) {
    const size = WIDE.test(char) ? 2 : 1

    if (used + size > columns - 1) break

    out += char
    used += size
  }

  return `${out}…`
}

/** Break plain text into lines no wider than `columns`, at spaces where it can. */
export const wrap = (text: string, columns: number): Array<string> => {
  if (width(text) <= columns) return [text]

  const indent = /^\s*(?:[-*]\s+)?/.exec(text)?.[0].replaceAll(/\S/g, " ") ?? ""
  const lines: Array<string> = []
  let current = ""

  for (const word of text.split(/(?<=\s)/)) {
    if (current !== "" && width(current) + width(word.trimEnd()) > columns) {
      lines.push(current.trimEnd())
      current = indent
    }

    current += word
  }

  lines.push(current.trimEnd())

  return lines
}
