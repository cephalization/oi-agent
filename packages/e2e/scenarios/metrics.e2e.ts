/**
 * Where a session's time went (issue #23, part 1): `oi metrics` and
 * `/metrics` read the start and end times every span already has. Nothing
 * here asks a model about time; the numbers are checked against the span
 * files the run wrote.
 */
import { kindOf, type SessionMetrics } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, scenario } from "../src/scenario.ts"
import { callBash } from "../src/steps.ts"

/** Slow enough to be the slowest call by far, and named for what took the time. */
const SLOW = "git --version && sleep 2"

/** Only the command: a time limit or `background` would end the call before the command does. */
const ASK = `${callBash(SLOW)} Pass only the command argument, and wait for it to finish. Then reply with just: done.`

describe("metrics", () => {
  scenario(
    "oi metrics lists a slow bash call under its command, and keeps model, tool and judge time apart",
    { approvals: "allow" },
    async (s) => {
      expectOk(await s.run(["run", "--yolo", `${ASK}`]))

      const session = s.spans.onlySession()
      const [turn] = await s.spans.settledTurns(session, 1)
      const printed = await s.run(["metrics", session, "--json"])

      expectOk(printed)

      // SAFETY: `oi metrics --json` prints exactly a SessionMetrics; the fields read below are asserted one by one.
      const metrics = JSON.parse(printed.stdout) as SessionMetrics
      const spans = s.spans.trace(session, turn?.trace_id ?? "")

      const ms = (kind: string): number =>
        spans
          .filter((span) => kindOf(span) === kind)
          .reduce((sum, span) => sum + (Date.parse(span.end_time) - Date.parse(span.start_time)), 0)

      expect(metrics.turns).toHaveLength(1)
      expect(metrics.turns[0]?.state).toBe("complete")
      expect(metrics.turns[0]?.prompt).toContain("Call the bash tool now")

      // The same durations the span files give, to the millisecond rounding of a timestamp.
      expect(Math.abs((metrics.turns[0]?.tool_ms ?? 0) - ms("TOOL"))).toBeLessThan(5)
      expect(Math.abs((metrics.turns[0]?.model_ms ?? 0) - ms("LLM"))).toBeLessThan(5)
      expect(metrics.turns[0]?.tool_ms).toBeGreaterThanOrEqual(2000)
      expect(metrics.turns[0]?.model_ms).toBeGreaterThan(0)
      expect(metrics.turns[0]?.tokens_in).toBeGreaterThan(0)

      expect(metrics.slowest[0]).toMatchObject({ turn: 1, tool: "bash", kind: "git", unfinished: false })
      expect(metrics.slowest[0]?.duration_ms).toBeGreaterThanOrEqual(2000)
      expect(metrics.by_kind[0]?.kind).toBe("git")

      // Judges run after a turn: whatever they took is not in the turn.
      expect(metrics.totals.wall_ms).toBe(metrics.turns[0]?.wall_ms)
      expect(metrics.totals.model_ms + metrics.totals.tool_ms).toBeLessThanOrEqual(metrics.totals.wall_ms + 5)

      const table = await s.run(["metrics"])

      expectOk(table)
      expect(table.stdout).toContain(`session ${session}`)
      expect(table.stdout).toMatch(/WHERE THE TOOL TIME WENT\n\s+2\.\ds\s+100%\s+git \(1 call\)/)
      expect(table.stdout).toMatch(/SLOWEST TOOL CALLS\n\s+2\.\ds\s+turn 1\s+git --version/)
    },
  )

  scenario(
    "/metrics prints the same tables in the terminal",
    { needs: ["rex"], approvals: "allow" },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/Every step is an OpenInference span/)
      await term.line("/metrics")
      await term.waitFor(/No turns yet: nothing has taken any time\./)

      await term.line(`${ASK}`)

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)
      await term.line("/metrics")

      const screen = await term.waitFor(/1 turn: \S+ of work over/)

      expect(screen).toMatch(/TURN\s+total\s+model\s+tools\s+calls/)
      expect(screen).toMatch(/2\.\ds\s+100%\s+git \(1 call\)/)
      expect(screen).toMatch(/2\.\ds\s+turn 1\s+git --version/)

      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )
})
