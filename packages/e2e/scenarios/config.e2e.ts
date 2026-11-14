/**
 * The config file as a user edits it: one value the CLI does not accept (a
 * typo, or a setting from a newer version) must not throw away the rest of
 * the file, and the user must be told which key was ignored.
 */
import { describe, expect } from "vite-plus/test"
import { expectOk, MODELS, scenario } from "../src/scenario.ts"

// Not an approval mode: the sandbox config is written as is, so the CLI sees the bad value.
const INVALID = { config: new Map([["approvals", "sometimes"]]) }

describe("config file", () => {
  scenario(
    "an invalid value is reported and ignored, and the other settings still apply",
    INVALID,
    async ({ run, spans }) => {
      const result = expectOk(await run(["run", "Reply with exactly the word: pong"]))

      expect(result.stderr).toMatch(/ignoring approvals, which is not valid/)
      // Without the fix the whole file was dropped and the turn ran on the default model.
      expect(spans.lastModel(spans.onlySession())).toEqual({ model: MODELS.main, effort: "low" })
    },
  )

  scenario("the TUI shows the warning under the banner", { ...INVALID, needs: ["rex"] }, async ({ tui }) => {
    const term = await tui()
    const screen = await term.waitFor(/ignoring approvals/)

    expect(screen).toContain(MODELS.main)
  })
})
