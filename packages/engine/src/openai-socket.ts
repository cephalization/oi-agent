/**
 * WebSocket transport for the OpenAI Responses API.
 *
 * Over plain HTTP, each request can land on a different machine, and OpenAI's
 * prompt cache is only found on the machine that wrote it: in measurements on
 * the ChatGPT plan route, even a byte-identical request repeated back to back
 * read nothing from the cache most of the time. A WebSocket stays on one
 * machine, so every call after the first reuses the cached prefix.
 *
 * Nothing about the request changes. Each call still sends the whole
 * conversation derived from the span files; `previous_response_id` is never
 * used, so the server holds no state the session depends on. A dropped or
 * recycled connection costs one uncached call and nothing else.
 *
 * One connection is kept per conversation, because the cache follows the
 * connection. Connections are replaced before OpenAI's 60-minute limit and
 * closed after sitting idle.
 */
import type { Socket } from "node:net"
import WebSocket from "ws"

/** The socket could not be used at all; the caller should fall back to HTTP. */
export class SocketUnavailable extends Error {}

/** The socket closed after part of a response had already arrived. */
export class SocketInterrupted extends Error {}

/** OpenAI closes a connection at 60 minutes; replace it comfortably before then. */
const MAX_AGE_MS = 50 * 60_000

/** The prompt cache lasts 30 minutes, so an idle connection is worth keeping about that long. */
const IDLE_MS = 20 * 60_000
const CONNECT_TIMEOUT_MS = 10_000
const SWEEP_MS = 60_000
const MAX_CONNECTIONS = 8

/** After a failed connect, use HTTP for this long before trying a socket again. */
const BACKOFF_MS = 5 * 60_000

class Connection {
  readonly openedAt = Date.now()
  lastUsed = Date.now()
  busy = false
  closed = false
  private readonly socket: WebSocket
  private readonly transport: Socket | undefined
  private readonly queue: Array<string> = []
  private wake: (() => void) | undefined

  constructor(socket: WebSocket, transport: Socket | undefined) {
    this.socket = socket
    this.transport = transport
    socket.on("message", (data: Buffer) => {
      this.queue.push(data.toString("utf8"))
      this.wake?.()
    })
    socket.on("close", () => this.markClosed())
    socket.on("error", () => this.markClosed())
    // An idle connection must not keep the process alive: it is only a cache
    // warmer. It holds the process while a response is in flight, no longer.
    transport?.unref()
  }

  private markClosed(): void {
    this.closed = true
    this.wake?.()
  }

  get usable(): boolean {
    return !this.closed && !this.busy && Date.now() - this.openedAt < MAX_AGE_MS
  }

  get idleFor(): number {
    return Date.now() - this.lastUsed
  }

  /**
   * Drop the connection at once. A closing handshake with OpenAI takes about
   * two seconds, which would delay every exit; nothing is lost by skipping it.
   */
  close(): void {
    this.markClosed()
    this.socket.terminate()
  }

  /** Send one request and yield the server's messages until the caller stops reading. */
  async *exchange(payload: string, signal: AbortSignal): AsyncGenerator<string> {
    const abort = (): void => this.close()
    let received = 0

    this.busy = true
    this.transport?.ref()
    // Anything left from an earlier response is not part of this one.
    this.queue.length = 0
    signal.addEventListener("abort", abort, { once: true })

    try {
      this.socket.send(payload)

      for (;;) {
        const next = this.queue.shift()

        if (next !== undefined) {
          received += 1
          yield next
          continue
        }

        if (signal.aborted) throw new SocketInterrupted("The request was cancelled.")

        if (this.closed) {
          throw received === 0
            ? new SocketUnavailable("The connection closed before a reply arrived.")
            : new SocketInterrupted("The connection closed before the response completed.")
        }

        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    } finally {
      signal.removeEventListener("abort", abort)
      this.transport?.unref()
      this.busy = false
      this.lastUsed = Date.now()
    }
  }
}

const pools = new Set<ResponsesSockets>()

/** Close every model connection now. Idle connections never keep the process alive on their own. */
export const closeModelSockets = (): void => {
  for (const pool of pools) pool.close()
}

export class ResponsesSockets {
  private readonly url: string
  private readonly token: () => Promise<string | undefined>
  private readonly connections = new Map<string, Connection>()
  private sweeper: ReturnType<typeof setInterval> | undefined
  private retryAt = 0

  /** `baseUrl` is the API root, for example `https://api.openai.com/v1`. */
  constructor(baseUrl: string, token: () => Promise<string | undefined>) {
    this.url = `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/responses`
    this.token = token
  }

  /** False while backing off after a failed connect. */
  get available(): boolean {
    return Date.now() >= this.retryAt
  }

  /** How many connections are open, for tests and diagnostics. */
  get size(): number {
    return this.connections.size
  }

  private async connect(): Promise<Connection> {
    const token = await this.token()
    const headers = token === undefined ? {} : { authorization: `Bearer ${token}` }
    const socket = new WebSocket(this.url, { headers, handshakeTimeout: CONNECT_TIMEOUT_MS })
    let transport: Socket | undefined

    socket.on("upgrade", (response) => {
      transport = response.socket
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (): void => reject(new SocketUnavailable("The server refused the connection."))

        socket.once("open", resolve)
        socket.once("error", fail)
        socket.once("close", fail)
      })
    } catch (error) {
      socket.terminate()
      this.retryAt = Date.now() + BACKOFF_MS
      throw error
    }

    return new Connection(socket, transport)
  }

  private evict(): void {
    for (const [key, connection] of this.connections) {
      if (connection.closed || (!connection.busy && connection.idleFor > IDLE_MS)) {
        connection.close()
        this.connections.delete(key)
      }
    }

    if (this.connections.size === 0) this.rest()
  }

  private remember(key: string, connection: Connection): void {
    const idle = [...this.connections].filter(([, existing]) => !existing.busy)
    const oldest = idle.toSorted(([, a], [, b]) => a.lastUsed - b.lastUsed)[0]

    if (this.connections.size >= MAX_CONNECTIONS && oldest !== undefined) {
      oldest[1].close()
      this.connections.delete(oldest[0])
    }

    this.connections.set(key, connection)
    // Registered only while it holds connections, so a model that is no longer used is forgotten.
    pools.add(this)

    if (this.sweeper === undefined) {
      this.sweeper = setInterval(() => this.evict(), SWEEP_MS)
      this.sweeper.unref()
    }
  }

  /**
   * Send a `response.create` payload on the connection for `key` and yield the
   * server's messages. `key` identifies the conversation, so its later calls
   * reach the machine that cached its prefix.
   *
   * Throws `SocketUnavailable` when no socket could carry the request, in
   * which case nothing was received and the caller can use HTTP instead.
   */
  async *request(key: string, payload: string, signal: AbortSignal): AsyncGenerator<string> {
    const existing = this.connections.get(key)

    if (existing?.usable === true) {
      try {
        yield* existing.exchange(payload, signal)

        return
      } catch (error) {
        this.connections.delete(key)
        existing.close()

        // A kept connection can have died quietly; one fresh connection is worth trying.
        if (!(error instanceof SocketUnavailable)) throw error
      }
    }

    // The conversation's own connection is busy or too old: leave a busy one alone.
    if (existing !== undefined && !existing.busy) {
      existing.close()
      this.connections.delete(key)
    }

    const connection = await this.connect()
    const kept = !this.connections.has(key)

    if (kept) this.remember(key, connection)

    try {
      yield* connection.exchange(payload, signal)
    } catch (error) {
      if (kept) this.connections.delete(key)

      connection.close()
      throw error
    } finally {
      if (!kept) connection.close()
    }
  }

  /** Stop sweeping and drop out of the registry until there is a connection again. */
  private rest(): void {
    clearInterval(this.sweeper)
    this.sweeper = undefined
    pools.delete(this)
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close()

    this.connections.clear()
    this.rest()
  }
}
