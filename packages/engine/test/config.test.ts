import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { configProblems, loadConfig, saveApprovals, saveModel } from "../src/config.ts"

/** An environment whose config directory holds `text` as config.json. */
const withFile = (text: string): NodeJS.ProcessEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-config-"))

  fs.writeFileSync(path.join(dir, "config.json"), text)

  return { OI_AGENT_CONFIG_DIR: dir }
}

describe("config file", () => {
  it("saves the approval mode for the next start and keeps every other key as written", () => {
    const env = withFile(JSON.stringify({ model: "claude-haiku-5-5", approvals: "ask", unknown_key: 1 }))

    saveApprovals("allow", env)

    expect(loadConfig(env).approvals).toBe("allow")
    expect(
      JSON.parse(fs.readFileSync(path.join(env["OI_AGENT_CONFIG_DIR"] ?? "", "config.json"), "utf8")),
    ).toEqual({
      model: "claude-haiku-5-5",
      approvals: "allow",
      unknown_key: 1,
    })
  })

  it("saves a /model choice as provider/model, which reads back at that provider", () => {
    const env = withFile(JSON.stringify({ model: "claude-opus-5-5", effort: "high", unknown_key: 1 }))

    saveModel({ provider: "chatgpt", model: "gpt-5.6-luna" }, env)

    expect(loadConfig(env)).toMatchObject({ provider: "chatgpt", model: "gpt-5.6-luna", effort: "high" })
    expect(
      JSON.parse(fs.readFileSync(path.join(env["OI_AGENT_CONFIG_DIR"] ?? "", "config.json"), "utf8")),
    ).toEqual({ provider: "chatgpt", model: "chatgpt/gpt-5.6-luna", effort: "high", unknown_key: 1 })

    saveModel({ provider: "anthropic", model: "claude-haiku-5-5", effort: "low" }, env)

    expect(loadConfig(env)).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", effort: "low" })
  })

  it("reads back a saved model whose id has its own slash at the right provider", () => {
    const env = withFile(
      JSON.stringify({
        providers: [
          { id: "router", name: "Router", kind: "openai-compatible", base_url: "http://localhost:9/v1" },
        ],
      }),
    )

    saveModel({ provider: "router", model: "openai/gpt-oss" }, env)

    expect(loadConfig(env)).toMatchObject({ provider: "router", model: "openai/gpt-oss" })
  })

  it("reads every setting from a valid file and reports nothing", () => {
    const env = withFile(JSON.stringify({ model: "claude-haiku-5-5", effort: "low", approvals: "allow" }))

    expect(loadConfig(env)).toMatchObject({ model: "claude-haiku-5-5", effort: "low", approvals: "allow" })
    expect(configProblems(env)).toEqual([])
  })

  it("loads independent decision and steering settings, with an environment override for steering", () => {
    const env = withFile(
      JSON.stringify({
        approvals: "auto",
        decision: { model: "jev-custom", base_url: "http://localhost:8080" },
        steering_model: "local/qwen3",
      }),
    )

    expect(loadConfig(env)).toMatchObject({
      approvals: "auto",
      decision: { kind: "systemone", model: "jev-custom", base_url: "http://localhost:8080" },
      steering_model: "local/qwen3",
    })
    expect(loadConfig({ ...env, OI_AGENT_STEERING_MODEL: "decision:jev-next" }).steering_model).toBe(
      "decision:jev-next",
    )
    expect(configProblems(env)).toEqual([])
  })

  it("keeps the valid settings when one value is not valid, and names the bad key", () => {
    const env = withFile(
      JSON.stringify({ model: "gpt-5.6-luna", provider: "chatgpt", effort: "low", approvals: "sometimes" }),
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
