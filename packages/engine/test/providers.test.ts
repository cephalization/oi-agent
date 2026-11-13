import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vite-plus/test"
import { describeModels, listOpenAIModels, parseModelIds, providerIdFrom } from "../src/index.ts"

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
