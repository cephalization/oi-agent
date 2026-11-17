import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { type EndedSpan, OI, type SpanFile, spanFileName, writeMetadata } from "../src/format.ts"
import { isoToNs, newSpanId, newTraceId, nsToIso } from "../src/ids.ts"
import { commandFamily, commandSteps, renderMetrics, sessionMetrics, shortDuration } from "../src/metrics.ts"
import type { Store } from "../src/store.ts"
import { tempStore } from "./helpers.ts"

/** A fixed start, so every duration below is exact. */
const T0 = Date.parse("2026-11-01T10:00:00Z")

const at = (seconds: number): string => nsToIso(BigInt(T0 + seconds * 1000) * 1_000_000n)

interface Child {
  readonly kind: "LLM" | "TOOL"
  readonly from: number
  readonly to: number
  /** A bash command, for a `TOOL`. */
  readonly command?: string
  readonly tokens?: readonly [input: number, output: number, cached: number]
}

class Session {
  readonly store: Store
  readonly id: string
  private previous: EndedSpan["context"] | null = null

  constructor(store: Store = tempStore()) {
    this.store = store
    this.id = store.createSession("/fixture").id
  }

  private span(
    traceId: string,
    parent: string | null,
    kind: string,
    from: number,
    to: number,
    attributes: SpanFile["attributes"],
  ): EndedSpan {
    return {
      name: kind.toLowerCase(),
      context: { trace_id: traceId, span_id: newSpanId() },
      parent_id: parent,
      span_kind: "SPAN_KIND_INTERNAL",
      start_time: at(from),
      end_time: at(to),
      status_code: "OK",
      status_message: "",
      events: [],
      attributes: { [OI.SPAN_KIND]: kind, [OI.SESSION_ID]: this.id, ...attributes },
    }
  }

  private children(traceId: string, rootId: string, children: ReadonlyArray<Child>): Array<EndedSpan> {
    return children.map((child) =>
      this.span(
        traceId,
        rootId,
        child.kind,
        child.from,
        child.to,
        child.kind === "LLM"
          ? {
              [OI.TOKENS_PROMPT]: child.tokens?.[0] ?? 0,
              [OI.TOKENS_COMPLETION]: child.tokens?.[1] ?? 0,
              [OI.TOKENS_CACHE_READ]: child.tokens?.[2] ?? 0,
            }
          : {
              [OI.TOOL_NAME]: child.command === undefined ? "read_file" : "bash",
              [OI.INPUT_VALUE]:
                child.command === undefined ? '{"path":"a.txt"}' : JSON.stringify({ command: child.command }),
            },
      ),
    )
  }

  /** A finished turn. */
  turn(input: string, from: number, to: number, children: ReadonlyArray<Child>): string {
    const traceId = newTraceId()

    const root = this.span(traceId, null, "AGENT", from, to, {
      [OI.USER_ID]: "tony",
      [OI.INPUT_VALUE]: input,
      [OI.OUTPUT_VALUE]: "done",
      [OI.METADATA]: writeMetadata(undefined, { previous: this.previous }),
    })

    for (const span of [...this.children(traceId, root.context.span_id, children), root])
      this.store.endSpan(this.id, span)

    this.previous = root.context

    return traceId
  }

  /** A turn that crashed inside a tool call: the root and the call never ended. */
  crashed(input: string, from: number, done: ReadonlyArray<Child>, hung: { from: number; command: string }) {
    const traceId = newTraceId()

    const root = this.span(traceId, null, "AGENT", from, from, {
      [OI.USER_ID]: "tony",
      [OI.INPUT_VALUE]: input,
      [OI.METADATA]: writeMetadata(undefined, { previous: this.previous }),
    })

    const tool = this.span(traceId, root.context.span_id, "TOOL", hung.from, hung.from, {
      [OI.TOOL_NAME]: "bash",
      [OI.INPUT_VALUE]: JSON.stringify({ command: hung.command }),
    })

    for (const span of this.children(traceId, root.context.span_id, done)) this.store.endSpan(this.id, span)

    for (const span of [root, tool]) {
      const open: SpanFile = { ...span, end_time: null }

      this.store.openSpan(this.id, open, false)

      // No heartbeat since long ago: nothing is writing this span any more.
      const file = `${path.join(this.store.traceDir(this.id, traceId), spanFileName(isoToNs(span.start_time), span.context.span_id))}.open.json`
      const stale = new Date(T0 + (hung.from + 3) * 1000)

      fs.utimesSync(file, stale, stale)
    }
  }

  /** A trace that is not a turn: an evaluator, with one model call of its own. */
  judge(from: number, to: number, tokens: readonly [number, number]): void {
    const traceId = newTraceId()
    const root = this.span(traceId, null, "EVALUATOR", from, to, {})

    const llm = this.span(traceId, root.context.span_id, "LLM", from, to, {
      [OI.TOKENS_PROMPT]: tokens[0],
      [OI.TOKENS_COMPLETION]: tokens[1],
    })

    this.store.endSpan(this.id, llm)
    this.store.endSpan(this.id, root)
  }
}

describe("naming what a shell command ran", () => {
  it("splits a command into steps outside quotes, without heredoc bodies or what output is piped into", () => {
    expect(commandSteps("cd pkg && FOO=1 pnpm test | tail -5; echo 'a; b && c'")).toEqual([
      "cd pkg",
      "pnpm test",
      "echo 'a; b && c'",
    ])
    expect(commandSteps("cat > f.txt <<'EOF'\npnpm e2e; rm -rf x\nEOF\ngit status")).toEqual([
      "cat > f.txt",
      "git status",
    ])
  })

  it("names the step that took the time, not the first one or the one that reads its log", () => {
    expect(commandFamily("pnpm e2e scenarios/run.e2e.ts")).toBe("pnpm e2e")
    expect(commandFamily("cat > note.md <<EOF\nhello\nEOF\npnpm e2e > /tmp/log 2>&1; tail -5 /tmp/log")).toBe(
      "pnpm e2e",
    )
    expect(commandFamily("sed -i 's/a;b/c/g' file.ts && git add -A && git commit -m 'x; y'")).toBe(
      "git commit",
    )
    expect(commandFamily("/usr/bin/rg -n foo src")).toBe("rg")
    expect(commandFamily("cargo --version")).toBe("cargo")
    // Nothing but waiting and reading: it was the waiting.
    expect(commandFamily("sleep 30; tail -3 /tmp/log")).toBe("sleep")
    expect(commandFamily("until [ -f go ]; do sleep 0.2; done; echo ok")).toBe("sleep")
    expect(commandFamily("echo one; echo two")).toBe("echo")
  })
})

describe("a session's metrics", () => {
  it("splits each turn into model and tool time, and keeps judge time out of every turn", () => {
    const s = new Session()

    s.turn("Fix the bug\nand more detail", 0, 100, [
      { kind: "LLM", from: 0, to: 10, tokens: [1000, 50, 800] },
      { kind: "TOOL", from: 10, to: 70, command: "cd pkg && pnpm e2e > /tmp/log 2>&1; tail -3 /tmp/log" },
      { kind: "TOOL", from: 70, to: 72 },
      { kind: "LLM", from: 72, to: 100, tokens: [2000, 100, 1500] },
    ])
    s.judge(100, 130, [400, 20])
    s.turn("Now commit it", 200, 220, [
      { kind: "LLM", from: 200, to: 205, tokens: [3000, 10, 2500] },
      { kind: "TOOL", from: 205, to: 220, command: "git add -A && git commit -m done" },
    ])

    const metrics = sessionMetrics(s.store, s.id, { nowMs: T0 + 1_000_000 })

    expect(metrics.turns).toMatchObject([
      {
        prompt: "Fix the bug",
        state: "complete",
        wall_ms: 100_000,
        model_ms: 38_000,
        tool_ms: 62_000,
        model_calls: 2,
        tool_calls: 2,
        tokens_in: 3000,
        tokens_out: 150,
        tokens_cached: 2300,
      },
      { prompt: "Now commit it", wall_ms: 20_000, model_ms: 5000, tool_ms: 15_000 },
    ])
    expect(metrics.slowest.map((call) => [call.turn, call.kind, call.summary, call.duration_ms])).toEqual([
      [1, "pnpm e2e", "pnpm e2e > /tmp/log 2>&1", 60_000],
      [2, "git commit", "git commit -m done", 15_000],
      [1, "read_file", 'read_file {"path":"a.txt"}', 2000],
    ])
    expect(metrics.by_kind).toEqual([
      { kind: "pnpm e2e", duration_ms: 60_000, calls: 1 },
      { kind: "git commit", duration_ms: 15_000, calls: 1 },
      { kind: "read_file", duration_ms: 2000, calls: 1 },
    ])
    expect(metrics.totals).toMatchObject({
      elapsed_ms: 220_000,
      wall_ms: 120_000,
      model_ms: 43_000,
      tool_ms: 77_000,
      judge_ms: 30_000,
      judge_calls: 1,
      tokens_in: 6000,
      judge_tokens_in: 400,
      judge_tokens_out: 20,
    })
    expect(metrics.totals.bytes).toBeGreaterThan(0)
  })

  it("marks a crashed turn as interrupted and measures it up to the last thing it recorded", () => {
    const s = new Session()

    s.turn("first", 0, 10, [{ kind: "LLM", from: 0, to: 10 }])
    s.crashed("run the suite", 20, [{ kind: "LLM", from: 20, to: 25 }], { from: 25, command: "pnpm e2e" })

    // Days later: the open spans are not still running.
    const metrics = sessionMetrics(s.store, s.id, { nowMs: T0 + 5 * 86_400_000 })

    expect(metrics.turns[1]).toMatchObject({
      prompt: "run the suite",
      state: "interrupted",
      wall_ms: 8000,
      model_ms: 5000,
      tool_ms: 3000,
    })
    expect(metrics.slowest[0]).toMatchObject({ kind: "pnpm e2e", duration_ms: 3000, unfinished: true })

    const text = renderMetrics(metrics, 100).join("\n")

    expect(text).toContain("run the suite (interrupted)")
    expect(text).toContain("pnpm e2e (unfinished)")
  })

  it("renders within the width it is given, and says so when there is nothing to show", () => {
    const s = new Session()

    expect(renderMetrics(sessionMetrics(s.store, s.id))).toEqual([
      "No turns yet: nothing has taken any time.",
    ])

    for (let index = 0; index < 15; index += 1)
      s.turn(`turn ${index} ${"with a very long prompt ".repeat(8)}`, index * 100, index * 100 + index + 1, [
        { kind: "TOOL", from: index * 100, to: index * 100 + 1, command: `${"x".repeat(200)} --flag` },
      ])

    const lines = renderMetrics(sessionMetrics(s.store, s.id), 72)

    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(72)
    expect(lines.some((line) => line.startsWith("… 3 shorter turns"))).toBe(true)
    expect(lines.at(-4)).toMatch(/^15 turns: 2\.0m of work over /)
  })

  it("writes durations short enough for a column", () => {
    expect([450, 1500, 16_000, 59_400, 504_000, 7_560_000].map(shortDuration)).toEqual([
      "450ms",
      "1.5s",
      "16s",
      "59s",
      "8.4m",
      "2.1h",
    ])
  })
})
