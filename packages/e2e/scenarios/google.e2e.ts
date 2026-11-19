import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { Schema } from "effect"
import { type Json, OI, readMetadata, stringAttr } from "@oi-agent/engine"
import { expect, it } from "vite-plus/test"
import { expectOk, scenario } from "../src/scenario.ts"
import { Sandbox } from "../src/sandbox.ts"
import { Spans } from "../src/spans.ts"

const AddressInfo = Schema.Struct({ port: Schema.Int })
const isAddress = Schema.is(AddressInfo)

scenario(
  "Gemini Hydrogen uses a tool and continues from its disk spans",
  { model: "google/gemini-4-hydrogen", liveOnly: true, config: new Map([["steering", "off"]]) },
  async ({ run, spans }) => {
    const result = expectOk(
      await run([
        "-m",
        "gemini/gemini-4-hydrogen",
        "run",
        "Call read_file on answer.txt, then reply with just the magic number from that file.",
      ]),
    )

    expect(result.stdout).toContain("4817")

    const session = spans.onlySession()
    const [first, second] = spans.ofKind(session, "LLM")

    expect(spans.tools(session).map((tool) => tool.name)).toContain("read_file")
    expect(first && readMetadata(first)).toMatchObject({ provider: "google", api: "google-generate-content" })
    expect(first && stringAttr(first, OI.LLM_PROVIDER)).toBe("google")
    expect(second && stringAttr(second, OI.INPUT_VALUE)).toContain('"thoughtSignature"')
    expect(second && stringAttr(second, OI.INPUT_VALUE)).toContain('"functionResponse"')

    const resumed = expectOk(
      await run(["-c", "run", "What magic number did you just report? Reply with just that number."]),
    )

    expect(resumed.stdout).toContain("4817")
    expect(spans.onlySession()).toBe(session)
  },
)

it("replays signed native parts and parallel tool results through the CLI, even after restart", async () => {
  const thought = { thought: true, text: "private summary" }

  const signed = {
    thoughtSignature: "c2lnbmVk",
    functionCall: { name: "read_file", args: { path: "answer.txt" } },
  }

  const parallel = { functionCall: { id: "wire-id", name: "read_file", args: { path: "answer.txt" } } }
  const final: Array<Json> = [{ text: "4817" }, { text: "", thoughtSignature: "ZmluYWw=" }]
  const content = (parts: ReadonlyArray<Json>) => ({ role: "model", parts: [...parts] })
  const requests: Array<Json> = []
  const headers: Array<string | string[] | undefined> = []
  const routes: Array<string | undefined> = []
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

  const server = createServer(async (req, res) => {
    routes.push(req.url)
    headers.push(req.headers["x-goog-api-key"])

    let body = ""

    req.setEncoding("utf8")

    for await (const chunk of req) body += chunk

    requests.push(decode(body))
    res.writeHead(200, { "content-type": "text/event-stream" })

    const parts = requests.length === 1 ? [thought, signed, parallel] : final

    for (const part of parts)
      res.write(`data: ${JSON.stringify({ candidates: [{ content: content([part]) }] })}\n\n`)

    res.end(
      `data: ${JSON.stringify({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, thoughtsTokenCount: 7, totalTokenCount: 30 } })}\n\n`,
    )
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  const address = server.address()

  if (address === null || !isAddress(address)) throw new Error("Missing test server port")

  const key = randomBytes(12).toString("hex")

  const sandbox = new Sandbox("gemini-stream", {
    fixture: "basic",
    confine: true,
    config: {
      model: "google/gemini-4-neon",
      effort: "high",
      approvals: "ask",
      phoenixEndpoint: "",
      phoenixProject: "",
      extra: new Map<string, Json>([
        ["effort", "xhigh"],
        ["steering", "off"],
        ["delegation", "off"],
      ]),
    },
    env: new Map([
      ["GOOGLE_BASE_URL", `http://127.0.0.1:${address.port}/v1beta`],
      ["GEMINI_API_KEY", key],
    ]),
  })

  try {
    const first = expectOk(await sandbox.run(["-m", "gemini/gemini-4-neon", "run", "Read the file."]))
    const resumed = expectOk(await sandbox.run(["-c", "run", "What did it say?"]))

    expect(first.stdout).toBe("4817\n")
    expect(resumed.stdout).toBe("4817\n")
    expect(routes).toEqual(Array(3).fill("/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse"))
    expect(headers.map((header) => header === key)).toEqual([true, true, true])
    expect(requests[1]).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingLevel: "xhigh", includeThoughts: true } },
      contents: [
        { role: "user" },
        content([thought, signed, parallel]),
        {
          role: "user",
          parts: [
            {
              functionResponse: { name: "read_file", response: { output: expect.stringContaining("4817") } },
            },
            {
              functionResponse: {
                id: "wire-id",
                name: "read_file",
                response: { output: expect.stringContaining("4817") },
              },
            },
          ],
        },
      ],
    })
    expect(requests[2]).toMatchObject({
      contents: [
        { role: "user" },
        content([thought, signed, parallel]),
        { role: "user" },
        content(final),
        { role: "user" },
      ],
    })

    const spans = new Spans(sandbox.home)
    const session = spans.onlySession()
    const calls = spans.ofKind(session, "LLM")

    expect(calls).toHaveLength(3)
    expect(spans.tools(session).map((tool) => tool.name)).toEqual(["read_file", "read_file"])
    expect(calls.map((span) => stringAttr(span, OI.LLM_PROVIDER))).toEqual(["google", "google", "google"])
    expect(calls.map((span) => readMetadata(span).api)).toEqual(Array(3).fill("google-generate-content"))
    expect(calls.map((span) => span.attributes[OI.TOKENS_COMPLETION])).toEqual([10, 10, 10])
    expect(JSON.stringify(calls).includes(key)).toBe(false)
  } finally {
    sandbox.dispose(false)
    server.close()
  }
})
