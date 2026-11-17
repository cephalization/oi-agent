import { readMetadata, type SessionMetrics } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, scenario } from "../src/scenario.ts"
import { awaitApproval, callBash } from "../src/steps.ts"

describe("approval timing", () => {
  scenario(
    "approval wait is wall time, not tool execution",
    { needs: ["rex"], config: new Map([["steering", "off"]]) },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/Every step is an OpenInference span/)
      await term.line(callBash("echo timing-check"))
      await awaitApproval(s, term, "echo timing-check")

      const session = s.spans.onlySession()
      const waitingSince = Date.now()

      // Deliberately keep approval pending, checking the clock through the harness.
      await s.spans.waitFor("two seconds waiting for approval", () =>
        Date.now() - waitingSince >= 2000 ? true : undefined,
      )

      const pending = await s.run(["metrics", session, "--json"])

      expectOk(pending)
      // SAFETY: metrics --json emits SessionMetrics; the timing fields are checked below.
      const pendingMetrics = JSON.parse(pending.stdout) as SessionMetrics

      expect(pendingMetrics.totals.tool_ms).toBe(0)
      await term.key("y")
      await s.spans.settledTurns(session, 1)

      const tool = s.spans.tools(session).find((entry) => entry.name === "bash")
      const printed = await s.run(["metrics", session, "--json"])

      expectOk(printed)
      // SAFETY: metrics --json emits SessionMetrics; the timing fields are checked below.
      const metrics = JSON.parse(printed.stdout) as SessionMetrics
      const executionStart = readMetadata(tool!.span).execution_started_at

      expect(executionStart).toBeTypeOf("string")
      expect(metrics.totals.wall_ms - metrics.totals.tool_ms).toBeGreaterThanOrEqual(2000)
      expect(metrics.totals.tool_ms).toBeLessThan(
        Date.parse(tool!.span.end_time) - Date.parse(tool!.span.start_time) - 1500,
      )

      const toolLine = (await term.screen())
        .split("\n")
        .find((line) => line.includes("⏵ bash") && line.includes("✓"))

      expect(toolLine).toContain(`${(metrics.totals.tool_ms / 1000).toFixed(1)}s`)

      await term.line(callBash("echo timing-second"))
      await awaitApproval(s, term, "echo timing-second")
      await term.key("n")
      await s.spans.settledTurns(session, 2)

      const denied = await s.run(["metrics", session, "--json"])

      expectOk(denied)
      // SAFETY: metrics --json emits SessionMetrics.
      const deniedMetrics = JSON.parse(denied.stdout) as SessionMetrics

      expect(deniedMetrics.turns[1]?.tool_ms).toBe(0)
      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )
})
