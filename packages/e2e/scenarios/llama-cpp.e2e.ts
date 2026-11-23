import { createServer } from "node:http"
import { Schema } from "effect"
import { type Json, OI, readMetadata, stringAttr } from "@oi-agent/engine"
import { expect, it } from "vite-plus/test"
import { expectOk } from "../src/scenario.ts"
import { Sandbox } from "../src/sandbox.ts"
import { Spans } from "../src/spans.ts"

const model = "org/inkling:BF16"
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const isAddress = Schema.is(Schema.Struct({ port: Schema.Int }))

it("streams a llama.cpp tool call and its answer through the CLI", async () => {
  const requests: Array<Json> = []
  const routes: Array<string | undefined> = []
  const auth: Array<string | undefined> = []

  const server = createServer(async (req, res) => {
    routes.push(req.url)
    auth.push(req.headers.authorization)

    let body = ""

    req.setEncoding("utf8")

    for await (const chunk of req) body += chunk

    requests.push(decode(body))
    res.writeHead(200, { "content-type": "text/event-stream" })

    const delta = (value: Json): void => {
      res.write(
        `data: ${JSON.stringify({ id: "completion", model, choices: [{ index: 0, delta: value }] })}\n\n`,
      )
    }

    if (requests.length === 1) {
      delta({
        tool_calls: [
          {
            index: 0,
            id: "call_local",
            type: "function",
            function: { name: "read_file", arguments: '{"path":' },
          },
        ],
      })
      delta({ tool_calls: [{ index: 0, function: { arguments: '"answer.txt"}' } }] })
    } else {
      delta({ content: "48" })
      delta({ content: "17" })
    }

    const finish_reason = requests.length === 1 ? "tool_calls" : "stop"

    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason }] })}\n\n`)
    res.end(
      'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":4,"total_tokens":34}}\n\ndata: [DONE]\n\n',
    )
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  const address = server.address()

  if (!isAddress(address)) throw new Error("Missing test server port")

  const sandbox = new Sandbox("llama-cpp-stream", {
    fixture: "basic",
    confine: true,
    config: {
      model: `llama-cpp/${model}`,
      effort: "high",
      approvals: "ask",
      phoenixEndpoint: "",
      phoenixProject: "",
      extra: new Map<string, Json>([
        ["steering", "off"],
        ["delegation", "off"],
        [
          "providers",
          [
            {
              id: "llama-cpp",
              name: "llama.cpp",
              kind: "openai-compatible",
              base_url: `http://127.0.0.1:${address.port}`,
            },
          ],
        ],
      ]),
    },
    env: new Map([["LLAMA_CPP_API_KEY", ""]]),
  })

  try {
    const result = expectOk(await sandbox.run(["run", "Read answer.txt."]))

    const withKey = expectOk(
      await sandbox.run(["run", "Reply with a number."], new Map([["LLAMA_CPP_API_KEY", "test-llama-key"]])),
    )

    expect(result.stdout).toBe("4817\n")
    expect(withKey.stdout).toBe("4817\n")
    expect(routes).toEqual(Array(3).fill("/v1/chat/completions"))
    expect(auth).toEqual([undefined, undefined, "Bearer test-llama-key"])
    expect(requests[0]).toMatchObject({ model, stream: true, stream_options: { include_usage: true } })
    expect(requests[0]).not.toHaveProperty("reasoning_effort")
    expect(requests[1]).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_local", function: { name: "read_file", arguments: '{"path":"answer.txt"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_local", content: expect.stringContaining("4817") },
      ],
    })

    const spans = new Spans(sandbox.home)
    const sessions = spans.sessions()
    const calls = sessions.flatMap((session) => spans.ofKind(session, "LLM"))

    expect(sessions.flatMap((session) => spans.tools(session).map((tool) => tool.name))).toEqual([
      "read_file",
    ])
    expect(calls).toHaveLength(3)
    expect(calls.map((span) => readMetadata(span).api)).toEqual(Array(3).fill("openai-chat"))
    expect(calls.map((span) => stringAttr(span, OI.LLM_PROVIDER))).toEqual(Array(3).fill("llama-cpp"))
    expect(JSON.stringify(calls)).not.toContain("test-llama-key")
  } finally {
    sandbox.dispose(false)
    server.close()
  }
})
