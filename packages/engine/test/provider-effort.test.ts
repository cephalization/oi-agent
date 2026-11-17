import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { Effect, Schema } from "effect"
import { loadConfig, Model } from "../src/index.ts"
import { expect, it, vi } from "vite-plus/test"
import { Providers } from "../../cli/src/providers.ts"
import { effortsFor, nextEffort } from "../../cli/src/tui/modes.ts"

it("uses catalog efforts for cycling and requests without downgrading xhigh or max", async () => {
  const home = mkdtempSync(join(tmpdir(), "oi-provider-test-"))

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end('data: {"type":"response.completed","response":{"output":[]}}\n\n')
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  const address = server.address()

  if (address === null || Schema.is(Schema.String)(address)) throw new Error("Expected a TCP server")

  const providers = new Providers()
  const ref = { provider: "openai", model: "gpt-6.1-sol" }

  vi.spyOn(providers, "find").mockReturnValue({
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    base_url: `http://127.0.0.1:${address.port}`,
  })
  vi.spyOn(providers, "key").mockReturnValue("test-key")
  vi.stubEnv("OI_AGENT_OPENAI_TRANSPORT", "http")
  providers.catalog.push({ ...ref, id: ref.model, name: ref.model, efforts: ["low", "xhigh", "max"] })

  try {
    const config = loadConfig({ OI_AGENT_CONFIG_DIR: home, OI_AGENT_HOME: home })
    const effort = "low"

    expect(nextEffort(effort, effortsFor(providers.catalog, ref))).toBe("xhigh")

    for (const level of ["xhigh", "max"] as const) {
      let request = ""

      await Effect.runPromise(
        Effect.gen(function* () {
          const model = yield* Model

          yield* model.run(
            { system: "", tools: [], messages: [] },
            {
              onRequest: (body) => {
                request = body
              },
              onDelta: () => undefined,
            },
          )
        }).pipe(Effect.provide(providers.modelFor({ ...config, ...ref, effort: level }))),
      )
      expect(JSON.parse(request).reasoning.effort).toBe(level)
    }
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
})
