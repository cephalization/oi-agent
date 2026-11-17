// Separate result deliveries must retain the whole batch in the final rollup.
import * as fs from "node:fs"
import * as path from "node:path"
import { readMetadata } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { expectOk, scenario } from "../src/scenario.ts"

scenario(
  "release batch rollup includes earlier success and later failure",
  {
    config: new Map([["steering", "off"]]),
  },
  async (s) => {
    const release = async () => {
      const session = await s.spans.waitFor("session", () => s.spans.sessions()[0])
      await s.spans.settledTurns(session, 1)
      fs.writeFileSync(path.join(s.sandbox.cwd, "first-go"), "")
      await s.spans.waitFor("first result delivered", () => {
        const turns = s.spans.turns(session)

        return turns.length >= 2 && turns[1]?.state === "complete" ? true : undefined
      })
      fs.writeFileSync(path.join(s.sandbox.cwd, "second-go"), "")
    }

    const releasing = release()

    const result = await s.run([
      "run",
      "--yolo",
      "Start these two bash commands separately with background true: `until [ -f first-go ]; do sleep 0.2; done; echo ALPHA_OK` and `until [ -f second-go ]; do sleep 0.2; done; echo BETA_FAILED; exit 7`. They are one batch. Call no other tools and do not poll; report results when delivered.",
    ])

    await releasing
    expectOk(result)
    const session = s.spans.onlySession()
    const turns = await s.spans.settledTurns(session, 3)
    expect(turns).toHaveLength(3)
    expect(readMetadata(turns[1]!.root).delivers).toHaveLength(1)
    expect(readMetadata(turns[2]!.root).delivers).toHaveLength(1)
    expect(turns[2]?.output).toContain("ALPHA_OK")
    expect(turns[2]?.output).toContain("BETA_FAILED")
    expect(turns[2]?.output).toMatch(/fail|7/i)
    expect(s.spans.tools(session).filter((tool) => tool.name === "job_status")).toHaveLength(0)
    s.note(`Final rollup: ${turns[2]?.output}`)
  },
)
