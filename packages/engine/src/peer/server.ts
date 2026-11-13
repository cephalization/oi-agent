import { randomBytes, timingSafeEqual } from "node:crypto"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { Option, Schema } from "effect"
import type { Engine } from "../engine.ts"
import { loadSession } from "../fold.ts"
import { readMetadata } from "../format.ts"
import type { StoreEvent } from "../store.ts"
import type { Json } from "../wire.ts"
import { type Manifest, PromptRequest, type Role, type SessionInfo } from "./protocol.ts"

export interface ShareTokens {
  /** Can watch. */
  readonly viewer: string
  /** Can watch and submit prompts. Tool approvals still stay with the host. */
  readonly driver: string
}

export interface PeerServer {
  readonly port: number
  readonly tokens: ShareTokens
  /** Names of peers currently following the session. */
  readonly peers: () => ReadonlyArray<string>
  readonly close: () => Promise<void>
}

const decodePrompt = Schema.decodeUnknownOption(Schema.fromJsonString(PromptRequest))

const same = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

const readBody = async (request: http.IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = []

  for await (const chunk of request) chunks.push(Buffer.from(chunk))

  return Buffer.concat(chunks).toString("utf8")
}

const json = (response: http.ServerResponse, status: number, body: Json): void => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/**
 * Run prompts that peers left in the inbox. An entry is pending until some
 * turn names it in its metadata, so this is safe to call again after a crash.
 */
export const drainInbox = (engine: Engine, sessionId: string): void => {
  const consumed = new Set(
    loadSession(engine.store, sessionId).turns.map((turn) => readMetadata(turn.root).inbox_id),
  )

  for (const entry of engine.store.listInbox(sessionId)) {
    if (consumed.has(entry.id) || queued.has(entry.id)) continue

    queued.add(entry.id)
    void engine.submit(sessionId, { text: entry.text, userId: entry.user_id, inboxId: entry.id })
  }
}

const queued = new Set<string>()

/** Serve one session to peers. Binds to loopback; a tunnel exposes it. */
export const servePeers = async (engine: Engine, sessionId: string): Promise<PeerServer> => {
  const tokens: ShareTokens = {
    viewer: randomBytes(16).toString("base64url"),
    driver: randomBytes(16).toString("base64url"),
  }

  const followers = new Map<http.ServerResponse, string>()

  const roleOf = (request: http.IncomingMessage): Role | undefined => {
    const token = (request.headers.authorization ?? "").replace(/^Bearer /, "")

    if (same(token, tokens.driver)) return "driver"

    return same(token, tokens.viewer) ? "viewer" : undefined
  }

  const manifest = (): Manifest => ({
    paths: engine.store.manifest(sessionId),
    open: engine.store
      .listTraceIds(sessionId)
      .flatMap((traceId) => engine.store.readTrace(sessionId, traceId).open)
      .map((entry) => ({ span: entry.span, deltas: [...entry.deltas] })),
  })

  const follow = (request: http.IncomingMessage, response: http.ServerResponse, name: string): void => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    response.write(": connected\n\n")
    followers.set(response, name)
    request.on("close", () => followers.delete(response))
  }

  const prompt = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    name: string,
  ): Promise<void> => {
    const body = Option.getOrUndefined(decodePrompt(await readBody(request)))

    if (body === undefined || body.text.trim() === "")
      return json(response, 400, { error: "expected { text }" })

    const entry = engine.store.writeInbox(sessionId, { user_id: name, text: body.text })

    drainInbox(engine, sessionId)
    json(response, 202, { inbox_id: entry.id })
  }

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://peer")
    const role = roleOf(request)
    const name = String(request.headers["x-oi-user"] ?? "guest").slice(0, 40)
    const header = engine.store.readHeader(sessionId)

    if (role === undefined || header === undefined)
      return json(response, 401, { error: "invalid share token" })

    if (request.method === "GET" && url.pathname === "/v1/session") {
      const info: SessionInfo = { header, role, host: engine.config.user }

      return json(response, 200, info)
    }

    if (request.method === "GET" && url.pathname === "/v1/manifest") return json(response, 200, manifest())

    if (request.method === "GET" && url.pathname === "/v1/file") {
      const contents = engine.store.readSyncFile(sessionId, url.searchParams.get("path") ?? "")

      if (contents === undefined) return json(response, 404, { error: "no such file" })

      response.writeHead(200, { "content-type": "application/json" })

      return void response.end(contents)
    }

    if (request.method === "GET" && url.pathname === "/v1/events") return follow(request, response, name)

    if (request.method === "POST" && url.pathname === "/v1/prompt") {
      if (role !== "driver") return json(response, 403, { error: "this share link is view-only" })

      return prompt(request, response, name)
    }

    json(response, 404, { error: "not found" })
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => json(response, 500, { error: "internal error" }))
  })

  const unsubscribe = engine.store.subscribe((event: StoreEvent) => {
    if (event.session_id !== sessionId) return

    const frame = `data: ${JSON.stringify(event)}\n\n`

    for (const response of followers.keys()) response.write(frame)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  // SAFETY: a listening TCP server's address is always an AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo

  return {
    port,
    tokens,
    peers: () => [...followers.values()],
    close: async () => {
      unsubscribe()

      for (const response of followers.keys()) response.end()

      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
