/**
 * Line-at-a-time Markdown styling. Model output arrives as a stream, so each
 * line is styled when it completes; the only state carried between lines is
 * whether a code fence is open.
 */
import { style } from "./ansi.ts"

export class MarkdownStream {
  private fenced = false

  private inline(text: string): string {
    return text
      .replaceAll(/`([^`]+)`/g, (_match, code: string) => style.cyan(code))
      .replaceAll(/\*\*([^*]+)\*\*/g, (_match, bold: string) => style.bold(bold))
  }

  line(text: string): string {
    if (text.trimStart().startsWith("```")) {
      this.fenced = !this.fenced

      return style.gray(text)
    }

    if (this.fenced) return `  ${style.cyan(text)}`

    const heading = /^(#{1,6})\s+(.*)$/.exec(text)

    if (heading?.[2] !== undefined) return style.bold(this.inline(heading[2]))

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(text)

    if (bullet?.[2] !== undefined) return `${bullet[1] ?? ""}${style.gray("•")} ${this.inline(bullet[2])}`

    return this.inline(text)
  }

  reset(): void {
    this.fenced = false
  }
}
