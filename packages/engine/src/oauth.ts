/**
 * What every browser sign-in from a terminal needs (RFC 8252): a secret the
 * authorization server can check without being told it (PKCE), and a web
 * server on this machine's loopback address for the browser to come back to.
 * Used to sign in with ChatGPT and to log in to Phoenix.
 */
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { Schema } from "effect"

/** An unguessable value for `state`, a nonce or a PKCE verifier. */
export const randomToken = (bytes: number = 32): string => randomBytes(bytes).toString("base64url")

/** The S256 challenge for a PKCE verifier. */
export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url")

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.off("error", reject)

      const address = server.address()

      resolve(address !== null && !Schema.is(Schema.String)(address) ? address.port : port)
    })
  })

const page = (title: string): string =>
  `<!doctype html><meta charset="utf-8"><title>oi-agent</title><body style="font:16px system-ui;max-width:32rem;margin:20vh auto"><h1>${title}</h1><p>You can close this tab and return to the terminal.</p>`

/** What the browser is shown when it comes back. */
export interface CallbackReply {
  readonly ok: boolean
  /** The page's heading. Never built from the request: it is written into HTML as is. */
  readonly title: string
}

export interface LoopbackCallback {
  /** `http://127.0.0.1:<port><path>`: the redirect URI to give the authorization server. */
  readonly redirectUri: string
  readonly close: () => void
}

export interface LoopbackOptions {
  /** The only path answered; anything else is a 404. */
  readonly path: string
  /** Tried first, for a server that wants the same redirect each time; any free port otherwise. */
  readonly preferredPort?: number
  /** Called with the query of each request to `path`. Decides what the browser is told. */
  readonly onCallback: (params: URLSearchParams) => CallbackReply
}

/**
 * Listen on the loopback address for the browser's redirect. Only this
 * machine can reach it. The request is parsed against a fixed base: its Host
 * header is whatever the sender wrote, and is never read.
 */
export const listenForCallback = async (options: LoopbackOptions): Promise<LoopbackCallback> => {
  const server = createServer((request, response) => {
    const target = request.url ?? "/"
    const url = URL.canParse(target, "http://127.0.0.1") ? new URL(target, "http://127.0.0.1") : undefined

    if (url === undefined) {
      response.writeHead(400).end()

      return
    }

    if (url.pathname !== options.path) {
      response.writeHead(404).end()

      return
    }

    const reply = options.onCallback(url.searchParams)

    response.writeHead(reply.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
    response.end(page(reply.title))
  })

  const port =
    options.preferredPort === undefined
      ? await listen(server, 0)
      : await listen(server, options.preferredPort).catch(() => listen(server, 0))

  return {
    redirectUri: `http://127.0.0.1:${port}${options.path}`,
    close: () => {
      server.close()
      // A browser keeps its connection open; it must not keep the process alive.
      server.closeAllConnections()
    },
  }
}
