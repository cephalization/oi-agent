import * as fs from "node:fs"
import * as http from "node:http"
import { type AddressInfo, createConnection } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import { loadSession, pendingInbox } from "../src/fold.ts"
import { OI, type SpanFile, writeMetadata } from "../src/format.ts"
import { scriptedModel } from "../src/model.ts"
import { joinSession, type PeerConnection } from "../src/peer/client.ts"
import { type PeerServer, servePeers } from "../src/peer/server.ts"
import { formatShareLink, parseShareLink } from "../src/peer/tailcat.ts"
import type { StoreEvent } from "../src/store.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const say = (value: string): Json => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn" })

const until = async (check: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

const host = async (
  delay = 30,
): Promise<{ engine: Engine; sessionId: string; server: PeerServer; base: string }> => {
  const store = tempStore()

  const engine = new Engine({
    store,
    config: loadConfig({ OI_AGENT_CONFIG_DIR: store.home, OI_AGENT_USER: "host" }),
    model: scriptedModel((call) => say(`reply ${call.messages.length}`), delay),
    approvals: "allow",
    runner: () => "sleep 30",
  })

  const sessionId = engine.createSession(fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-peer-"))).id
  const server = await servePeers(engine, sessionId)

  cleanup.push(() => server.close())
  cleanup.push(() => engine.close())

  return { engine, sessionId, server, base: `http://127.0.0.1:${server.port}` }
}

const join = async (
  base: string,
  token: string,
  user: string,
): Promise<{ peer: PeerConnection; store: ReturnType<typeof tempStore> }> => {
  const store = tempStore()
  const peer = await joinSession(store, base, token, user)

  cleanup.push(() => peer.close())

  return { peer, store }
}

describe("peer sync", () => {
  it("gives a joining peer the whole session and keeps it current", async () => {
    const { engine, sessionId, server, base } = await host()

    await engine.submit(sessionId, { text: "before the peer joined", userId: "host" })

    const { peer, store } = await join(base, server.tokens.viewer, "ana")
    const events: Array<StoreEvent["type"]> = []

    store.subscribe((event) => events.push(event.type))
    await engine.submit(sessionId, { text: "while the peer watches", userId: "host" })
    await until(() => store.manifest(sessionId).length === engine.store.manifest(sessionId).length)

    // Sync is a union of immutable files: equal manifests means equal sessions.
    expect(store.manifest(sessionId)).toEqual(engine.store.manifest(sessionId))
    expect(loadSession(store, sessionId).turns.map((turn) => turn.output)).toEqual(["reply 1", "reply 3"])
    expect(events).toContain("span_open")
    expect(events).toContain("span_end")
    expect(peer.info.role).toBe("viewer")
    expect(peer.statusAvailable).toBe(true)
    // Nothing is left in flight on the peer once the host's spans have ended.
    expect(
      store.listTraceIds(sessionId).flatMap((traceId) => store.readTrace(sessionId, traceId).open),
    ).toEqual([])
  })

  it("lets a driver submit a prompt that the host runs under the driver's name", async () => {
    const { engine, sessionId, server, base } = await host()
    const { peer, store } = await join(base, server.tokens.driver, "ana")

    expect(await peer.prompt("from the peer")).toBeUndefined()
    await until(() => loadSession(store, sessionId).head?.state === "complete")

    const turn = loadSession(engine.store, sessionId).head

    expect(turn?.user_id).toBe("ana")
    expect(turn?.input).toBe("from the peer")
    expect(loadSession(store, sessionId).head?.output).toBe("reply 1")
    expect(engine.store.listInbox(sessionId)).toHaveLength(1)
  })

  it("refuses prompts from viewers and connections without a token", async () => {
    const { server, base } = await host()
    const { peer } = await join(base, server.tokens.viewer, "eve")

    expect(await peer.prompt("let me in")).toContain("403")
    await expect(joinSession(tempStore(), base, "wrong-token", "eve")).rejects.toThrow("401")
  })

  it("shares all senders' pending messages with both roles and honors explicit queue mode", async () => {
    const { engine, sessionId, server, base } = await host(1500)
    const { peer } = await join(base, server.tokens.driver, "ana")
    const { peer: viewer } = await join(base, server.tokens.viewer, "eve")
    const running = engine.submit(sessionId, { text: "working", userId: "host" })

    await until(() => engine.steerable(sessionId))
    await peer.prompt("change direction")
    await peer.prompt("next turn", "queue")
    engine.queue(sessionId, { text: "host queued", userId: "host" })
    expect(pendingInbox(engine.store, sessionId).map((entry) => entry.steers)).toEqual([
      true,
      undefined,
      undefined,
    ])
    await until(() => viewer.state().waiting.length === 3 && peer.state().waiting.length === 3)
    expect(viewer.state()).toEqual(peer.state())
    expect(viewer.state().waiting.map((entry) => entry.user_id)).toEqual(["ana", "ana", "host"])
    expect(viewer.state().steerable).toBe(true)
    expect(await viewer.prompt("forbidden", "queue")).toContain("403")
    await running
    await engine.settled(sessionId)
    await until(() => viewer.state().waiting.length === 0)
    expect(viewer.state().waiting).toEqual([])
  })

  it("refreshes child task approval status for drivers and late-joining viewers without parent events", async () => {
    const { engine, sessionId, server, base } = await host()
    const { peer } = await join(base, server.tokens.driver, "ana")

    const task = engine.tasks.delegate(
      {
        sessionId,
        cwd: engine.store.readHeader(sessionId)!.cwd,
        userId: "host",
        span: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
      },
      { title: "Child progress", prompt: "work", model: "scripted/scripted", isolation: "shared" },
    )

    cleanup.push(() => engine.tasks.cancel(task))
    const { peer: viewer } = await join(base, server.tokens.viewer, "eve")

    expect(viewer.state().work).toMatchObject([{ kind: "task", id: task.id, title: "Child progress" }])

    const tool: SpanFile = {
      name: "bash",
      context: { trace_id: "c".repeat(32), span_id: "d".repeat(16) },
      parent_id: "e".repeat(16),
      span_kind: "SPAN_KIND_INTERNAL",
      start_time: new Date().toISOString(),
      end_time: null,
      status_code: "UNSET",
      status_message: "",
      events: [],
      attributes: {
        [OI.SPAN_KIND]: "TOOL",
        [OI.SESSION_ID]: task.header.id,
        [OI.METADATA]: writeMetadata(undefined, { awaiting_approval: true }),
      },
    }

    engine.store.mirrorOpen(task.header.id, tool)

    const abort = new AbortController()

    cleanup.push(() => abort.abort())

    const decision = engine.tasks.approvals.ask(
      task.header.id,
      {
        tool: "bash",
        input: { command: "echo approved" },
        trace_id: "t",
        span_id: "approval",
        user_id: "host",
        prompt: "work",
        cwd: task.header.cwd,
      },
      abort.signal,
    )

    await until(() => viewer.state().work[0]?.waiting === true && peer.state().work[0]?.waiting === true)
    expect(viewer.state().work[0]?.waiting).toBe(true)
    expect(peer.state().work[0]?.waiting).toBe(true)
    engine.tasks.approvals.answer(task.header.id, "approval", "allow")
    expect(await decision).toBe("allow")
    engine.tasks.cancel(task)
    await until(() => viewer.state().work.length === 0 && peer.state().work.length === 0)
    expect(viewer.state().work).toEqual([])
    expect(peer.state().work).toEqual([])
  })

  it("snapshots existing tasks and streams newly started tasks equally to both roles", async () => {
    const { engine, sessionId, server, base } = await host()

    const delegate = (title: string) => {
      const task = engine.tasks.delegate(
        {
          sessionId,
          cwd: engine.store.readHeader(sessionId)!.cwd,
          userId: "host",
          span: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
        },
        { title, prompt: "work", model: "scripted/scripted", isolation: "shared" },
      )

      cleanup.push(() => engine.tasks.cancel(task))

      return task
    }

    const existing = delegate("Already running")
    const { peer: driver } = await join(base, server.tokens.driver, "ana")
    const { peer: viewer } = await join(base, server.tokens.viewer, "eve")

    for (const peer of [driver, viewer]) {
      expect(peer.state().work).toMatchObject([{ kind: "task", id: existing.id, title: "Already running" }])
    }

    const started = delegate("Started after joining")

    await until(() => driver.state().work.length === 2 && viewer.state().work.length === 2)

    for (const peer of [driver, viewer]) {
      expect(peer.state().work.map((work) => work.id)).toEqual([existing.id, started.id])
      expect(peer.state().work).toMatchObject([
        {
          kind: "task",
          title: "Already running",
          waiting: false,
          status: expect.stringMatching(/^running for /),
        },
        {
          kind: "task",
          title: "Started after joining",
          waiting: false,
          status: expect.stringMatching(/^running for /),
        },
      ])
    }

    expect(await viewer.prompt("cannot control tasks")).toContain("403")

    for (const route of ["/v1/task/cancel", "/v1/approval"]) {
      for (const token of [server.tokens.driver, server.tokens.viewer]) {
        const response = await fetch(`${base}${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })

        expect(response.status).toBe(404)
      }
    }
  })

  it("joins a legacy host without status snapshots for both roles", async () => {
    const store = tempStore()
    const header = store.createSession("/tmp")
    const followers = new Set<http.ServerResponse>()

    const server = http.createServer((request, response) => {
      const role = request.headers.authorization === "Bearer driver" ? "driver" : "viewer"

      response.setHeader("content-type", "application/json")

      if (request.url === "/v1/session")
        return void response.end(JSON.stringify({ header, role, host: "old host" }))

      if (request.url === "/v1/manifest")
        return void response.end(JSON.stringify({ paths: ["session.json"], open: [] }))

      if (request.url?.startsWith("/v1/file")) return void response.end(JSON.stringify(header))

      if (request.url === "/v1/events") {
        response.setHeader("content-type", "text/event-stream")
        response.write(": connected\n\n")
        followers.add(response)
        request.on("close", () => followers.delete(response))

        return
      }

      response.statusCode = role === "viewer" ? 403 : 202
      response.end("{}")
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()

    // SAFETY: this server listens on a TCP port, not a named pipe.
    const port = (address as AddressInfo).port

    cleanup.push(async () => {
      for (const follower of followers) follower.end()

      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    for (const role of ["driver", "viewer"]) {
      const { peer, store: copy } = await join(`http://127.0.0.1:${port}`, role, role)

      expect(copy.readHeader(header.id)).toEqual(header)
      expect(peer.statusAvailable).toBe(false)
      expect(peer.state().work).toEqual([])
      expect(await peer.prompt("hello")).toBe(
        role === "viewer" ? "The host rejected the prompt (HTTP 403)." : undefined,
      )
    }
  })

  it.each([
    { route: "/v1/session", status: 200, body: "{}", error: "invalid session description" },
    { route: "/v1/session", status: 200, body: "not json", error: "invalid session description" },
    { route: "/v1/manifest", status: 200, body: "{}", error: "invalid session manifest" },
    { route: "/v1/manifest", status: 503, body: "{}", error: "HTTP 503" },
    {
      route: "/v1/manifest",
      status: 200,
      body: '{"paths":[],"open":[],"state":{}}',
      error: "invalid session manifest",
    },
    { route: "/v1/events", status: 403, body: "{}", error: "event stream (HTTP 403)" },
  ])("explains invalid host responses: $route $status $body", async ({ route, status, body, error }) => {
    const header = tempStore().createSession("/tmp")
    const followers = new Set<http.ServerResponse>()

    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json")

      if (request.url === route) {
        response.statusCode = status
        response.end(body)

        return
      }

      if (request.url === "/v1/session")
        return void response.end(JSON.stringify({ header, role: "viewer", host: "host" }))

      response.setHeader("content-type", "text/event-stream")
      response.write(": connected\n\n")
      followers.add(response)
      request.on("close", () => followers.delete(response))
    })

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    // SAFETY: this server listens on a TCP port, never a named pipe.
    const port = (server.address() as AddressInfo).port

    cleanup.push(async () => {
      for (const follower of followers) follower.end()

      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    await expect(joinSession(tempStore(), `http://127.0.0.1:${port}`, "token", "eve")).rejects.toThrow(error)
    await until(() => followers.size === 0)
    expect(followers.size).toBe(0)
  })

  it("ends a silent transport instead of leaving a joined chat open forever", async () => {
    const { server, base } = await host()
    const fetch = globalThis.fetch

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (input !== `${base}/v1/events`) return fetch(input, init)

      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"))
        },
      })

      return Promise.resolve(new Response(stalled))
    })

    try {
      const { peer: driver } = await join(base, server.tokens.driver, "ana")
      const { peer: viewer } = await join(base, server.tokens.viewer, "eve")

      expect(driver.info.role).toBe("driver")
      expect(viewer.info.role).toBe("viewer")
      await expect(
        Promise.race([
          Promise.all([driver.closed, viewer.closed]).then(() => "closed"),
          new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 12_000)),
        ]),
      ).resolves.toBe("closed")
    } finally {
      vi.restoreAllMocks()
    }
  }, 15_000)

  it("returns a prompt error after the connection is closed rather than rejecting", async () => {
    const { server, base } = await host()
    const { peer } = await join(base, server.tokens.driver, "ana")

    await server.close()
    await peer.closed
    await expect(peer.prompt("too late")).resolves.toMatch(/host disconnected/i)
  })

  it("cancels a pending prompt when the event stream closes", async () => {
    const { server, base } = await host()
    const { peer } = await join(base, server.tokens.driver, "ana")
    const fetch = globalThis.fetch

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (input !== `${base}/v1/prompt`) return fetch(input, init)

      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("disconnected")), { once: true })
      })
    })

    try {
      const pending = peer.prompt("in flight")

      await server.close()
      await peer.closed
      await expect(pending).resolves.toMatch(/host disconnected/i)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("stops sharing without waiting for an unfinished HTTP request", async () => {
    const { server } = await host()
    const socket = createConnection(server.port, "127.0.0.1")

    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve))
      socket.write(
        `POST /v1/prompt HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${server.tokens.driver}\r\nContent-Length: 100\r\n\r\n{`,
      )
      // Let the server enter its body reader before requesting shutdown.
      await new Promise((resolve) => setTimeout(resolve, 20))
      await expect(
        Promise.race([
          server.close().then(() => "closed"),
          new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 500)),
        ]),
      ).resolves.toBe("closed")
    } finally {
      socket.destroy()
    }
  })

  it("round-trips share links", () => {
    const link = { address: "tcAbC_d-9", port: 4312, token: "tok-en_1" }

    expect(parseShareLink(formatShareLink(link))).toEqual(link)
    expect(parseShareLink(formatShareLink({ ...link, address: "http://127.0.0.1" }))?.address).toBe(
      "http://127.0.0.1",
    )
    expect(parseShareLink("nonsense")).toBeUndefined()
  })
})
