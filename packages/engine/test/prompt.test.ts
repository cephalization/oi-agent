import { describe, expect, it } from "vite-plus/test"
import { systemPrompt } from "../src/prompt.ts"

describe("background-work reporting", () => {
  it.each([
    ["headless/default", undefined],
    ["delegation off", { delegates: false }],
    ["delegation on", { delegates: true }],
  ])("keeps the final batch rollup in the shared prompt: %s", (_name, role) => {
    const prompt = systemPrompt(import.meta.dirname, undefined, role).split("Environment:")[0]!

    expect(prompt).toContain("Once all background jobs and delegated tasks in the session have finished")
    expect(prompt).toContain("not just the last result")
    expect(prompt).toContain("Explicitly restate each completed item's outcome in the final rollup")
    expect(prompt).toContain(
      "what is done or failed, important limitations, and outstanding decisions or next steps",
    )
    expect(prompt).toContain("Do not claim everything is done while work remains")
    expect(prompt).toContain("never sleep, poll or rerun to wait for one")
  })
})
