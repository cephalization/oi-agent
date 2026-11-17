import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
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

  it("round-trips share links", () => {
    const link = { address: "tcAbC_d-9", port: 4312, token: "tok-en_1" }

    expect(parseShareLink(formatShareLink(link))).toEqual(link)
    expect(parseShareLink(formatShareLink({ ...link, address: "http://127.0.0.1" }))?.address).toBe(
      "http://127.0.0.1",
    )
    expect(parseShareLink("nonsense")).toBeUndefined()
  })
})
