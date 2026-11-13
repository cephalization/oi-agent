import { describe, expect, it } from "vite-plus/test"
import { clip, rowsOf, strip, style, width, wrap } from "../src/tui/ansi.ts"
import { Editor } from "../src/tui/editor.ts"
import { MarkdownStream } from "../src/tui/markdown.ts"

describe("text measurement", () => {
  it("ignores styling and counts wide characters as two columns", () => {
    expect(width(style.bold("abc"))).toBe(3)
    expect(width("日本")).toBe(4)
    expect(rowsOf("x".repeat(25), 10)).toBe(3)
    expect(clip("abcdefghij", 6)).toBe("abcde…")
  })

  it("wraps at word boundaries and keeps list indentation", () => {
    expect(wrap("the quick brown fox jumps", 11)).toEqual(["the quick", "brown fox", "jumps"])
    expect(wrap("- alpha beta gamma", 12)).toEqual(["- alpha beta", "  gamma"])
  })
})

describe("editor", () => {
  it("treats a chunk of text followed by enter as typing then submit", () => {
    const editor = new Editor()

    expect(editor.feed("hello world\r")).toEqual({ type: "submit", text: "hello world" })
    expect(editor.text).toBe("")
  })

  it("edits in the middle of the line and recalls history", () => {
    const editor = new Editor()

    editor.feed("helo")
    editor.feed("\u001B[D")
    editor.feed("l")
    expect(editor.text).toBe("hello")
    editor.feed("\r")
    editor.feed("\u001B[A")
    expect(editor.text).toBe("hello")
    editor.feed("\u0015")
    expect(editor.text).toBe("")
  })

  it("keeps pasted newlines instead of submitting", () => {
    const editor = new Editor()

    expect(editor.feed("\u001B[200~line one\rline two\u001B[201~").type).toBe("redraw")
    expect(editor.text).toBe("line one\nline two")
  })

  it("interrupts on escape and exits on ctrl+c only when empty", () => {
    const editor = new Editor()

    expect(editor.feed("\u001B").type).toBe("interrupt")
    editor.feed("draft")
    expect(editor.feed("\u0003").type).toBe("redraw")
    expect(editor.feed("\u0003").type).toBe("exit")
  })
})

describe("markdown stream", () => {
  it("styles lines one at a time and tracks code fences", () => {
    const markdown = new MarkdownStream()

    expect(strip(markdown.line("## Title"))).toBe("Title")
    expect(strip(markdown.line("- a `b` **c**"))).toBe("• a b c")
    markdown.line("```ts")
    expect(strip(markdown.line("**not bold**"))).toBe("  **not bold**")
  })
})
