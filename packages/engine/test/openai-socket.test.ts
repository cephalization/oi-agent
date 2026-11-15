import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { Effect, Exit, type Layer, Option, Schema } from "effect"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { type WebSocket as ServerSocket, WebSocketServer } from "ws"
import { Model } from "../src/model.ts"
import { NETWORK_PROTOCOL, openaiModel, type OpenAISettings } from "../src/openai.ts"
import { closeModelSockets } from "../src/openai-socket.ts"
import type { Json } from "../src/wire.ts"

const Payload = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
const decodePayload = Schema.decodeUnknownOption(Payload)

const final = (text: string): Json => ({
  id: "resp_1",
  model: "m1",
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 9, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
})

const completed = (text: string): ReadonlyArray<Json> => [
  { type: "response.output_text.delta", output_index: 0, delta: text },
  { type: "response.completed", response: final(text) },
]

interface Behaviour {
  /** Refuse the WebSocket upgrade, as a server without WebSocket mode would. */
  readonly refuseUpgrade?: boolean
  /** Messages to send for the nth request (from 0) on a socket. */
  readonly reply: (payload: typeof Payload.Type, client: ServerSocket, count: number) => ReadonlyArray<Json>
}

/** A local server that speaks the Responses API over both WebSocket and HTTP. */
const serve = async (behaviour: Behaviour) => {
  const sockets = new WebSocketServer({ noServer: true })
  const seen = { upgrades: 0, connections: 0, http: 0, auth: "", payloads: new Array<typeof Payload.Type>() }

  const server = createServer((request, response) => {
    seen.http += 1
    request.resume()
    request.on("end", () => {
      const body = completed("over http").map((event) => `data: ${JSON.stringify(event)}\n\n`)

      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(body.join(""))
    })
  })

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    seen.upgrades += 1
    seen.auth = request.headers.authorization ?? ""

    if (behaviour.refuseUpgrade === true) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n")

      return
    }

    sockets.handleUpgrade(request, socket, head, (client) => {
      let count = 0

      seen.connections += 1
      client.on("message", (data: Buffer) => {
        const payload = Option.getOrThrow(decodePayload(data.toString("utf8")))

        seen.payloads.push(payload)

        for (const event of behaviour.reply(payload, client, count)) client.send(JSON.stringify(event))

        count += 1
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
  const { port } = server.address() as AddressInfo

  return {
    base: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => {
      for (const client of sockets.clients) client.terminate()

      server.close()
    },
  }
}

const servers: Array<{ close: () => void }> = []

afterEach(() => {
  closeModelSockets()

  for (const server of servers.splice(0)) server.close()
})

const start = async (behaviour: Behaviour) => {
  const server = await serve(behaviour)

  servers.push(server)

  return server
}

const model = (base: string): Layer.Layer<Model> => {
  const settings: OpenAISettings = {
    provider: "local",
    api: "responses",
    transport: "websocket",
    baseUrl: base,
    model: "m1",
    effort: undefined,
    maxTokens: 1000,
    token: () => Promise.resolve("secret-key"),
    onUnauthorized: "Replace the key.",
  }

  return openaiModel(settings)
}

/** Run one call inside a span, and report the response, the deltas and the protocol recorded on the span. */
const call = (layer: Layer.Layer<Model>, first = "hi") => {
  const deltas: Array<string> = []
  let request = ""

  return Effect.runPromiseExit(
    Effect.gen(function* () {
      const service = yield* Model

      const response = yield* service.run(
        { system: "be brief", tools: [], messages: [{ role: "user", content: first }] },
        {
          onRequest: (body) => {
            request = body
          },
          onDelta: (delta) => deltas.push(delta.d),
        },
      )

      const span = yield* Effect.orDie(Effect.currentSpan)

      return { response, deltas, request, protocol: span.attributes.get(NETWORK_PROTOCOL) }
    }).pipe(Effect.withSpan("llm"), Effect.provide(layer)),
  )
}

const value = <A, E>(exit: Exit.Exit<A, E>): A | undefined => (Exit.isSuccess(exit) ? exit.value : undefined)

const message = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isFailure(exit) ? JSON.stringify(Option.getOrUndefined(Exit.findErrorOption(exit))) : ""

describe("Responses API over a WebSocket", () => {
  it("sends the request as response.create and returns the completed response", async () => {
    const server = await start({ reply: () => completed("Hello.") })
    const result = value(await call(model(server.base)))
    const [payload] = server.seen.payloads

    expect(JSON.parse(result?.response ?? "{}")).toEqual(final("Hello."))
    expect(result?.deltas).toEqual(["Hello."])
    expect(result?.protocol).toBe("websocket")
    expect(server.seen.auth).toBe("Bearer secret-key")
    expect(server.seen.http).toBe(0)
    // The socket message is the HTTP body with a type and without `stream`...
    expect(payload).toMatchObject({
      type: "response.create",
      model: "m1",
      store: false,
      instructions: "be brief",
    })
    expect(payload).not.toHaveProperty("stream")
    expect(payload).not.toHaveProperty("previous_response_id")
    // ...and the body stored on the span is the HTTP one, whichever way it travelled.
    expect(JSON.parse(result?.request ?? "{}")).toMatchObject({ stream: true, store: false, model: "m1" })
  })

  it("keeps one connection per conversation, so later calls reach the same cache", async () => {
    const server = await start({ reply: () => completed("ok") })
    const layer = model(server.base)

    await call(layer)
    await call(layer)
    await call(layer)

    expect(server.seen.connections).toBe(1)
    expect(server.seen.payloads).toHaveLength(3)

    await call(layer, "a different conversation")

    expect(server.seen.connections).toBe(2)
  })

  it("opens a new connection when the server closed the old one between calls", async () => {
    const server = await start({
      reply: (_payload, client) => {
        setTimeout(() => client.close(), 5)

        return completed("ok")
      },
    })

    const layer = model(server.base)
    const first = value(await call(layer))

    await new Promise((resolve) => setTimeout(resolve, 40))

    const second = value(await call(layer))

    expect(first?.protocol).toBe("websocket")
    expect(second?.protocol).toBe("websocket")
    expect(server.seen.connections).toBe(2)
    expect(server.seen.http).toBe(0)
  })

  it("falls back to HTTP when the server refuses a WebSocket, and stops trying for a while", async () => {
    const server = await start({ refuseUpgrade: true, reply: () => [] })
    const layer = model(server.base)
    const first = value(await call(layer))
    const second = value(await call(layer))

    expect(first?.protocol).toBe("http")
    expect(first?.deltas).toEqual(["over http"])
    expect(second?.protocol).toBe("http")
    expect(server.seen.http).toBe(2)
    expect(server.seen.upgrades).toBe(1)
  })

  it("reports a socket error event the way an HTTP status would be", async () => {
    const server = await start({
      reply: () => [{ type: "error", status: 401, error: { message: "bad token", code: "invalid_api_key" } }],
    })

    const exit = await call(model(server.base))

    expect(message(exit)).toContain("rejected the credentials. Replace the key.")
    expect(server.seen.http).toBe(0)
  })

  it("fails, without resending, when the connection drops after output has arrived", async () => {
    const server = await start({
      reply: (_payload, client) => {
        setTimeout(() => client.terminate(), 5)

        return [{ type: "response.output_text.delta", output_index: 0, delta: "Hel" }]
      },
    })

    const exit = await call(model(server.base))

    expect(message(exit)).toContain("closed before the response completed")
    // Text already streamed to the user must not be produced a second time.
    expect(server.seen.http).toBe(0)
  })

  it("replaces a kept connection that turns out to be dead", async () => {
    const server = await start({
      reply: (_payload, client, count) => {
        if (count === 0) return completed("first")

        client.terminate()

        return []
      },
    })

    const layer = model(server.base)

    await call(layer)

    const second = value(await call(layer))

    // The dead connection is replaced once; the replacement is healthy.
    expect(second?.protocol).toBe("websocket")
    expect(server.seen.connections).toBe(2)
  })
})
