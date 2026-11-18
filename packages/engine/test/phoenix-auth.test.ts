import * as fs from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { listenForCallback } from "../src/oauth.ts"
import {
  checkPhoenixKey,
  discoverPhoenixLogin,
  PhoenixLoginError,
  probePhoenix,
  startPhoenixLogin,
} from "../src/remote/phoenix-auth.ts"

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

interface Received {
  readonly method: string
  readonly path: string
  readonly authorization: string
  readonly body: string
}

interface Reply {
  readonly status: number
  readonly body: string
  readonly type?: string
}

/** A server answering as `respond` says, recording what it was sent. */
const serve = async (respond: (request: Received) => Reply) => {
  const requests: Array<Received> = []

  const server = http.createServer((request, response) => {
    const chunks: Array<Buffer> = []

    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const received = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        authorization: request.headers.authorization ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      }

      requests.push(received)

      const reply = respond(received)

      response.writeHead(reply.status, { "content-type": reply.type ?? "application/json" })
      response.end(reply.body)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => {
    server.close()
    server.closeAllConnections()
  })

  // SAFETY: a listening TCP server's address is always an AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo

  return { url: `http://127.0.0.1:${port}`, requests }
}

const SPA: Reply = { status: 200, body: "<!doctype html><title>Phoenix</title>", type: "text/html" }
const NOT_FOUND: Reply = { status: 404, body: '{"detail":"Not Found"}' }

interface PhoenixOptions {
  readonly auth?: boolean
  /** `off`: no authorization server; `closed`: one that registers no new clients. */
  readonly login?: "on" | "off" | "closed"
  readonly keys?: "on" | "off"
}

/** Enough of Phoenix for a login: discovery, registration, token, key creation, revocation. */
const phoenix = (options: PhoenixOptions = {}) => {
  const login = options.login ?? "on"

  return serve((request): Reply => {
    const route = request.path.split("?")[0]

    if (route === "/arize_phoenix_version") return { status: 200, body: "21.0.0", type: "text/plain" }

    if (route === "/v1/projects") {
      const allowed = options.auth !== true || request.authorization === "Bearer made-by-phoenix"

      return allowed
        ? { status: 200, body: '{"data":[]}' }
        : { status: 401, body: '{"detail":"Invalid token"}' }
    }

    if (route === "/.well-known/oauth-authorization-server") {
      if (login === "off") return SPA

      const metadata = { issuer: "x", authorization_endpoint: "x/authorize", token_endpoint: "x/token" }

      return {
        status: 200,
        body: JSON.stringify(
          login === "closed" ? metadata : { ...metadata, registration_endpoint: "x/register" },
        ),
      }
    }

    if (route === "/oauth2/register")
      return login === "closed"
        ? { status: 403, body: '{"error":"invalid_client_metadata"}' }
        : { status: 201, body: '{"client_id":"px_dcr_test"}' }

    if (route === "/oauth2/token")
      return new URLSearchParams(request.body).get("code") === "good-code"
        ? { status: 200, body: '{"access_token":"access","refresh_token":"refresh","token_type":"Bearer"}' }
        : { status: 400, body: '{"error":"invalid_grant"}' }

    if (route === "/v1/user/api_keys")
      return options.keys === "off" || request.authorization !== "Bearer access"
        ? { status: 403, body: "{}" }
        : { status: 201, body: '{"data":{"id":"1","name":"oi","key":"made-by-phoenix"}}' }

    if (route === "/oauth2/revoke") return { status: 200, body: "" }

    return NOT_FOUND
  })
}

const env = (): NodeJS.ProcessEnv => ({
  OI_AGENT_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "oi-phoenix-auth-")),
})

const start = (endpoint: string, environment: NodeJS.ProcessEnv = env(), timeoutMs?: number) =>
  startPhoenixLogin({
    endpoint,
    keyName: "oi-agent test",
    keyDescription: "Created by a test.",
    env: environment,
    timeoutMs,
  })

/** Where the browser would be sent back to, with these parameters. */
const back = (loginUrl: string, params: ReadonlyArray<[string, string]>): string => {
  const asked = new URL(loginUrl).searchParams

  return `${asked.get("redirect_uri")}?${new URLSearchParams([...params]).toString()}`
}

const stateOf = (loginUrl: string): string => new URL(loginUrl).searchParams.get("state") ?? ""

const reason = (login: { readonly key: Promise<string> }): Promise<string> =>
  login.key.then(
    () => "resolved",
    (error) => (error instanceof PhoenixLoginError ? `${error.reason}: ${error.message}` : "other"),
  )

describe("what a Phoenix server is", () => {
  it("tells a server without auth from one that asks for a key, and from something that is not Phoenix", async () => {
    const open = await phoenix()
    const locked = await phoenix({ auth: true })
    const other = await serve(() => SPA)

    expect(await probePhoenix(open.url)).toEqual({ version: "21.0.0", auth: "none" })
    expect(await probePhoenix(`${locked.url}/`)).toEqual({ version: "21.0.0", auth: "required" })
    expect(await probePhoenix(other.url)).toMatchObject({ version: undefined, auth: "unknown" })
    expect((await probePhoenix("http://127.0.0.1:9")).auth).toBe("unknown")

    // Nothing was sent to find out but two plain GETs.
    expect(locked.requests.map((request) => [request.method, request.authorization])).toEqual([
      ["GET", ""],
      ["GET", ""],
    ])
  })

  it("checks a key with the request the probe made", async () => {
    const locked = await phoenix({ auth: true })

    expect(await checkPhoenixKey(locked.url, "made-by-phoenix")).toBe("accepted")
    expect(await checkPhoenixKey(locked.url, "wrong")).toBe("rejected")
    expect(await checkPhoenixKey("http://127.0.0.1:9", "any")).toBe("unreachable")
  })

  it("counts only parsing metadata as support for browser login", async () => {
    const down = await serve(() => ({ status: 503, body: "restarting" }))

    expect(await discoverPhoenixLogin((await phoenix()).url)).toEqual({ status: "supported" })
    // An older Phoenix answers every unknown path with its web app and a 200.
    expect((await discoverPhoenixLogin((await phoenix({ login: "off" })).url)).status).toBe("unsupported")
    expect((await discoverPhoenixLogin((await serve(() => NOT_FOUND)).url)).status).toBe("unsupported")
    expect((await discoverPhoenixLogin((await phoenix({ login: "closed" })).url)).status).toBe("unsupported")
    // Unwell is not the same as unable.
    expect((await discoverPhoenixLogin(down.url)).status).toBe("unreachable")
    expect((await discoverPhoenixLogin("http://127.0.0.1:9")).status).toBe("unreachable")
  })
})

describe("logging in to Phoenix through the browser", () => {
  it("turns an approved login into an API key, and revokes the grant that made it", async () => {
    const server = await phoenix({ auth: true })
    const environment = env()
    const login = await start(server.url, environment)
    const asked = new URL(login.url)

    expect(asked.pathname).toBe("/oauth2/authorize")
    expect(asked.searchParams.get("client_id")).toBe("px_dcr_test")
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256")
    expect(asked.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    const page = await fetch(
      back(login.url, [
        ["code", "good-code"],
        ["state", stateOf(login.url)],
      ]),
    )

    expect(page.status).toBe(200)
    expect(await page.text()).toContain("Logged in to Phoenix")
    expect(await login.key).toBe("made-by-phoenix")

    const sent = server.requests.map((request) => `${request.method} ${request.path.split("?")[0]}`)

    expect(sent).toEqual([
      "POST /oauth2/register",
      "POST /oauth2/token",
      "POST /v1/user/api_keys",
      "POST /oauth2/revoke",
    ])

    const exchange = new URLSearchParams(server.requests[1]?.body)

    // The verifier goes to the token endpoint only; the browser saw its hash.
    expect(exchange.get("code_verifier")).not.toBe(asked.searchParams.get("code_challenge"))
    expect(exchange.get("redirect_uri")).toBe(asked.searchParams.get("redirect_uri"))
    expect(JSON.parse(server.requests[2]?.body ?? "{}")).toEqual({
      data: { name: "oi-agent test", description: "Created by a test." },
    })
    expect(new URLSearchParams(server.requests[3]?.body).get("token")).toBe("refresh")

    // The client id is kept, so a second login does not register again.
    const again = await start(server.url, environment)

    again.cancel()
    expect(await reason(again)).toMatch(/^cancelled/)
    expect(server.requests.filter((request) => request.path === "/oauth2/register")).toHaveLength(1)
  })

  it("is not ended by a request that is not its own, and refuses one with a bad address", async () => {
    const server = await phoenix()
    const login = await start(server.url)
    const redirect = new URL(login.url).searchParams.get("redirect_uri") ?? ""

    // Another tab, a scan of local ports, a forged callback: none has this login's state.
    const forged = await fetch(`${redirect}?code=good-code&state=someone-elses`)

    expect(forged.status).toBe(400)
    expect(await forged.text()).toContain("not the login oi is waiting for")
    expect((await fetch(redirect.replace("/callback", "/elsewhere"))).status).toBe(404)
    expect(
      (await fetch(`${redirect}?state=${stateOf(login.url)}`, { headers: { host: "a b:c" } })).status,
    ).not.toBe(500)

    // Still waiting: the real one completes it.
    await fetch(
      back(login.url, [
        ["code", "good-code"],
        ["state", stateOf(login.url)],
      ]),
    )
    expect(await login.key).toBe("made-by-phoenix")
  })

  it("says so when the person refuses, when they cancel, and when nobody answers", async () => {
    const server = await phoenix()
    const denied = await start(server.url)

    await fetch(
      back(denied.url, [
        ["error", "access_denied"],
        ["state", stateOf(denied.url)],
      ]),
    )
    expect(await reason(denied)).toBe("denied: The login was not approved.")

    const cancelled = await start(server.url)

    cancelled.cancel()
    expect(await reason(cancelled)).toBe("cancelled: The Phoenix login was cancelled.")
    // Its address is closed: a browser arriving late finds nothing.
    await expect(fetch(back(cancelled.url, [["state", stateOf(cancelled.url)]]))).rejects.toThrow(
      "fetch failed",
    )

    const slow = await start(server.url, env(), 30)

    expect(await reason(slow)).toBe("failed: The Phoenix login timed out.")
  })

  it("takes the address a browser ended on, pasted, when the browser could not reach this machine", async () => {
    const server = await phoenix()
    const login = await start(server.url)

    expect(login.paste("localhost again")).toMatch(/not a URL/)
    expect(login.paste("http://127.0.0.1:1/callback?code=good-code&state=wrong")).toMatch(
      /does not belong to this login/,
    )
    expect(
      login.paste(
        `  ${back(login.url, [
          ["code", "good-code"],
          ["state", stateOf(login.url)],
        ])}\n`,
      ),
    ).toBeUndefined()
    expect(await login.key).toBe("made-by-phoenix")
  })

  it("forgets a client id that did not work, and explains each way Phoenix can refuse", async () => {
    const closed = await phoenix({ login: "closed" })

    await expect(start(closed.url)).rejects.toMatchObject({
      reason: "unsupported",
      message: "This Phoenix has client registration disabled, so browser login is unavailable.",
    })

    const server = await phoenix()
    const environment = env()
    const login = await start(server.url, environment)

    await fetch(
      back(login.url, [
        ["code", "stale-code"],
        ["state", stateOf(login.url)],
      ]),
    )
    expect(await reason(login)).toBe("failed: Phoenix did not complete the login (HTTP 400).")

    // The next attempt registers afresh: the id may have been what Phoenix no longer knew.
    const retry = await start(server.url, environment)

    retry.cancel()
    await reason(retry)
    expect(server.requests.filter((request) => request.path === "/oauth2/register")).toHaveLength(2)

    const keyless = await phoenix({ keys: "off" })
    const logged = await start(keyless.url)

    await fetch(
      back(logged.url, [
        ["code", "good-code"],
        ["state", stateOf(logged.url)],
      ]),
    )
    expect(await reason(logged)).toBe("failed: Logged in, but Phoenix did not create an API key (HTTP 403).")
    // The grant is revoked even so: nothing of the login is left behind.
    expect(keyless.requests.at(-1)?.path).toBe("/oauth2/revoke")
  })
})

describe("the loopback callback", () => {
  it("answers only its path, on the loopback address, and decides the page by what it is told", async () => {
    const seen: Array<string> = []

    const callback = await listenForCallback({
      path: "/callback",
      onCallback: (params) => {
        seen.push(params.toString())

        return { ok: params.has("code"), title: "Done" }
      },
    })

    cleanup.push(callback.close)
    expect(callback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect((await fetch(`${callback.redirectUri}?code=1`)).status).toBe(200)
    expect((await fetch(callback.redirectUri)).status).toBe(400)
    expect((await fetch(callback.redirectUri.replace("/callback", "/"))).status).toBe(404)
    expect(seen).toEqual(["code=1", ""])
  })
})
