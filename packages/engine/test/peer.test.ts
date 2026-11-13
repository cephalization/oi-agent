import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import { loadSession } from "../src/fold.ts"
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

const host = async (): Promise<{ engine: Engine; sessionId: string; server: PeerServer; base: string }> => {
  const store = tempStore()

  const engine = new Engine({
    store,
    config: loadConfig(store.home, { OI_AGENT_USER: "host" }),
    model: scriptedModel((call) => say(`reply ${call.messages.length}`), 30),
    approvals: "allow",
  })

  const sessionId = engine.createSession(fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-peer-"))).id
  const server = await servePeers(engine, sessionId)

  cleanup.push(() => server.close())

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

  it("round-trips share links", () => {
    const link = { address: "tcAbC_d-9", port: 4312, token: "tok-en_1" }

    expect(parseShareLink(formatShareLink(link))).toEqual(link)
    expect(parseShareLink(formatShareLink({ ...link, address: "http://127.0.0.1" }))?.address).toBe(
      "http://127.0.0.1",
    )
    expect(parseShareLink("nonsense")).toBeUndefined()
  })
})
