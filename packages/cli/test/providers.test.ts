import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "@oi-agent/engine"
import { expect, it, vi } from "vite-plus/test"
import { Providers } from "../src/providers.ts"

it("configures the built-in llama.cpp provider and discovers its models without a key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oi-llama-config-"))
  const requests: Array<string> = []

  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? "(no auth)"}`)
    res.setHeader("content-type", "application/json")
    res.end(
      JSON.stringify({
        data: [
          {
            id: "org/image-model:BF16",
            name: "Vision model",
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      }),
    )
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    // SAFETY: a listening TCP server returns AddressInfo, not a pipe address.
    const { port } = server.address() as AddressInfo

    vi.stubEnv("OI_AGENT_CONFIG_DIR", directory)
    vi.stubEnv("LLAMA_CPP_API_KEY", "")

    const providers = new Providers()
    const baseUrl = `http://127.0.0.1:${port}`

    await providers.saveServer({ name: "llama.app / llama.cpp", baseUrl, key: "", models: "" }, "llama-cpp")
    await providers.refresh("llama-cpp")

    expect(loadConfig().providers).toEqual([
      {
        id: "llama-cpp",
        name: "llama.app / llama.cpp",
        kind: "openai-compatible",
        api: "chat",
        base_url: `${baseUrl}/v1`,
      },
    ])
    expect(requests).toEqual(["GET /v1/models (no auth)"])
    expect(providers.catalog).toMatchObject([
      { id: "org/image-model:BF16", name: "Vision model", provider: "llama-cpp", efforts: [] },
    ])
  } finally {
    server.close()
    rmSync(directory, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})
