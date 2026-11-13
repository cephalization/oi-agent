import * as os from "node:os"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { builtinTools } from "../src/index.ts"

const runBash = (command: string, timeoutMs = 120_000): Promise<string> => {
  const bash = builtinTools.find((tool) => tool.name === "bash")

  if (bash === undefined) throw new Error("no bash tool")

  return Effect.runPromise(
    bash.run({ command, timeout_ms: timeoutMs }, { cwd: os.tmpdir(), emit: () => undefined }),
  ).then((outcome) => outcome.output)
}

describe("bash", () => {
  it("says a timeout was the time limit, and how to raise it", async () => {
    const output = await runBash("sleep 5", 200)

    expect(output).toContain("timed out after 200 ms")
    expect(output).toContain("larger timeout_ms")
  })

  it("marks the commands it runs as running under oi", async () => {
    expect(await runBash("echo marker=$OI_AGENT")).toContain("marker=1")
  })
})
