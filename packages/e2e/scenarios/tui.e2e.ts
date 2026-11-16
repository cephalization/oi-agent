/**
 * The interactive CLI, driven through a real terminal in Rex: typing,
 * approvals, slash commands and exit. Screens are checked for what a person
 * would see; spans for what actually happened.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { OI } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"
import { awaitApproval, callBash } from "../src/steps.ts"

const PROMPT = /^›\s*$/m

describe("interactive", () => {
  scenario("shows the answer and records the turn", { needs: ["rex"] }, async ({ tui, spans }) => {
    const term = await tui()

    await term.waitFor(/Every step is an OpenInference span/)
    await term.line("Reply with exactly the word: pong")

    const session = await spans.waitFor("a session", () => spans.sessions()[0])

    await spans.settledTurns(session, 1)

    const screen = await term.waitFor(/^pong\b/m)

    expect(screen).toMatch(/› Reply with exactly the word: pong/)
    expect(spans.turns(session)[0]?.state).toBe("complete")

    await term.line("/quit")
    expect(await term.exited()).toBe(0)
  })

  scenario(
    "the status line shows the latest call's context, and /session the running total",
    { needs: ["rex"], config: new Map([["steering", "off"]]) },
    async (s) => {
      const term = await s.tui(["--yolo"])

      await term.waitFor(PROMPT)
      await term.line("Reply with exactly the word: pong")

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)
      await term.line(callBash("echo context-check"))
      await s.spans.settledTurns(session, 2)
      await term.waitFor(/\d[\d.]*[kM]? context\b/)
      await term.line("/session")

      const screen = await term.waitFor(/Tokens used: \d+/)

      const calls = s.spans
        .ofKind(session, "LLM")
        .map((span) => Number(span.attributes[OI.TOKENS_TOTAL] ?? 0))

      const context = Number(/Context: (\d+) tokens/.exec(screen)?.[1])
      const used = Number(/Tokens used: (\d+)/.exec(screen)?.[1])

      // Three calls: the reply, then a tool call and the answer after it.
      expect(calls.length).toBeGreaterThanOrEqual(3)
      expect(context).toBe(calls.at(-1))
      expect(used).toBe(calls.reduce((sum, count) => sum + count, 0))
      expect(used).toBeGreaterThan(context)
      expect(screen).not.toMatch(/\d tokens(?! in| across)/)

      await term.line("/quit")
      expect(await term.exited()).toBe(0)

      const resumed = await s.tui(["-s", session])

      await resumed.waitFor(/\d[\d.]*[kM]? context\b/)
      await resumed.line("/session")

      const restored = await resumed.waitFor(/Tokens used: \d+/)

      expect(Number(/Context: (\d+) tokens/.exec(restored)?.[1])).toBe(context)
      expect(Number(/Tokens used: (\d+)/.exec(restored)?.[1])).toBe(used)
    },
  )

  scenario(
    "session switches start a fresh viewport without deleting scrollback",
    { needs: ["rex"] },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(PROMPT)
      const first = s.spans.onlySession()

      await term.line("/session")
      await term.waitFor(new RegExp(`Resume: oi -s ${first}`))
      await term.line("/new")

      const second = await s.spans.waitFor("second session", () =>
        s.spans.sessions().find((id) => id !== first),
      )

      await s.spans.waitFor("second session viewport", async () =>
        (await term.viewport()).includes(`session ${second.slice(0, 18)}`) ? true : undefined,
      )
      const secondView = await term.viewport()

      expect(secondView).toMatch(/^oi-agent /)
      expect(secondView).not.toContain(`Resume: oi -s ${first}`)
      expect(await term.screen()).toContain(`Resume: oi -s ${first}`)
      await term.line("/session")
      await term.waitFor(new RegExp(`Resume: oi -s ${second}`))
      await term.line(`/resume ${first}`)
      await s.spans.waitFor("first session viewport", async () =>
        (await term.viewport()).includes(`session ${first.slice(0, 18)}`) ? true : undefined,
      )
      const firstView = await term.viewport()

      expect(firstView).toMatch(/^oi-agent /)
      expect(firstView).not.toContain(`Resume: oi -s ${second}`)
      expect(await term.screen()).toContain(`Resume: oi -s ${second}`)
    },
  )

  scenario("asks before a mutating tool, and records allow and deny", { needs: ["rex"] }, async (s) => {
    const term = await s.tui()

    await term.waitFor(PROMPT)
    await term.line(callBash("echo approved-run"))
    await awaitApproval(s, term, "echo approved-run")
    await term.key("y")

    const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

    await s.spans.settledTurns(session, 1)

    await term.line(callBash("echo denied-run"))
    await awaitApproval(s, term, "echo denied-run")
    await term.key("n")
    await s.spans.settledTurns(session, 2)

    const bash = s.spans.tools(session).filter((tool) => tool.name === "bash")
    const allowed = bash.find((tool) => tool.input.includes("approved-run"))
    const denied = bash.find((tool) => tool.input.includes("denied-run"))

    expect(allowed?.output).toContain("approved-run")
    expect(allowed?.span.attributes["metadata"]).toMatch(/"decision":"allow"/)
    expect(denied?.output).not.toMatch(/^denied-run$/m)
    expect(denied?.span.attributes["metadata"]).toMatch(/"decision":"deny"/)
  })

  scenario(
    "the approval mode picked with Tab is the default the next time oi starts",
    { needs: ["rex"] },
    async (s) => {
      const first = await s.tui()

      await first.waitFor(PROMPT)
      // No decision model in the sandbox, so Tab goes from ask straight to yolo.
      await first.key("tab")
      await first.waitFor(/⏵⏵ yolo/)
      await first.line("/quit")
      expect(await first.exited()).toBe(0)

      const config = JSON.parse(fs.readFileSync(path.join(s.sandbox.configDir, "config.json"), "utf8"))

      expect(config).toMatchObject({ approvals: "allow", model: expect.any(String) })

      const second = await s.tui()

      await second.waitFor(/⏵⏵ yolo/)
      await second.line(callBash("echo remembered-yolo"))

      // The first start left an empty session behind; this one has the turn.
      const session = await s.spans.waitFor("the second session", () =>
        s.spans.sessions().find((id) => s.spans.turns(id).length > 0),
      )

      // Fails at once if the call waits for an approval: in ask mode it would.
      await s.spans.settledTurns(session, 1)

      const bash = s.spans.tools(session).find((tool) => tool.input.includes("remembered-yolo"))

      expect(bash?.output).toContain("remembered-yolo")
      expect(bash?.span.attributes["metadata"]).toMatch(/"decision":"allow"/)
    },
  )

  scenario("/new starts a second session and /resume returns to the first", { needs: ["rex"] }, async (s) => {
    const term = await s.tui()

    await term.waitFor(PROMPT)
    await term.line("Remember the word 'tangerine'. Reply with just: ok")

    const first = await s.spans.waitFor("first session", () => s.spans.sessions()[0])

    await s.spans.settledTurns(first, 1)
    await term.line("/new")

    await term.line("Reply with just: second")

    const second = await s.spans.waitFor("second session", () =>
      s.spans.sessions().find((id) => id !== first && s.spans.turns(id).length > 0),
    )

    await s.spans.settledTurns(second, 1)

    await term.line(`/resume ${first}`)
    await term.waitFor(new RegExp(`session ${first.slice(0, 13)}`))
    await term.line("Which word did I ask you to remember? Reply with just the word.")
    await s.spans.settledTurns(first, 2)

    const turns = s.spans.turns(first)

    expect(turns[1]?.previous).toBe(turns[0]?.trace_id)
    expect(turns[1]?.output?.toLowerCase()).toContain("tangerine")
    expect(s.spans.turns(second)).toHaveLength(1)
  })
})
