import { describe, expect, it } from "vite-plus/test"
import { clip, rowsOf, strip, style, width, wrap } from "../src/tui/ansi.ts"
import {
  accept,
  type Command,
  COMMANDS,
  complete,
  findCommand,
  helpLines,
  onEnter,
} from "../src/tui/commands.ts"
import { Editor } from "../src/tui/editor.ts"
import { effortsFor, fitEffort, nextEffort } from "../src/tui/modes.ts"
import { EFFORTS } from "@oi-agent/engine"
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

describe("slash command completion", () => {
  const sessions = [
    { value: "01a1aaaa-0000", label: "fix the flaky tests", hint: "2h ago" },
    { value: "01a1bbbb-0000", label: "write docs", hint: "1d ago" },
  ]

  const argumentsFor = (command: Command) => (command.name === "/resume" ? sessions : [])
  const at = (input: string) => complete(input, input.length, COMMANDS, argumentsFor)

  it("lists every command for a bare slash and ranks prefix matches first", () => {
    expect(at("/")?.items).toHaveLength(COMMANDS.length)
    expect(at("/re")?.items.map((item) => item.value)).toEqual(["/resume", "/revert"])
    expect(at("/ex")?.items.map((item) => item.value)).toEqual(["/export", "/quit"])
    expect(at("/nothing")).toBeUndefined()
    expect(at("hello")).toBeUndefined()
    expect(complete("/re", 1, COMMANDS, argumentsFor)).toBeUndefined()
  })

  it("completes arguments by id or by title, including spaces", () => {
    expect(at("/resume ")?.items).toHaveLength(2)
    expect(at("/resume 01a1b")?.items.map((item) => item.label)).toEqual(["write docs"])
    expect(at("/resume flaky tests")?.items.map((item) => item.value)).toEqual(["01a1aaaa-0000"])
    expect(at("/help ")).toBeUndefined()
  })

  it("tab fills a command, adding a space when it takes an argument", () => {
    const [resume] = at("/res")?.items ?? []
    const completion = at("/res")

    if (completion === undefined || resume === undefined) throw new Error("expected a completion")

    expect(accept("/res", completion, resume)).toBe("/resume ")

    const picked = at("/resume wri")
    const [docs] = picked?.items ?? []

    if (picked === undefined || docs === undefined) throw new Error("expected a completion")

    expect(accept("/resume wri", picked, docs)).toBe("/resume 01a1bbbb-0000")
  })

  it("enter picks a partial match, opens the picker for a required argument, and runs exact input", () => {
    const enter = (input: string) => {
      const completion = at(input)
      const item = completion?.items[0]

      if (completion === undefined || item === undefined) throw new Error("expected a completion")

      return onEnter(input, completion, item)
    }

    expect(enter("/ev")).toEqual({ type: "send", text: "/evals" })
    expect(enter("/evals")).toEqual({ type: "submit" })
    expect(enter("/resume")).toEqual({ type: "fill", text: "/resume " })
    expect(enter("/resume ")).toEqual({ type: "send", text: "/resume 01a1aaaa-0000" })
    expect(enter("/sha")).toEqual({ type: "send", text: "/share" })
  })

  it("finds commands by alias and writes help from the registry", () => {
    expect(findCommand("/exit")?.name).toBe("/quit")
    expect(helpLines(COMMANDS).some((line) => line.startsWith("/resume <session>"))).toBe(true)
  })
})

describe("effort cycling", () => {
  const catalog = [
    { id: "big", name: "Big", efforts: EFFORTS },
    { id: "mid", name: "Mid", efforts: ["low", "medium", "high"] as const },
    { id: "old", name: "Old", efforts: [] },
  ]

  it("steps through the levels a model accepts and wraps", () => {
    expect(nextEffort("high", effortsFor(catalog, "big"))).toBe("xhigh")
    expect(nextEffort("max", effortsFor(catalog, "big"))).toBe("low")
    expect(nextEffort("high", effortsFor(catalog, "mid"))).toBe("low")
    expect(nextEffort("high", effortsFor(catalog, "old"))).toBeUndefined()
    expect(effortsFor([], "anything")).toEqual(EFFORTS)
  })

  it("keeps effort across a model switch, or steps down to what the new model accepts", () => {
    expect(fitEffort("high", effortsFor(catalog, "mid"))).toBe("high")
    expect(fitEffort("max", effortsFor(catalog, "mid"))).toBe("high")
    expect(fitEffort("max", effortsFor(catalog, "old"))).toBeUndefined()
  })
})
