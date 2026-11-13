import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { configProblems, loadConfig } from "../src/config.ts"

/** An environment whose config directory holds `text` as config.json. */
const withFile = (text: string): NodeJS.ProcessEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-config-"))

  fs.writeFileSync(path.join(dir, "config.json"), text)

  return { OI_AGENT_CONFIG_DIR: dir }
}

describe("config file", () => {
  it("reads every setting from a valid file and reports nothing", () => {
    const env = withFile(JSON.stringify({ model: "claude-haiku-5-5", effort: "low", approvals: "allow" }))

    expect(loadConfig(env)).toMatchObject({ model: "claude-haiku-5-5", effort: "low", approvals: "allow" })
    expect(configProblems(env)).toEqual([])
  })

  it("keeps the valid settings when one value is not valid, and names the bad key", () => {
    const env = withFile(
      JSON.stringify({ model: "gpt-5.6-luna", provider: "chatgpt", effort: "low", approvals: "auto" }),
    )

    const config = loadConfig(env)

    expect(config).toMatchObject({ provider: "chatgpt", model: "gpt-5.6-luna", effort: "low" })
    expect(config.approvals).toBe("ask")
    expect(configProblems(env)).toEqual([expect.stringContaining("ignoring approvals, which is not valid")])
  })

  it("reports a file that is not JSON and falls back to defaults", () => {
    const env = withFile("{ not json")

    expect(loadConfig(env).model).toBe("claude-opus-5-5")
    expect(configProblems(env)).toEqual([expect.stringContaining("the whole file")])
  })

  it("reports nothing when there is no file", () => {
    expect(
      configProblems({ OI_AGENT_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-none-")) }),
    ).toEqual([])
  })
})
