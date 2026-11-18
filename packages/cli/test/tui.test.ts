import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vite-plus/test"
import { droppedImages, readImage, shellWords } from "../src/images.ts"
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
import { approvalAction } from "../src/tui/approvals.ts"
import { Editor, normalizeKeys } from "../src/tui/editor.ts"
import { effortsFor, fitEffort, nextEffort, parseModelArgument } from "../src/tui/modes.ts"
import { type AnnotationFile, EFFORTS, DECISION_ATTR, type EndedSpan, OI } from "@oi-agent/engine"
import { Screen } from "../src/tui/screen.ts"
import { compact, Transcript } from "../src/tui/transcript.ts"
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

  it.each(["\u001B[13;2u", "\u001B[27;2;13~"])("inserts a newline for Shift+Enter (%s)", (key) => {
    const editor = new Editor()

    editor.feed("first")
    expect(editor.feed(key).type).toBe("redraw")
    editor.feed("second")
    expect(editor.feed("\r")).toEqual({ type: "submit", text: "first\nsecond" })
  })

  it("keeps pasted newlines instead of submitting", () => {
    const editor = new Editor()

    expect(editor.feed("\u001B[200~line one\rline two\u001B[201~").type).toBe("redraw")
    expect(editor.text).toBe("line one\nline two")
  })

  it("hands a finished paste to the application, whole, however it arrived", () => {
    const editor = new Editor()
    const pastes: Array<string> = []

    editor.onPaste = (text) => {
      pastes.push(text)

      // Taken as something else (dropped files): nothing goes into the line.
      return text.includes("shot") ? "" : text
    }

    editor.feed("see ")
    editor.feed("\u001B[200~/tmp/sh")
    expect(pastes).toEqual([])
    editor.feed("ot.png\u001B[201~")
    expect(pastes).toEqual(["/tmp/shot.png"])
    expect(editor.text).toBe("see ")
    editor.feed("\u001B[200~plain text\u001B[201~")
    expect(editor.text).toBe("see plain text")
  })

  it("normalizes modified-key shortcuts without changing Shift+Enter", () => {
    expect(normalizeKeys("\u001B[116;5u")).toBe("\u0014")
    expect(normalizeKeys("\u001B[9;2u")).toBe("\u001B[Z")
    expect(normalizeKeys("\u001B[27u")).toBe("\u001B")
    expect(normalizeKeys("\u001B[13;2u")).toBe("\u001B[13;2u")
  })

  it("restores the latest queued prompt with earlier messages reachable using arrows", () => {
    const editor = new Editor()

    editor.feed("older\r")
    editor.feed("latest\r")
    editor.restore(["older", "latest"])
    expect(editor.text).toBe("latest")
    editor.feed("\u001B[A")
    expect(editor.text).toBe("older")
    editor.feed("\u001B[B")
    expect(editor.text).toBe("latest")
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
  it("does not advance fence state when partial lines are redrawn", () => {
    for (const redraws of [1, 2, 3]) {
      const markdown = new MarkdownStream()

      for (let i = 0; i < redraws; i += 1) {
        expect(markdown.preview("```ts")).toBe(style.gray("```ts"))
      }

      expect(markdown.preview("plain")).toBe("plain")
      markdown.line("```ts")
      expect(markdown.preview("const x = 1")).toBe(`  ${style.cyan("const x = 1")}`)
      expect(markdown.line("const x = 1")).toBe(`  ${style.cyan("const x = 1")}`)

      for (let i = 0; i < redraws; i += 1) markdown.preview("```")

      expect(markdown.preview("still code")).toBe(`  ${style.cyan("still code")}`)
      markdown.line("```")
      expect(markdown.preview("plain")).toBe("plain")
      expect(markdown.line("plain")).toBe("plain")
    }
  })

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
    expect(at("/re")?.items.map((item) => item.value)).toEqual(["/resume", "/revert", "/reload"])
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
    { id: "big", name: "Big", provider: "anthropic", efforts: EFFORTS },
    { id: "mid", name: "Mid", provider: "anthropic", efforts: ["low", "medium", "high"] as const },
    { id: "old", name: "Old", provider: "anthropic", efforts: [] },
  ]

  it("steps through the levels a model accepts and wraps", () => {
    expect(nextEffort("high", effortsFor(catalog, { provider: "anthropic", model: "big" }))).toBe("xhigh")
    expect(nextEffort("max", effortsFor(catalog, { provider: "anthropic", model: "big" }))).toBe("low")
    expect(nextEffort("high", effortsFor(catalog, { provider: "anthropic", model: "mid" }))).toBe("low")
    expect(nextEffort("high", effortsFor(catalog, { provider: "anthropic", model: "old" }))).toBeUndefined()
    expect(effortsFor([], { provider: "anthropic", model: "anything" })).toEqual(EFFORTS)
    expect(effortsFor([], { provider: "openai", model: "gpt-5.1" })).toEqual(["low", "medium", "high"])
    expect(effortsFor([], { provider: "openai", model: "gpt-4.1" })).toEqual([])
    expect(effortsFor([], { provider: "ollama", model: "qwen3" })).toEqual([])
  })

  it("keeps effort across a model switch, or steps down to what the new model accepts", () => {
    expect(fitEffort("high", effortsFor(catalog, { provider: "anthropic", model: "mid" }))).toBe("high")
    expect(fitEffort("max", effortsFor(catalog, { provider: "anthropic", model: "mid" }))).toBe("high")
    expect(fitEffort("max", effortsFor(catalog, { provider: "anthropic", model: "old" }))).toBeUndefined()
  })

  it("reads --temp before or after the model in /model's argument", () => {
    expect(parseModelArgument("chatgpt/gpt-5.6-luna")).toEqual({
      argument: "chatgpt/gpt-5.6-luna",
      temporary: false,
    })
    expect(parseModelArgument("--temp chatgpt/gpt-5.6-luna")).toEqual({
      argument: "chatgpt/gpt-5.6-luna",
      temporary: true,
    })
    expect(parseModelArgument("chatgpt/gpt-5.6-luna  --temp ")).toEqual({
      argument: "chatgpt/gpt-5.6-luna",
      temporary: true,
    })
    expect(parseModelArgument("--temp")).toEqual({ argument: "", temporary: true })
  })
})

describe("decision usage", () => {
  it("counts decision tokens separately from LLM tokens, with a TypeSafe-rate estimate", () => {
    const transcript = new Transcript(new Screen(process.stdout), "tony")

    const decision: EndedSpan = {
      name: "decision approval",
      context: { trace_id: "t", span_id: "s" },
      parent_id: "p",
      span_kind: "SPAN_KIND_INTERNAL",
      start_time: "2026-11-13T00:00:00.000Z",
      end_time: "2026-11-13T00:00:01.000Z",
      status_code: "OK",
      status_message: "",
      events: [],
      attributes: {
        [OI.SPAN_KIND]: "DECISION",
        [DECISION_ATTR.TOKENS_INPUT]: 1000,
        [DECISION_ATTR.TOKENS_OUTPUT]: 50,
      },
    }

    transcript.onEvent({ type: "span_end", session_id: "session", span: decision })
    expect(transcript.totalTokens).toBe(0)
    expect(transcript.decisionTokens).toBe(1050)
    expect(transcript.decisionCost).toBeCloseTo(0.000042, 8)
  })
})

describe("context usage", () => {
  const span = (
    trace: string,
    kind: string,
    end: string,
    tokens: { prompt: number; completion: number },
    extra: Readonly<Record<string, string>> = {},
  ): EndedSpan => ({
    name: kind.toLowerCase(),
    context: { trace_id: trace, span_id: `${trace}-${end}` },
    parent_id: kind === "AGENT" ? null : "root",
    span_kind: "SPAN_KIND_INTERNAL",
    start_time: end,
    end_time: end,
    status_code: "OK",
    status_message: "",
    events: [],
    attributes: {
      [OI.SPAN_KIND]: kind,
      [OI.TOKENS_PROMPT]: tokens.prompt,
      [OI.TOKENS_COMPLETION]: tokens.completion,
      [OI.TOKENS_TOTAL]: tokens.prompt + tokens.completion,
      ...extra,
    },
  })

  const start = (transcript: Transcript, trace: string, metadata?: string): void => {
    const root = span(trace, "AGENT", "2026-11-13T00:00:00.000Z", { prompt: 0, completion: 0 })

    transcript.onEvent({
      type: "span_open",
      session_id: "session",
      span:
        metadata === undefined
          ? root
          : { ...root, attributes: { ...root.attributes, [OI.METADATA]: metadata } },
    })
  }

  const end = (transcript: Transcript, file: EndedSpan): void =>
    transcript.onEvent({ type: "span_end", session_id: "session", span: file })

  it("shows the latest agent call as context, while the total adds every call up", () => {
    const transcript = new Transcript(new Screen(process.stdout), "tony")

    start(transcript, "turn")
    end(transcript, span("turn", "LLM", "2026-11-13T00:00:01.000Z", { prompt: 1000, completion: 100 }))
    end(transcript, span("turn", "LLM", "2026-11-13T00:00:02.000Z", { prompt: 1200, completion: 50 }))
    // An evaluator's judge is a separate trace: billed, but not this conversation's context.
    end(transcript, span("judge", "LLM", "2026-11-13T00:00:03.000Z", { prompt: 9000, completion: 10 }))

    expect(transcript.contextTokens).toBe(1250)
    expect(transcript.totalTokens).toBe(1100 + 1250 + 9010)

    // Loading a session can deliver an older call last.
    end(transcript, span("turn", "LLM", "2026-11-13T00:00:00.500Z", { prompt: 10, completion: 1 }))
    expect(transcript.contextTokens).toBe(1250)
  })

  it("after a compaction, the context is the brief", () => {
    const transcript = new Transcript(new Screen(process.stdout), "tony")

    start(transcript, "compact", JSON.stringify({ oi_agent: { operation: "compact" } }))
    end(transcript, span("compact", "LLM", "2026-11-13T00:00:05.000Z", { prompt: 50_000, completion: 800 }))

    expect(transcript.contextTokens).toBe(800)
  })
})

describe("approval dialog keys", () => {
  it("allows or denies one call in auto without a yolo action", () => {
    expect(approvalAction("auto", "y")).toBe("allow")
    expect(approvalAction("auto", "n")).toBe("deny")
    expect(approvalAction("auto", "a")).toBeUndefined()
    expect(approvalAction("auto", "A")).toBeUndefined()
  })

  it("offers the explicit yolo shortcut only in ask mode", () => {
    expect(approvalAction("ask", "a")).toBe("yolo")
    expect(approvalAction("ask", "Y")).toBe("allow")
    expect(approvalAction("ask", "N")).toBe("deny")
    expect(approvalAction("allow", "a")).toBeUndefined()
    expect(approvalAction("deny", "a")).toBeUndefined()
  })

  it.each(["", "na", "yn", "yes", "y\r", "\t"])("ignores non-single-key input %j", (key) => {
    expect(approvalAction("ask", key)).toBeUndefined()
    expect(approvalAction("auto", key)).toBeUndefined()
  })
})

describe("compact counts", () => {
  it("keeps three significant figures and moves up a unit instead of growing", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, "0"],
      [999, "999"],
      [1000, "1.0k"],
      [1234, "1.2k"],
      [45_678, "46k"],
      [999_499, "999k"],
      [999_950, "1.0M"],
      [6_000_500, "6.0M"],
      [12_345_678, "12M"],
      [2_000_000_000, "2.0B"],
    ]

    for (const [count, text] of cases) expect(compact(count)).toBe(text)
  })
})

/** A screen that keeps what was committed instead of drawing it. */
class RecordingScreen extends Screen {
  readonly committed: Array<string> = []

  override commit(lines: ReadonlyArray<string>): void {
    this.committed.push(...lines.map(strip))
  }
}

const verdict = (traceId: string, name: string, failed: boolean): AnnotationFile => ({
  id: `${traceId}-${name}`,
  scope: "trace",
  target: { session_id: "s", trace_id: traceId },
  created_at: "2026-11-15T00:00:00.000Z",
  annotation: {
    name,
    label: failed ? "fail" : "pass",
    annotator_kind: "CODE",
    explanation: `${name} explanation`,
    metadata: { failed, feedback: failed },
  },
})

describe("evaluator verdicts", () => {
  it("counts passes for the status line and prints only failures", () => {
    const screen = new RecordingScreen(process.stdout)
    const transcript = new Transcript(screen, "tony")

    transcript.annotation(verdict("t1", "uses_pnpm", false))
    transcript.annotation(verdict("t1", "ran_tests", false))
    transcript.annotation(verdict("t1", "no_secrets", true))
    const waiting = verdict("t1", "outcome", false)
    transcript.annotation({
      ...waiting,
      annotation: {
        ...waiting.annotation,
        label: "pending",
        metadata: { pending: true, failed: false, feedback: false },
      },
    })

    expect(transcript.passedEvals).toBe(2)
    expect(screen.committed).toEqual(["◆ no_secrets: fail — no_secrets explanation"])

    // The next turn's verdicts replace the count rather than adding to it.
    transcript.annotation(verdict("t2", "uses_pnpm", false))
    expect(transcript.passedEvals).toBe(1)
    transcript.annotation({
      ...waiting,
      target: { ...waiting.target, trace_id: "t3" },
      annotation: { ...waiting.annotation, label: "pending" },
    })
    expect(transcript.passedEvals).toBe(0)
  })
})

describe("images dropped on the terminal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-drop-"))
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  fs.writeFileSync(path.join(dir, "plain.png"), pngBytes)
  fs.writeFileSync(path.join(dir, "with space.png"), pngBytes)
  fs.writeFileSync(path.join(dir, "it's.png"), pngBytes)
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an image")
  fs.writeFileSync(path.join(dir, "liar.png"), "not an image either")

  it("splits a paste the way each terminal quotes a dropped path", () => {
    expect(shellWords(String.raw`/a/with\ space.png /b/plain.png`)).toEqual([
      "/a/with space.png",
      "/b/plain.png",
    ])
    expect(shellWords(`'/a/with space.png' "/b/it's.png"`)).toEqual(["/a/with space.png", "/b/it's.png"])
    expect(shellWords("  /a.png\n/b.png\n")).toEqual(["/a.png", "/b.png"])
  })

  it("takes a paste as a drop only when all of it is image files", () => {
    const plain = path.join(dir, "plain.png")
    const spaced = path.join(dir, "with space.png")

    expect(droppedImages(plain, dir)).toEqual([plain])
    expect(droppedImages(`${plain} ${spaced.replaceAll(" ", String.raw`\ `)}`, dir)).toEqual([plain, spaced])
    expect(droppedImages(`'${spaced}'`, dir)).toEqual([spaced])
    expect(droppedImages(pathToFileURL(spaced).href, dir)).toEqual([spaced])
    expect(droppedImages("plain.png", dir)).toEqual([plain])

    // Prose, a path in prose, a file that is not an image, one that only claims to be: all stay text.
    expect(droppedImages("look at this", dir)).toBeUndefined()
    expect(droppedImages(`look at ${plain}`, dir)).toBeUndefined()
    expect(droppedImages(path.join(dir, "notes.txt"), dir)).toBeUndefined()
    expect(droppedImages(path.join(dir, "liar.png"), dir)).toBeUndefined()
    expect(droppedImages(`${plain} ${path.join(dir, "missing.png")}`, dir)).toBeUndefined()
    expect(droppedImages(dir, dir)).toBeUndefined()
  })

  it("reads an image for attaching, or says why it cannot", () => {
    expect(readImage("plain.png", dir)).toEqual({ name: "plain.png", bytes: pngBytes })
    expect(readImage("missing.png", dir)).toBe("Could not read missing.png.")
  })
})
