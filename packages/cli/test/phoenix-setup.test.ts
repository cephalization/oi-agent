import * as fs from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { OI, Store } from "@oi-agent/engine"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { type Dialog, normalizeEndpoint, setupPhoenix } from "../src/phoenix-setup.ts"
import { PhoenixConnection } from "../src/storage.ts"

const cleanup: Array<() => void> = []

afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

/** A Phoenix without auth that counts what is posted to it. */
const phoenix = async () => {
  const posts: Array<string> = []

  const server = http.createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      if (request.method === "POST") posts.push(request.url ?? "")

      const version = request.url === "/arize_phoenix_version"

      response.writeHead(200, { "content-type": version ? "text/plain" : "application/json" })
      response.end(version ? "21.0.0" : '{"data":[]}')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => {
    server.close()
    server.closeAllConnections()
  })

  // SAFETY: a listening TCP server's address is always an AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo

  return { url: `http://127.0.0.1:${port}`, posts }
}

/** A dialog that gives scripted answers, and records what it was asked and told. */
const scripted = (answers: ReadonlyArray<string | undefined>) => {
  const said: Array<string> = []
  const queue = [...answers]

  const next = (label: string, fallback: string): Promise<string | undefined> => {
    said.push(`? ${label}`)

    const answer = queue.shift()

    return Promise.resolve(answer === "" ? fallback : answer)
  }

  const dialog: Dialog = {
    ask: next,
    secret: (label) => next(label, ""),
    choose: (title, _options, fallback) => next(title, fallback),
    ok: (text) => said.push(`✓ ${text}`),
    warn: (text) => said.push(`! ${text}`),
    note: (text) => said.push(text),
    open: (url) => said.push(`open ${url}`),
    paste: (label) => next(label, ""),
  }

  return { dialog, said }
}

const CURRENT = { endpoint: "", project: "oi-agent" }

describe("choosing a Phoenix server", () => {
  it("reads a URL the way a person types one", () => {
    expect(normalizeEndpoint(" localhost:6006/ ")).toBe("http://localhost:6006")
    expect(normalizeEndpoint("127.0.0.1:6006")).toBe("http://127.0.0.1:6006")
    expect(normalizeEndpoint("phoenix.example.com")).toBe("https://phoenix.example.com")
    expect(normalizeEndpoint("http://phoenix.internal:6006///")).toBe("http://phoenix.internal:6006")
  })

  it("asks nothing about keys of a server that wants none", async () => {
    const server = await phoenix()
    const { dialog, said } = scripted([server.url.replace("http://", ""), "team"])

    expect(await setupPhoenix(dialog, CURRENT, {})).toEqual({ endpoint: server.url, project: "team" })
    expect(said.filter((line) => line.startsWith("?"))).toEqual([
      "? Phoenix URL (type `none` to turn export off)",
      "? Phoenix project",
    ])
    expect(said).toContain(`✓ Connected to Phoenix 21.0.0 at ${server.url}.`)
  })

  it("turns export off with `none`, and changes nothing when backed out of", async () => {
    expect(
      await setupPhoenix(scripted(["none"]).dialog, { endpoint: "http://old", project: "p" }, {}),
    ).toEqual({
      endpoint: "",
      project: "p",
    })
    expect(await setupPhoenix(scripted([undefined]).dialog, CURRENT, {})).toBeUndefined()

    const server = await phoenix()

    // Backed out at the second question: the first answer is not kept either.
    expect(await setupPhoenix(scripted([server.url, undefined]).dialog, CURRENT, {})).toBeUndefined()
  })

  it("says what is not responding as a Phoenix server, and asks again or keeps it as told", async () => {
    const server = await phoenix()
    const again = scripted(["http://127.0.0.1:9", "retry", server.url, ""])

    expect(await setupPhoenix(again.dialog, CURRENT, {})).toEqual({
      endpoint: server.url,
      project: "oi-agent",
    })
    expect(
      again.said.some((line) =>
        line.startsWith("! http://127.0.0.1:9 is not responding as a Phoenix server"),
      ),
    ).toBe(true)

    // Kept anyway (the server is down for now): no key is asked for or needed to save it.
    const kept = scripted(["http://127.0.0.1:9", "keep", "", "skip"])

    expect(await setupPhoenix(kept.dialog, CURRENT, {})).toEqual({
      endpoint: "http://127.0.0.1:9",
      project: "oi-agent",
    })
  })

  it("warns when the environment will win over what was chosen", async () => {
    const server = await phoenix()
    const { dialog, said } = scripted([server.url, ""])

    await setupPhoenix(dialog, CURRENT, { PHOENIX_COLLECTOR_ENDPOINT: "http://elsewhere:6006" })
    expect(said).toContain(
      "! PHOENIX_COLLECTOR_ENDPOINT is set in your environment and overrides this setting the next time oi starts.",
    )
  })
})

describe("a Phoenix connection that can change", () => {
  it("sends the old server what it was owed, then exports to the new one, and to none when turned off", async () => {
    const first = await phoenix()
    const second = await phoenix()
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "oi-connection-")))
    const sessionId = store.createSession(os.tmpdir()).id
    const connection = new PhoenixConnection(store, { endpoint: first.url, project: "one" })
    const stop = connection.watch()
    let count = 0

    const span = (): void => {
      count += 1

      const time = new Date(Date.now() + count).toISOString()

      store.endSpan(sessionId, {
        name: "turn",
        context: { trace_id: String(count).padStart(32, "0"), span_id: String(count).padStart(16, "0") },
        span_kind: "SPAN_KIND_INTERNAL",
        parent_id: null,
        start_time: time,
        end_time: time,
        status_code: "OK",
        status_message: "",
        attributes: { [OI.SESSION_ID]: sessionId, [OI.SPAN_KIND]: "AGENT" },
        events: [],
      })
    }

    span()
    // Switched while the first span is still queued: it goes to the server it was written under.
    await connection.connect({ endpoint: second.url, project: "two" })
    expect(first.posts).toEqual(["/v1/traces"])
    expect(connection.exporter?.target).toEqual({ endpoint: second.url, project: "two" })

    span()
    await connection.flush()
    expect(second.posts).toEqual(["/v1/traces"])
    expect(first.posts).toHaveLength(1)

    // The new server has not seen the session's earlier spans: a sweep owes it all of them, once.
    connection.exporter?.sweep(sessionId)
    await connection.flush()
    expect(connection.exporter?.report().spans).toBe(2)

    await connection.connect(undefined)
    expect(connection.current).toBeUndefined()
    span()
    await connection.flush()
    expect([first.posts.length, second.posts.length]).toEqual([1, 2])

    stop()
    store.close()
  })
})
