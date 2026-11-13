/**
 * Learning from steering (issue #10). Whether a correction is durable is a
 * judgement call by a model, so this is scored, not pass/fail on one try:
 * each case runs `OI_E2E_SAMPLES` times (default 3) and the scenario fails
 * when the rate falls below a bar. The scores go into the failure message
 * and the scenario's span in Phoenix.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { projectDir } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, type Scenario, scenario } from "../src/scenario.ts"

const SAMPLES = Number(process.env["OI_E2E_SAMPLES"] ?? "3")

interface Case {
  /** A first prompt that sets up something to correct. */
  readonly setup: string
  readonly steer: string
}

/** Corrections that apply beyond the current task: each should become an evaluator. */
const DURABLE: ReadonlyArray<Case> = [
  {
    setup: "What command installs this project's dependencies? Reply with just the command.",
    steer: "From now on, always use pnpm instead of npm in this project.",
  },
  {
    setup: "Add a one-line comment above greet in src/greet.js.",
    steer: "Don't add comments like that to my code, ever. Keep it uncommented.",
  },
]

/** Corrections about this task only: none should become an evaluator. */
const ONE_OFF: ReadonlyArray<Case> = [
  {
    setup: "Suggest a new name for the greet function. Reply with just the name.",
    steer: "No, call it sayHello for this change.",
  },
  {
    setup: "What does src/greet.js export? One sentence.",
    steer: "Shorter, please. Just the function name.",
  },
]

/** Evaluator files for this project and the user, by name. */
const evalFiles = (s: Scenario): Array<string> => {
  const env = { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }
  const dirs = [path.join(projectDir(s.sandbox.cwd, env), "evals"), path.join(s.sandbox.configDir, "evals")]

  return dirs.flatMap((dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : [],
  )
}

/** Run one case in a fresh session; return the evaluators it created, then remove them. */
const learned = async (s: Scenario, entry: Case): Promise<Array<string>> => {
  const before = new Set(evalFiles(s))
  const first = await s.run(["run", entry.setup])

  expectOk(first)

  const session = s.spans.sessions().at(-1) ?? ""
  const second = await s.run(["run", "-s", session, entry.steer])

  expectOk(second)

  const created = evalFiles(s).filter((file) => !before.has(file))

  for (const file of created) fs.rmSync(file)

  return created
}

const rate = (hits: number, total: number): string =>
  `${hits}/${total} (${Math.round((hits / total) * 100)}%)`

describe("learning from steering", () => {
  scenario(
    "durable corrections become evaluators; one-off ones do not",
    {
      pending: 10,
      liveOnly: true,
      config: new Map([["steering", "auto"]]),
      timeoutMs: 900_000,
    },
    async (s) => {
      let durableHits = 0
      let oneOffHits = 0

      for (let sample = 0; sample < SAMPLES; sample += 1) {
        for (const entry of DURABLE) {
          const created = await learned(s, entry)

          // Each evaluator links back to the prompt that produced it.
          for (const file of created) s.note(`learned from "${entry.steer}": ${path.basename(file)}`)

          if (created.length > 0) durableHits += 1
        }

        for (const entry of ONE_OFF) if ((await learned(s, entry)).length > 0) oneOffHits += 1
      }

      const durableTotal = SAMPLES * DURABLE.length
      const oneOffTotal = SAMPLES * ONE_OFF.length

      s.note(
        `durable learned: ${rate(durableHits, durableTotal)}; one-off learned: ${rate(oneOffHits, oneOffTotal)}`,
      )

      expect(durableHits / durableTotal).toBeGreaterThanOrEqual(2 / 3)
      expect(oneOffHits / oneOffTotal).toBeLessThanOrEqual(1 / 6)
    },
  )
})
