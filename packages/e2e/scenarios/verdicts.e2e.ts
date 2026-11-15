/**
 * Evaluator verdicts in the terminal: a pass is only counted in the status
 * line, a failure is printed in full, and `/verdicts` shows every verdict on
 * the last reviewed turn. Both evaluators are code checks, so no judge model
 * is involved and the outcome is fixed.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { projectDir } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { type Scenario, scenario } from "../src/scenario.ts"

const PROMPT = /^›\s*$/m

/** Write a code evaluator into the sandbox project's evals directory. */
const seed = (s: Scenario, name: string, pattern: string): void => {
  const dir = path.join(projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "evals")

  const definition = {
    name,
    description: `${name} check`,
    fail_labels: ["fail"],
    feedback: false,
    learn: false,
    kind: "code",
    pattern,
    target: "output",
    match_label: "fail",
    otherwise_label: "pass",
  }

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(definition, null, 2))
}

describe("evaluator verdicts", () => {
  scenario(
    "passing evals are a count in the status line, failures print, /verdicts shows all",
    { needs: ["rex"], config: new Map([["steering", "off"]]) },
    async (s) => {
      seed(s, "quiet_when_passing", "zebra-never-said")
      seed(s, "loud_when_failing", "pong")

      const term = await s.tui()

      await term.waitFor(PROMPT)
      await term.line("Reply with exactly the word: pong")

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)

      const screen = await term.waitFor(/1 eval passed/)

      expect(screen).toMatch(/◆ loud_when_failing: fail/)
      expect(screen).not.toContain("quiet_when_passing")

      await term.line("/verdicts")

      const details = await term.waitFor(/◆ quiet_when_passing: pass/)

      expect(details).toMatch(/Verdicts on the turn "Reply with exactly the word: pong"/)
      expect(details).toMatch(/"failed":true/)
    },
  )
})
