import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vite-plus/test"
import {
  billingOf,
  BUILTIN_PROVIDERS,
  describeModels,
  findProvider,
  googleEfforts,
  listOpenAIModels,
  openaiEfforts,
  parseModelIds,
  providerIdFrom,
  secretAccount,
  splitModel,
  vendorOf,
} from "../src/index.ts"

describe("who serves a provider's calls, and how they are paid for", () => {
  const builtin = (id: string) => BUILTIN_PROVIDERS.find((provider) => provider.id === id)!

  it("names OpenAI for both the API key and the ChatGPT plan, which differ only in billing", () => {
    expect(vendorOf(builtin("openai"))).toBe("openai")
    expect(vendorOf(builtin("chatgpt"))).toBe("openai")
    expect(vendorOf(builtin("anthropic"))).toBe("anthropic")
    expect(billingOf(builtin("openai"))).toBe("api")
    expect(billingOf(builtin("chatgpt"))).toBe("plan")
    expect(billingOf(builtin("anthropic"))).toBe("api")
  })

  it("uses a compatible server's declared vendor, and its id when it declares none", () => {
    const local = { id: "ollama", name: "Ollama", kind: "openai-compatible" as const }

    expect(vendorOf(local)).toBe("ollama")
    expect(vendorOf({ ...local, id: "fast", vendor: "groq" })).toBe("groq")
    expect(billingOf(local)).toBe("api")
  })
})

describe("compatible servers", () => {
  it("makes a provider id from a display name", () => {
    expect(providerIdFrom("DwarfStar")).toBe("dwarfstar")
    expect(providerIdFrom("  My vLLM box! ")).toBe("my-vllm-box")
    expect(providerIdFrom("???")).toBeUndefined()
  })

  it("reads a comma-separated model list", () => {
    expect(parseModelIds(" a, b ,,a, c ")).toEqual(["a", "b", "c"])
    expect(parseModelIds("")).toEqual([])
  })

  it("saves the names and output limits a server reports", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              top_provider: { context_length: 32768, max_completion_tokens: 32768 },
            },
            { id: "plain" },
          ],
        }),
      )
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    // SAFETY: a server listening on a TCP port has an AddressInfo address.
    const { port } = server.address() as AddressInfo

    const listed = await listOpenAIModels({
      provider: "ds4",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      token: undefined,
      openaiCatalog: false,
    }).finally(() => server.close())

    expect(describeModels(["deepseek-v4-flash", "plain", "unlisted"], listed)).toEqual([
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", max_output: 32768 },
      { id: "plain" },
      { id: "unlisted" },
    ])
  })
})

describe("OpenAI reasoning capabilities", () => {
  it("recognizes GPT generations from 5 onward before discovery completes", () => {
    for (const id of ["gpt-5.6-luna", "gpt-6.1-sol", "gpt-10", "o3", "codex-mini-latest"])
      expect(openaiEfforts(id)).toEqual(["low", "medium", "high"])

    for (const id of ["gpt-4.1", "gpt-4o", "gpt-3.5-turbo", "other"]) expect(openaiEfforts(id)).toEqual([])
  })

  it("uses advertised ChatGPT effort levels, including unknown model names and explicit empty levels", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          models: [
            {
              slug: "gpt-6.1-sol",
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "medium" },
                { effort: "high" },
                { effort: "xhigh" },
                { effort: "max" },
                { effort: "ultra" },
              ],
            },
            { slug: "new-reasoner", supported_reasoning_levels: [{ effort: "high" }] },
            { slug: "gpt-5-no-effort", supported_reasoning_levels: [] },
            { slug: "gpt-5.6-luna" },
          ],
        }),
      )
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

    // SAFETY: a server listening on a TCP port has an AddressInfo address.
    const { port } = server.address() as AddressInfo

    const listed = await listOpenAIModels({
      provider: "chatgpt",
      baseUrl: `http://127.0.0.1:${port}`,
      token: undefined,
      openaiCatalog: true,
    }).finally(() => server.close())

    const levels = new Map(listed.map((model) => [model.id, model.efforts]))

    expect(levels.get("gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(levels.get("new-reasoner")).toEqual(["high"])
    expect(levels.get("gpt-5-no-effort")).toEqual([])
    expect(levels.get("gpt-5.6-luna")).toEqual(["low", "medium", "high"])
  })
})

describe("Google Gemini", () => {
  it("canonicalizes the Gemini alias without taking over an existing compatible server", () => {
    const ref = { provider: "google", model: "gemini-4-neon" }

    expect(splitModel([], "gemini/gemini-4-neon", "anthropic")).toEqual(ref)
    expect(splitModel([], "gemini-4-neon", "gemini")).toEqual(ref)

    const google = findProvider([], "gemini")!

    expect(vendorOf(google)).toBe("google")
    expect(secretAccount(google)).toBe("google")

    const compatible = { id: "gemini", kind: "openai-compatible" as const, name: "Existing server" }

    expect(findProvider([compatible], "gemini")).toBe(compatible)
    expect(splitModel([compatible], "gemini/org/custom", "anthropic")).toEqual({
      provider: "gemini",
      model: "org/custom",
    })
  })

  it("only offers documented thinking levels for the supported model IDs", () => {
    expect(googleEfforts("gemini-4-carbon")).toEqual(["low", "medium", "high"])
    expect(googleEfforts("gemini-4-neon")).toEqual(["low", "medium", "high", "xhigh"])
    expect(googleEfforts("gemini-4-hydrogen")).toEqual(["low", "medium", "high", "xhigh"])
    expect(googleEfforts("gemini-unknown")).toEqual([])
  })
})
