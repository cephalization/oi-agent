/**
 * The interactive CLI, driven through a real terminal in Rex: typing,
 * approvals, slash commands and exit. Screens are checked for what a person
 * would see; spans for what actually happened.
 */
import { describe, expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"

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

  scenario("asks before a mutating tool, and records allow and deny", { needs: ["rex"] }, async (s) => {
    const term = await s.tui()

    await term.waitFor(PROMPT)
    // Models tend to ask in prose first; say that oi does the asking.
    await term.line(
      "Call the bash tool now with the command `echo approved-run`. Don't ask me first: oi asks me itself.",
    )
    await term.waitFor(/Allow bash/)
    await term.key("y")

    const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

    await s.spans.settledTurns(session, 1)

    await term.line("Now call the bash tool with `echo denied-run`, without asking me first.")
    await term.waitFor(/Allow bash[\s\S]*denied-run/)
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
