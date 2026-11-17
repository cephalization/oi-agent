import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { openaiChat } from "../src/dialects/index.ts"
import { Engine } from "../src/engine.ts"
import { contextFor, loadSession, pendingInbox, renderSteer } from "../src/fold.ts"
import { readMetadata } from "../src/format.ts"
import { type ModelCall, scriptedModel } from "../src/model.ts"
import { Store } from "../src/store.ts"
import type { Json } from "../src/wire.ts"
import { tempStore } from "./helpers.ts"

const say = (text: string): Json => ({
  model: "scripted",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
})

const bash = (command: string): Json => ({
  model: "scripted",
  content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command } }],
  stop_reason: "tool_use",
})

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000

  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")

    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface Setup {
  readonly store: Store
  readonly engine: Engine
  readonly sessionId: string
  /** What the model was sent, call by call. */
  readonly calls: Array<ModelCall>
}

const setup = (respond: (call: ModelCall, step: number) => Json, delayMs: number = 0): Setup => {
  const store = tempStore()
  const calls: Array<ModelCall> = []

  const engine = new Engine({
    store,
    config: loadConfig({ OI_AGENT_CONFIG_DIR: path.join(store.home, "config"), OI_AGENT_HOME: store.home }),
    approvals: "allow",
    model: scriptedModel((call, step) => {
      calls.push(call)

      return respond(call, step)
    }, delayMs),
  })

  const sessionId = engine.createSession(fs.mkdtempSync(path.join(os.tmpdir(), "oi-steer-"))).id

  engine.attend(sessionId)

  return { store, engine, sessionId, calls }
}

const sent = (call: ModelCall | undefined): string => JSON.stringify(call?.messages ?? [])

describe("steering a running turn", () => {
  it("gives the message to the same turn, after the tool results of the call in flight", async () => {
    const s = setup((_call, step) => (step === 0 ? bash("sleep 0.4; echo slept") : say("Using pnpm now.")))
    const turn = s.engine.submit(s.sessionId, { text: "install it with npm", userId: "tony" })

    // The model has asked for the command, which is now running.
    await until(() => s.calls.length === 1)

    const entry = s.engine.steer(s.sessionId, { text: "use pnpm, not npm", userId: "tony" })

    expect(entry?.steers).toBe(true)
    expect((await turn).ok).toBe(true)
    await s.engine.settled(s.sessionId)

    // One turn: the message did not become a prompt of its own.
    const turns = loadSession(s.store, s.sessionId).turns

    expect(turns).toHaveLength(1)
    expect(turns[0]?.output).toBe("Using pnpm now.")
    expect(s.calls).toHaveLength(2)

    // The second request has the tool result, then what was said, as the model reads it.
    const second = sent(s.calls[1])

    expect(second).toContain("slept")
    expect(second).toContain(
      JSON.stringify(renderSteer({ user_id: "tony", text: "use pnpm, not npm" })).slice(1, -1),
    )
    expect(second.indexOf("slept")).toBeLessThan(second.indexOf("use pnpm, not npm"))

    // The root span says what was said and after which call, and that is what consumed the inbox entry.
    const [steered] = readMetadata(turns[0]!.root).steered ?? []

    expect(steered).toMatchObject({ inbox_id: entry?.id, user_id: "tony", text: "use pnpm, not npm" })
    expect(pendingInbox(s.store, s.sessionId)).toEqual([])
    s.engine.close()
  })

  it("keeps the turn going when the model had just finished without it", async () => {
    const s = setup((_call, step) => say(step === 0 ? "All done." : "Done, with tests this time."), 300)
    const turn = s.engine.submit(s.sessionId, { text: "write the function", userId: "tony" })

    await until(() => s.calls.length === 1)
    s.engine.steer(s.sessionId, { text: "also add tests", userId: "tony" })
    await turn
    await s.engine.settled(s.sessionId)

    const turns = loadSession(s.store, s.sessionId).turns

    expect(turns).toHaveLength(1)
    expect(turns[0]?.output).toBe("Done, with tests this time.")

    // The model's first answer stands in the conversation, followed by what was said.
    const second = sent(s.calls[1])

    expect(second).toContain("All done.")
    expect(second.indexOf("All done.")).toBeLessThan(second.indexOf("also add tests"))
    s.engine.close()
  })

  it("rebuilds the same request from disk in another process, and in another dialect", async () => {
    const s = setup((_call, step) => (step === 0 ? bash("echo one") : say("ok")), 150)
    const turn = s.engine.submit(s.sessionId, { text: "go", userId: "tony" })

    await until(() => s.calls.length === 1)
    s.engine.steer(s.sessionId, { text: "remember the changelog", userId: "tony" })
    await turn
    await s.engine.settled(s.sessionId)

    const traceId = loadSession(s.store, s.sessionId).turns[0]!.trace_id
    const reader = new Store(s.store.home)

    // What a next turn starts from: the whole conversation, with the message where it was said.
    const native = JSON.stringify(contextFor(reader, s.sessionId, traceId))
    const chat = JSON.stringify(contextFor(reader, s.sessionId, traceId, openaiChat))

    for (const context of [native, chat]) {
      expect(context.split("remember the changelog")).toHaveLength(2)
      expect(context.indexOf("one")).toBeLessThan(context.indexOf("remember the changelog"))
    }

    s.engine.close()
  })

  it("does nothing when no turn is running, so the caller can start one", () => {
    const s = setup(() => say("unused"))

    expect(s.engine.busy(s.sessionId)).toBe(false)
    expect(s.engine.steer(s.sessionId, { text: "hello", userId: "tony" })).toBeUndefined()
    expect(s.store.listInbox(s.sessionId)).toEqual([])
    s.engine.close()
  })

  it("runs a message its turn never read as the next turn, without losing or repeating it", async () => {
    const s = setup((call) => say(sent(call).includes("too late") ? "Got the late one." : "First."))

    await s.engine.submit(s.sessionId, { text: "first", userId: "tony" })
    await s.engine.settled(s.sessionId)

    // Written as its turn was ending: on disk, addressed to a turn that is gone.
    s.store.writeInbox(s.sessionId, { user_id: "tony", text: "too late", steers: true })
    s.engine.drainInbox(s.sessionId)
    s.engine.drainInbox(s.sessionId)
    await s.engine.settled(s.sessionId)

    const turns = loadSession(s.store, s.sessionId).turns

    expect(turns.map((turn) => turn.input)).toEqual(["first", "too late"])
    expect(turns[1]?.output).toBe("Got the late one.")
    expect(readMetadata(turns[1]!.root).steered).toBeUndefined()
    expect(pendingInbox(s.store, s.sessionId)).toEqual([])
    s.engine.close()
  })
})

describe("queueing for the next turn", () => {
  it("leaves the running turn alone and runs what was queued after it, in order", async () => {
    const s = setup((call, step) => (step === 0 ? bash("sleep 0.3; echo slept") : say(`reply ${step}`)))
    const turn = s.engine.submit(s.sessionId, { text: "first", userId: "tony" })

    await until(() => s.engine.busy(s.sessionId))
    s.engine.queue(s.sessionId, { text: "second", userId: "tony" })
    s.engine.queue(s.sessionId, { text: "third", userId: "tony" })

    // Visible as waiting, from the files alone, while the first turn runs.
    expect(pendingInbox(new Store(s.store.home), s.sessionId).map((entry) => entry.text)).toEqual([
      "second",
      "third",
    ])

    await turn
    await s.engine.settled(s.sessionId)

    const turns = loadSession(s.store, s.sessionId).turns

    expect(turns.map((entry) => entry.input)).toEqual(["first", "second", "third"])
    expect(readMetadata(turns[0]!.root).steered).toBeUndefined()

    // The first turn's requests never saw them.
    expect(sent(s.calls[1])).not.toContain("second")
    expect(pendingInbox(s.store, s.sessionId)).toEqual([])
    s.engine.close()
  })

  it("starts at once when nothing is running, and survives the process that queued it", async () => {
    const s = setup(() => say("now"))

    s.engine.queue(s.sessionId, { text: "right away", userId: "tony" })
    await s.engine.settled(s.sessionId)
    expect(loadSession(s.store, s.sessionId).turns.map((turn) => turn.input)).toEqual(["right away"])
    s.engine.close()

    // Queued, and then the process went away before running it.
    s.store.writeInbox(s.sessionId, { user_id: "tony", text: "after the restart" })

    const later = new Engine({
      store: new Store(s.store.home),
      config: loadConfig({
        OI_AGENT_CONFIG_DIR: path.join(s.store.home, "config"),
        OI_AGENT_HOME: s.store.home,
      }),
      approvals: "allow",
      model: scriptedModel(() => say("later")),
    })

    later.attend(s.sessionId)
    await later.settled(s.sessionId)
    expect(loadSession(s.store, s.sessionId).turns.map((turn) => turn.input)).toEqual([
      "right away",
      "after the restart",
    ])
    later.close()
  })
})
