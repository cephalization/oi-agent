/**
 * Crash safety: kill the CLI with SIGKILL in the middle of a tool call,
 * then resume. The interrupted turn must show as interrupted, and the next
 * turn's request must carry the unfinished call as interrupted, rebuilt
 * from the span files alone.
 */
import { INTERRUPTED_RESULT, kindOf, OI, stringAttr } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"

describe("crash and resume", () => {
  scenario(
    "a SIGKILL mid-tool leaves an interrupted turn that the next turn folds in",
    { needs: ["rex"], approvals: "allow" },
    async ({ tui, spans }) => {
      const term = await tui()

      await term.waitFor(/Every step is an OpenInference span/)
      await term.line(
        "Run exactly `sleep 25 && echo slept` with the bash tool, then tell me what it printed.",
      )

      const session = await spans.waitFor("a session", () => spans.sessions()[0])

      // Wait until the bash call is in flight, then kill its owner.
      await spans.waitFor("bash in flight", () =>
        spans
          .open(session)
          .find((span) => kindOf(span) === "TOOL" && stringAttr(span, OI.TOOL_NAME) === "bash"),
      )

      const pid = await spans.waitFor("owner pid", () => spans.ownerPid(session))

      process.kill(pid, "SIGKILL")
      await term.exited(5000)

      // Once its heartbeat goes stale, the turn reads as interrupted.
      const [crashed] = await spans.waitFor(
        "the turn to read as interrupted",
        () => {
          const turns = spans.turns(session)

          return turns[0]?.state === "interrupted" ? turns : undefined
        },
        30_000,
      )

      const resumed = await tui(["resume", session])

      await resumed.waitFor(/›/)
      await resumed.line("Did that command finish? Answer in one short sentence.")

      const turns = await spans.settledTurns(session, 2)
      const next = turns[1]

      expect(next?.state).toBe("complete")
      expect(next?.previous).toBe(crashed?.trace_id)

      const request = spans.trace(session, next?.trace_id ?? "").find((span) => kindOf(span) === "LLM")

      expect(stringAttr(request ?? crashed!.root, OI.INPUT_VALUE)).toContain(INTERRUPTED_RESULT)
    },
  )
})
