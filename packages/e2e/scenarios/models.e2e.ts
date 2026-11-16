/**
 * Models and providers: `/model` across dialects, `/model` saving the
 * default for new sessions (and `--temp` not), and a session continuing on
 * the model and effort it last used when switched to or resumed (#11).
 */
import { describe, expect } from "vite-plus/test"
import { MODELS, type Scenario, scenario } from "../src/scenario.ts"
import type { Terminal } from "../src/term.ts"

const PROMPT = /^›\s*$/m

/** Submit a prompt and wait for the session to have `count` settled turns. */
const turn = async (s: Scenario, term: Terminal, session: () => string, count: number, text: string) => {
  await term.line(text)

  return s.spans.settledTurns(await s.spans.waitFor("a session", () => session() || undefined), count)
}

/** The model of the newest LLM span in a session, as `provider/model`. */
const modelOf = (s: Scenario, session: string): string | undefined => s.spans.lastModel(session)?.model

describe("models", () => {
  scenario(
    "/model switches provider mid-session and the new model sees the earlier turns",
    { needs: ["rex", "second-model"] },
    async (s) => {
      const term = await s.tui()
      const session = () => s.spans.sessions()[0] ?? ""

      await term.waitFor(PROMPT)
      await turn(s, term, session, 1, "Remember the word 'walrus'. Reply with just: ok")
      expect(modelOf(s, session())).toBe(MODELS.main)

      await term.line(`/model ${MODELS.second}`)
      await term.waitFor(/Model is now/)

      const turns = await turn(
        s,
        term,
        session,
        2,
        "Which word did I ask you to remember? Reply with just the word.",
      )

      expect(modelOf(s, session())).toBe(MODELS.second)
      expect(turns[1]?.output?.toLowerCase()).toContain("walrus")
    },
  )

  scenario(
    "/model makes the model the default for new sessions, and /model --temp does not",
    { needs: ["rex", "second-model"] },
    async (s) => {
      const newSession = (known: ReadonlyArray<string>) =>
        s.spans.waitFor("a new session", () => s.spans.sessions().find((id) => !known.includes(id)))

      // A temporary switch is forgotten when the process ends.
      const temp = await s.tui()

      await temp.waitFor(PROMPT)
      await temp.line(`/model --temp ${MODELS.second}`)
      await temp.waitFor(/Only for this process/)
      await temp.line("/quit")
      await temp.exited()

      const beforeFirst = s.spans.sessions()
      const first = await s.tui()

      await first.waitFor(PROMPT)
      await first.line("Reply with just: one")

      const one = await newSession(beforeFirst)

      await s.spans.settledTurns(one, 1)
      expect(modelOf(s, one)).toBe(MODELS.main)

      // A plain switch is saved, so the next process starts a new session on it.
      await first.line(`/model ${MODELS.second}`)
      await first.waitFor(/default for new sessions/)
      await first.line("/quit")
      await first.exited()

      const beforeSecond = s.spans.sessions()
      const second = await s.tui()

      await second.waitFor(PROMPT)
      await second.line("Reply with just: two")

      const two = await newSession(beforeSecond)

      await s.spans.settledTurns(two, 1)
      expect(modelOf(s, two)).toBe(MODELS.second)
    },
  )

  scenario(
    "switching or resuming a session restores the model it last used",
    { needs: ["rex", "second-model"], timeoutMs: 420_000 },
    async (s) => {
      const term = await s.tui()
      const ids = () => s.spans.sessions()

      // Session B runs on the main model.
      await term.waitFor(PROMPT)
      await term.line("Reply with just: b1")

      const b = await s.spans.waitFor("session B", () => ids()[0])

      await s.spans.settledTurns(b, 1)

      // Session A switches to the second model, and raises its effort from the sandbox's low.
      await term.line("/new")
      await term.line(`/model ${MODELS.second}`)
      await term.waitFor(/Model is now/)
      await term.key("shift+tab")
      await term.waitFor(/effort (?!low)\w+/)
      await term.line("Reply with just: a1")

      const a = await s.spans.waitFor("session A", () => ids().find((id) => id !== b))

      await s.spans.settledTurns(a, 1)

      const aModel = s.spans.lastModel(a)

      expect(aModel?.model).toBe(MODELS.second)
      expect(aModel?.effort).not.toBe("low")

      // Back to B: its next turn is on the main model again.
      await term.line(`/resume ${b}`)
      await term.waitFor(new RegExp(`Continuing on ${RegExp.escape(MODELS.main)}`))
      await term.line("Reply with just: b2")
      await s.spans.settledTurns(b, 2)
      expect(s.spans.lastModel(b)).toEqual({ model: MODELS.main, effort: "low" })

      // And back to A: the second model, at the effort A chose.
      await term.line(`/resume ${a}`)
      await term.line("Reply with just: a2")
      await s.spans.settledTurns(a, 2)
      expect(s.spans.lastModel(a)).toEqual(aModel)

      await term.line("/quit")
      await term.exited()

      // A fresh process resuming A restores the second model.
      const fresh = await s.tui(["resume", a])

      await fresh.waitFor(PROMPT)
      await fresh.line("Reply with just: a3")
      await s.spans.settledTurns(a, 3)
      expect(s.spans.lastModel(a)).toEqual(aModel)
      await fresh.line("/quit")
      await fresh.exited()

      // An explicit -m wins over the session's own model.
      const forced = await s.tui(["-m", MODELS.main, "resume", a])

      await forced.waitFor(PROMPT)
      await forced.line("Reply with just: a4")
      await s.spans.settledTurns(a, 4)
      expect(modelOf(s, a)).toBe(MODELS.main)
    },
  )
})
