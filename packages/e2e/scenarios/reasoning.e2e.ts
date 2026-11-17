/** Shift+Tab must change the effort actually sent to a subscription model. */
import { expect } from "vite-plus/test"
import { MODELS, scenario } from "../src/scenario.ts"

scenario("Shift+Tab cycles reasoning effort on the main model", { needs: ["rex"] }, async (s) => {
  const term = await s.tui()

  await term.waitFor(/^›\s*$/m)
  await term.key("shift+tab")
  await term.waitFor(/effort medium/)
  await term.line("Reply with just: ok")

  const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

  await s.spans.settledTurns(session, 1)
  expect(s.spans.lastModel(session)).toEqual({ model: MODELS.main, effort: "medium" })

  await term.key("shift+tab")
  await term.waitFor(/effort high/)
  await term.line("Reply with just: ok")
  await s.spans.settledTurns(session, 2)
  expect(s.spans.lastModel(session)).toEqual({ model: MODELS.main, effort: "high" })
})
