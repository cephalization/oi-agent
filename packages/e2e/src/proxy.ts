/**
 * A local HTTP server between the CLI and the model APIs, so scenarios can
 * run three ways (`OI_E2E_MODELS`):
 *
 * - `live` (default): no proxy; the CLI talks to the real APIs.
 * - `record`: forward to the real APIs and save every exchange to a cassette.
 * - `replay`: answer from the cassette, with no network and no keys.
 *
 * The CLI is pointed here with `ANTHROPIC_BASE_URL` (read by both Anthropic
 * SDKs) and `OPENAI_BASE_URL` (read by `providers.ts` for OpenAI and
 * ChatGPT). Responses are stored as raw bytes, server-sent events included,
 * and replayed verbatim, which is what oi itself does with stored bodies.
 *
 * OpenAI's Responses API is also served over a WebSocket, which is how the CLI
 * calls it by default. A socket exchange is stored in the same form as an
 * HTTP one (the events as a server-sent stream, under `POST /responses`), so
 * one cassette replays over either transport.
 *
 * Exchanges are matched in order within a queue per method, path and model,
 * so a scenario must make the same calls in the same order as when it was
 * recorded. Volatile request content (temp paths, timestamps) is ignored.
 */
import * as fs from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as path from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { gunzipSync, gzipSync } from "node:zlib"
import { Option, Schema } from "effect"
import WebSocket, { type WebSocket as ClientSocket, WebSocketServer } from "ws"

export const ModelsMode = Schema.Literals(["live", "record", "replay"])

export type ModelsMode = typeof ModelsMode.Type

export const modelsMode = (): ModelsMode =>
  Option.getOrElse(
    Schema.decodeUnknownOption(ModelsMode)(process.env["OI_E2E_MODELS"]),
    () => "live" as const,
  )

const CASSETTES = fileURLToPath(new URL("../cassettes", import.meta.url))

const UPSTREAMS = new Map([
  ["anthropic", "https://api.anthropic.com"],
  ["openai", "https://api.openai.com/v1"],
])

const Exchange = Schema.Struct({
  method: Schema.String,
  /** Path below the upstream root, without the query. */
  path: Schema.String,
  model: Schema.String,
  status: Schema.Int,
  content_type: Schema.String,
  body: Schema.String,
})

type Exchange = typeof Exchange.Type

const Cassette = Schema.Struct({ version: Schema.Literal(1), exchanges: Schema.Array(Exchange) })

const decodeCassette = Schema.decodeUnknownSync(Schema.fromJsonString(Cassette))

const ModelField = Schema.fromJsonString(Schema.Struct({ model: Schema.optionalKey(Schema.String) }))
const decodeModelField = Schema.decodeUnknownOption(ModelField)

const modelOf = (body: string): string =>
  Option.match(decodeModelField(body), { onNone: () => "", onSome: (parsed) => parsed.model ?? "" })

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Array<Buffer> = []

  for await (const chunk of request) chunks.push(Buffer.from(chunk))

  return Buffer.concat(chunks)
}

const queueKey = (method: string, rel: string, model: string): string => `${method} ${rel} ${model}`

const EventType = Schema.fromJsonString(Schema.Struct({ type: Schema.String }))
const decodeEventType = Schema.decodeUnknownOption(EventType)

/** Events that end a Responses API response, on either transport. */
const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed", "error"])

const isTerminal = (message: string): boolean =>
  Option.match(decodeEventType(message), { onNone: () => false, onSome: (event) => TERMINAL.has(event.type) })

/** The `data:` payloads of a recorded server-sent event stream. */
const ssePayloads = (body: string): Array<string> =>
  body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data !== "" && data !== "[DONE]")

const socketError = (status: number, message: string): string =>
  JSON.stringify({ type: "error", status, error: { type: "proxy_error", message } })

interface Route {
  readonly provider: string
  readonly rel: string
  readonly search: string
}

/** Where a proxied URL goes: the provider prefix and the path below the upstream root. */
const routeOf = (requestUrl: string | undefined): Route => {
  const url = new URL(requestUrl ?? "/", "http://proxy")
  const [, provider = "", ...restParts] = url.pathname.split("/")
  const rel = `/${restParts.join("/")}`

  // The Anthropic SDK puts /v1 in the path; the AI SDK puts it in the base URL.
  return {
    provider,
    rel: provider === "anthropic" && !rel.startsWith("/v1/") ? `/v1${rel}` : rel,
    search: url.search,
  }
}

/** Headers passed to the upstream: everything but hop-by-hop and encoding ones. */
const forwardHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers()
  const skip = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding"])

  for (const [name, value] of Object.entries(request.headers)) {
    if (skip.has(name) || value === undefined) continue

    headers.set(name, Array.isArray(value) ? value.join(", ") : value)
  }

  return headers
}

export class ModelProxy {
  readonly mode: ModelsMode
  readonly cassette: string
  private readonly server: Server
  private readonly sockets = new WebSocketServer({ noServer: true })
  /** Upstream sockets opened while recording, closed when the proxy stops. */
  private readonly upstreams = new Set<WebSocket>()
  private readonly recorded: Array<Exchange> = []
  private readonly queues = new Map<string, Array<Exchange>>()
  /** Exchanges still streaming from upstream; the CLI may exit before they finish. */
  private readonly inflight = new Set<Promise<void>>()
  /** Requests replay could not answer, reported when the scenario ends. */
  readonly misses: Array<string> = []
  private port = 0

  private constructor(mode: ModelsMode, name: string) {
    this.mode = mode
    this.cassette = path.join(CASSETTES, `${name}.json.gz`)
    this.server = createServer((request, response) => {
      const handled = this.handle(request, response).catch((error: Error) => {
        if (response.headersSent) {
          response.end()

          return
        }

        response.writeHead(599, { "content-type": "application/json" })
        response.end(
          JSON.stringify({ type: "error", error: { type: "proxy_error", message: error.message } }),
        )
      })

      this.inflight.add(handled)
      void handled.finally(() => this.inflight.delete(handled))
    })

    this.server.on("upgrade", (request, socket, head) => {
      this.sockets.handleUpgrade(request, socket, head, (client) => this.attach(request, client))
    })

    if (mode === "replay") {
      if (!fs.existsSync(this.cassette))
        throw new Error(`No cassette at ${this.cassette}. Record one with OI_E2E_MODELS=record.`)

      const text = gunzipSync(fs.readFileSync(this.cassette)).toString("utf8")

      for (const exchange of decodeCassette(text).exchanges) {
        const key = queueKey(exchange.method, exchange.path, exchange.model)

        this.queues.set(key, [...(this.queues.get(key) ?? []), exchange])
      }
    }
  }

  static async start(mode: ModelsMode, name: string): Promise<ModelProxy> {
    const proxy = new ModelProxy(mode, name)

    await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve))
    // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
    proxy.port = (proxy.server.address() as AddressInfo).port

    return proxy
  }

  /** Environment that routes the CLI's model calls through this proxy. */
  env(): Map<string, string> {
    const base = `http://127.0.0.1:${this.port}`

    const env = new Map([
      ["ANTHROPIC_BASE_URL", `${base}/anthropic`],
      ["OPENAI_BASE_URL", `${base}/openai`],
    ])

    // Replay needs no real keys, but the CLI refuses to start without one.
    if (this.mode === "replay") {
      env.set("ANTHROPIC_API_KEY", "replay")
      env.set("OPENAI_API_KEY", "replay")
    }

    return env
  }

  /** Serve one client WebSocket: each message is a `response.create` request. */
  private attach(request: IncomingMessage, client: ClientSocket): void {
    const { provider, rel } = routeOf(request.url)
    let upstream: Promise<WebSocket> | undefined
    // One response at a time per connection, in the order the requests arrived.
    let tail = Promise.resolve()

    const exchange = async (payload: string): Promise<void> => {
      const model = modelOf(payload)

      if (this.mode === "replay") return this.replaySocket(rel, model, client)

      upstream ??= this.dial(provider, rel, request.headers.authorization)

      const messages = await this.relay(await upstream, payload, client)

      this.recorded.push({
        method: "POST",
        path: rel,
        model,
        status: 200,
        content_type: "text/event-stream",
        body: messages.map((message) => `data: ${message}\n\n`).join(""),
      })
    }

    client.on("message", (data: Buffer) => {
      const handled = tail
        .then(() => exchange(data.toString("utf8")))
        .catch((error: Error) => {
          client.send(socketError(599, error.message))
        })

      tail = handled
      this.inflight.add(handled)
      void handled.finally(() => this.inflight.delete(handled))
    })
  }

  private dial(provider: string, rel: string, authorization: string | undefined): Promise<WebSocket> {
    const root = UPSTREAMS.get(provider)

    if (root === undefined) throw new Error(`Unknown provider prefix for a WebSocket: ${provider}`)

    const headers = authorization === undefined ? {} : { authorization }
    const socket = new WebSocket(`${root.replace(/^http/, "ws")}${rel}`, { headers })

    this.upstreams.add(socket)

    return new Promise((resolve, reject) => {
      socket.once("open", () => resolve(socket))
      socket.once("error", () => reject(new Error(`Could not open a WebSocket to ${provider}.`)))
    })
  }

  /** Send one request upstream and pass its events to the client, returning them for the cassette. */
  private relay(upstream: WebSocket, payload: string, client: ClientSocket): Promise<Array<string>> {
    return new Promise((resolve, reject) => {
      const messages: Array<string> = []

      const finish = (settle: () => void): void => {
        upstream.off("message", onMessage)
        upstream.off("close", onClose)
        settle()
      }

      const onMessage = (data: Buffer): void => {
        const message = data.toString("utf8")

        messages.push(message)
        client.send(message)

        if (isTerminal(message)) finish(() => resolve(messages))
      }

      const onClose = (): void =>
        finish(() => reject(new Error("The upstream WebSocket closed mid-response.")))

      upstream.on("message", onMessage)
      upstream.on("close", onClose)
      upstream.send(payload)
    })
  }

  private replaySocket(rel: string, model: string, client: ClientSocket): void {
    const next = (this.queues.get(queueKey("POST", rel, model)) ?? []).shift()

    if (next === undefined) {
      const miss = `POST ${rel} (model ${model || "none"})`

      this.misses.push(miss)
      client.send(socketError(599, `The cassette has no recorded reply for ${miss}.`))

      return
    }

    if (next.status !== 200) {
      client.send(socketError(next.status, next.body))

      return
    }

    for (const message of ssePayloads(next.body)) client.send(message)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { provider, rel, search } = routeOf(request.url)
    const method = request.method ?? "GET"
    const body = await readBody(request)
    const model = modelOf(body.toString("utf8"))

    if (this.mode === "replay") return this.replay(method, rel, model, response)

    const upstream = UPSTREAMS.get(provider)

    if (upstream === undefined) throw new Error(`Unknown provider prefix in ${request.url ?? "/"}`)

    const init: RequestInit = { method, headers: forwardHeaders(request), redirect: "error" }

    if (method !== "GET" && method !== "HEAD") init.body = body

    const reply = await fetch(`${upstream}${rel}${search}`, init)
    const contentType = reply.headers.get("content-type") ?? "application/octet-stream"

    response.writeHead(reply.status, { "content-type": contentType })

    // Stream through, so the TUI still sees tokens arrive, and keep a copy.
    const chunks: Array<Uint8Array> = []

    if (reply.body !== null) {
      for await (const chunk of reply.body) {
        chunks.push(chunk)
        response.write(chunk)
      }
    }

    response.end()

    this.recorded.push({
      method,
      path: rel,
      model,
      status: reply.status,
      content_type: contentType,
      body: Buffer.concat(chunks).toString("utf8"),
    })
  }

  private replay(method: string, rel: string, model: string, response: ServerResponse): void {
    const queue = this.queues.get(queueKey(method, rel, model)) ?? []
    const next = queue.shift()

    if (next === undefined) {
      const miss = `${method} ${rel} (model ${model || "none"})`

      this.misses.push(miss)
      response.writeHead(599, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "cassette_exhausted", message: `The cassette has no recorded reply for ${miss}.` },
        }),
      )

      return
    }

    response.writeHead(next.status, { "content-type": next.content_type })
    response.end(next.body)
  }

  /** Stop serving and, when recording, write the cassette. */
  async stop(save: boolean): Promise<void> {
    // Let exchanges the CLI stopped reading finish recording (a stream's last
    // events can arrive after the CLI has what it needs and exited).
    await Promise.race([Promise.allSettled(this.inflight), setTimeout(30_000)])

    for (const upstream of this.upstreams) upstream.terminate()

    for (const client of this.sockets.clients) client.terminate()

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })

    if (this.mode === "record" && save) {
      fs.mkdirSync(path.dirname(this.cassette), { recursive: true })
      // Gzipped: Responses API streams repeat the whole response in several
      // events, and model lists are large; both compress tenfold or more.
      // Read one with `gunzip -c <file> | jq`.
      fs.writeFileSync(
        this.cassette,
        gzipSync(`${JSON.stringify({ version: 1, exchanges: this.recorded }, null, 1)}\n`, { level: 9 }),
      )
    }
  }
}
