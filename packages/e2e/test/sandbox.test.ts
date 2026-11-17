import { expect, it } from "vite-plus/test"
import { canConfine, Sandbox } from "../src/sandbox.ts"

it.skipIf(!canConfine())("can load the CLI sources from a confined agent worktree", async () => {
  const sandbox = new Sandbox("source-read", {
    fixture: "basic",
    confine: true,
    env: new Map(),
    config: {
      model: "openai/gpt-5.6-luna",
      effort: "low",
      approvals: "ask",
      extra: new Map(),
      phoenixEndpoint: "",
      phoenixProject: "oi-agent-e2e",
    },
  })

  try {
    const result = await sandbox.run(["--help"])

    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Usage:")
  } finally {
    sandbox.dispose(false)
  }
})
