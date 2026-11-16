/**
 * Background commands (issue #49). A command that outlives its tool call
 * keeps running; the model gets what it printed so far, and its result comes
 * back later as a turn of its own that points at the `TOOL` span which
 * started it.
 *
 * The slow commands here wait for a file the scenario creates, not for a
 * length of time, so the order of turns does not depend on how fast a model
 * answers.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import {
  type EndedSpan,
  type EngineMetadata,
  readMetadata,
  SYSTEM_USER,
  stringAttr,
  OI,
} from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, type Scenario, scenario } from "../src/scenario.ts"

/** Prints `total=<a*b>` once the file `go` exists in the working directory. */
const gated = (a: number, b: number): string =>
  `until [ -f go ]; do sleep 0.2; done; echo total=$((${a} * ${b}))`

const release = (s: Scenario): void => fs.writeFileSync(path.join(s.sandbox.cwd, "go"), "")

const AFTER = "When its result is delivered to you later, reply with just the number after total="

interface Backgrounded {
  readonly tool: EndedSpan
  readonly job: NonNullable<EngineMetadata["job"]>
}

/** The `TOOL` span that left a job running, and the job. */
const backgrounded = (s: Scenario, session: string): Backgrounded => {
  const tool = s.spans
    .tools(session)
    .find((call) => call.name === "bash" && readMetadata(call.span).job !== undefined)?.span

  const job = tool === undefined ? undefined : readMetadata(tool).job

  if (tool === undefined || job === undefined) throw new Error(`no bash call left a job running`)

  return { tool, job }
}

describe("background commands", () => {
  scenario(
    "a command that outlives its time limit keeps running, and its result returns as a turn",
    {},
    async (s) => {
      // The job can only finish once the run has shown that the first turn ended without it.
      const releasing = s.spans
        .waitFor("the first turn to end", () => {
          const [session] = s.spans.sessions()
          const [turn] = session === undefined ? [] : s.spans.turns(session)

          return turn !== undefined && turn.state !== "running" ? turn : undefined
        })
        .then(() => release(s))

      const result = await s.run([
        "run",
        "--yolo",
        `Call the bash tool now with the command \`${gated(6, 7)}\` and timeout_ms 1500. ` +
          `It will still be running when the call returns: then call no more tools and reply with just: waiting. ${AFTER}.`,
      ])

      await releasing
      expectOk(result)

      const session = s.spans.onlySession()
      const turns = await s.spans.settledTurns(session, 2)
      const { tool, job } = backgrounded(s, session)

      expect(turns).toHaveLength(2)
      expect(turns[0]?.output?.toLowerCase()).toContain("waiting")

      // The call ended on time, without an error, saying where the command went.
      expect(tool.status_code).toBe("OK")
      expect(readMetadata(tool).job?.reason).toBe("timeout")
      expect(stringAttr(tool, OI.OUTPUT_VALUE)).toContain(`continues in the background as job ${job.id}`)

      // Its log is outside the session tree, which holds only scrubbed, immutable files.
      expect(job.log.startsWith(path.join(s.sandbox.home, "jobs", session))).toBe(true)
      expect(fs.readFileSync(job.log, "utf8")).toBe("total=42\n")

      // The result is a turn nobody typed, pointing at the inbox entry and the tool span.
      const delivery = turns[1]?.root

      expect(delivery === undefined ? undefined : stringAttr(delivery, OI.USER_ID)).toBe(SYSTEM_USER)
      expect(delivery === undefined ? undefined : readMetadata(delivery).delivers).toEqual([
        {
          kind: "job",
          id: job.id,
          trace_id: tool.context.trace_id,
          span_id: tool.context.span_id,
          inbox_id: `job-${job.id}`,
        },
      ])
      expect(turns[1]?.input).toContain(`job ${job.id}: exited with code 0`)
      expect(turns[1]?.output).toContain("42")
      expect(result.stdout).toContain("42")
    },
  )

  scenario(
    "a job outlives the process that started it, and the next process delivers its result",
    {},
    async (s) => {
      const first = await s.run([
        "run",
        "--yolo",
        "--no-wait",
        `Call the bash tool now with the command \`${gated(9, 9)}\` and background set to true. ` +
          `Then call no more tools and reply with just: started. ${AFTER}.`,
      ])

      expectOk(first)

      const session = s.spans.onlySession()
      const { job } = backgrounded(s, session)

      expect(await s.spans.settledTurns(session, 1)).toHaveLength(1)
      expect(fs.existsSync(path.join(path.dirname(job.log), "exit"))).toBe(false)

      // The process that started the job is gone. It finishes with nobody watching.
      release(s)
      await s.spans.waitFor("the job to exit", () =>
        fs.existsSync(path.join(path.dirname(job.log), "exit")) ? true : undefined,
      )

      expectOk(await s.run(["run", "--yolo", "-s", session, "Reply with just: pong"]))

      const turns = await s.spans.settledTurns(session, 3)
      const delivery = turns.find((turn) => readMetadata(turn.root).delivers !== undefined)

      expect(turns).toHaveLength(3)
      expect(readMetadata(delivery?.root ?? turns[0]!.root).delivers?.[0]?.id).toBe(job.id)
      expect(delivery?.input).toContain("total=81")
      expect(delivery?.output).toContain("81")
    },
  )

  scenario(
    "the terminal takes a prompt while a job runs, counts it in the status line, and shows its result",
    { needs: ["rex"], approvals: "allow" },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/Every step is an OpenInference span/)
      await term.line(
        `Call the bash tool now with the command \`${gated(5, 5)}\` and background set to true. ` +
          `Then call no more tools and reply with just: started. ${AFTER}.`,
      )

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)
      await term.waitFor(/1 job running/)

      // The conversation is free while the job runs.
      await term.line("Reply with exactly the word: pong")

      const during = await s.spans.settledTurns(session, 2)

      expect(during[1]?.output?.toLowerCase()).toContain("pong")
      expect(readMetadata(during[1]!.root).delivers).toBeUndefined()

      release(s)

      const turns = await s.spans.settledTurns(
        await s.spans.waitFor("the delivery", () =>
          s.spans.turns(session).length === 3 ? session : undefined,
        ),
        3,
      )

      const { job } = backgrounded(s, session)

      expect(readMetadata(turns[2]!.root).delivers?.[0]?.id).toBe(job.id)
      expect(turns[2]?.output).toContain("25")

      const screen = await term.waitFor(new RegExp(`result of background job ${job.id} delivered`))

      // Nobody typed the delivery: it shows as a notice, not as a prompt.
      expect(screen).not.toContain("<background-results>")
      await term.waitFor(/^(?![\s\S]*job running)/)

      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )
})
