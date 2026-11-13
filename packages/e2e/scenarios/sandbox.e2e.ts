/**
 * The harness's own guarantee: with `--yolo`, the agent's tools can write in
 * the sandbox but nowhere else, and cannot read the developer's real
 * oi-agent sessions. Every other scenario relies on this.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect } from "vite-plus/test"
import { canConfine } from "../src/sandbox.ts"
import { expectOk, scenario } from "../src/scenario.ts"

describe.skipIf(!canConfine())("sandbox", () => {
  scenario("confines --yolo tools to the sandbox", { liveOnly: true }, async ({ run, sandbox, spans }) => {
    // A directory outside the sandbox that the test owns and removes.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "oi-e2e-outside-"))
    const escaped = path.join(outside, "escaped.txt")
    const inside = sandbox.file("inside.txt")
    const realSessions = path.join(os.homedir(), ".oi-agent")

    try {
      const result = await run([
        "run",
        "--yolo",
        [
          "Run each of these three shell commands with the bash tool, one call per command, even if one fails,",
          "then report each command's output verbatim:",
          `1. touch ${inside} && echo inside-ok`,
          `2. touch ${escaped} && echo outside-ok`,
          `3. ls ${realSessions} && echo read-ok`,
        ].join("\n"),
      ])

      expectOk(result)

      const bash = spans.tools(spans.onlySession()).filter((tool) => tool.name === "bash")

      expect(bash.length).toBeGreaterThanOrEqual(3)
      expect(fs.existsSync(inside)).toBe(true)
      expect(fs.existsSync(escaped)).toBe(false)

      const outputs = bash.map((tool) => tool.output).join("\n")

      expect(outputs).toContain("inside-ok")
      expect(outputs).not.toContain("outside-ok")
      expect(outputs).not.toContain("read-ok")
      expect(outputs).toMatch(/Operation not permitted/)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
