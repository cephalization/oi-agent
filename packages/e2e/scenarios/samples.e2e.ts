import * as fs from "node:fs"
import * as path from "node:path"
import { projectDir } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { expectOk, scenario } from "../src/scenario.ts"

scenario(
  "isolated samples and availability retries do not share rules or evaluator files",
  {
    liveOnly: true,
    samples: true,
  },
  async (s) => {
    const previous = process.env["OI_E2E_CONCURRENCY"]
    process.env["OI_E2E_CONCURRENCY"] = "1"
    const roots: Array<string> = []

    try {
      const rows = await s.samples([0, 1], async (child, entry, retries) => {
        roots.push(child.sandbox.root)
        const dir = projectDir(child.sandbox.cwd, { OI_AGENT_CONFIG_DIR: child.sandbox.configDir })
        const rules = path.join(dir, "rules.md")
        const evals = path.join(dir, "evals")
        expect(fs.existsSync(rules)).toBe(false)
        expect(fs.existsSync(evals)).toBe(false)
        fs.mkdirSync(evals, { recursive: true })
        fs.writeFileSync(rules, "Never let this leak into another sample")
        fs.writeFileSync(path.join(evals, "sample.json"), "{}")
        expect(expectOk(await child.run(["where"])).stdout.trim()).toBe(
          path.join(child.sandbox.home, "sessions"),
        )

        if (entry === 0 && retries === 0) throw new Error("The ChatGPT user is temporarily unavailable")

        return { entry, retries }
      })

      expect(rows).toEqual([
        { entry: 0, retries: 1 },
        { entry: 1, retries: 0 },
      ])
      expect(new Set(roots).size).toBe(3)
      s.results(rows)
    } finally {
      if (previous === undefined) delete process.env["OI_E2E_CONCURRENCY"]
      else process.env["OI_E2E_CONCURRENCY"] = previous
    }
  },
)

scenario(
  "samples retry availability once but never retry other failures",
  {
    liveOnly: true,
    samples: true,
  },
  async (s) => {
    let unavailableAttempts = 0
    let otherAttempts = 0

    await expect(
      s.samples([0], async () => {
        unavailableAttempts += 1
        throw new Error("The ChatGPT user is temporarily unavailable")
      }),
    ).rejects.toThrow("temporarily unavailable")

    await expect(
      s.samples([0], async () => {
        otherAttempts += 1
        throw new Error("an ordinary assertion failed")
      }),
    ).rejects.toThrow("ordinary assertion")

    expect(unavailableAttempts).toBe(2)
    expect(otherAttempts).toBe(1)
    await expect(s.tui()).rejects.toThrow("cannot open Rex")
  },
)
