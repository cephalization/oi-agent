import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import {
  attachmentsFrom,
  imageTypeOf,
  intact,
  isProblem,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PROMPT,
} from "../src/attachments.ts"
import { loadConfig } from "../src/config.ts"
import { anthropicMessages, openaiChat, openaiResponses, translate } from "../src/dialects/index.ts"
import { Engine } from "../src/engine.ts"
import { contextFor, loadSession, pendingInbox } from "../src/fold.ts"
import { OI, printAttachment, readMetadata } from "../src/format.ts"
import { type ModelCall, scriptedModel } from "../src/model.ts"
import { turnRecord } from "../src/evals.ts"
import type { Json } from "../src/wire.ts"
import { png, tempStore } from "./helpers.ts"

const say = (text: string): Json => ({
  model: "scripted",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
})

const bash = (id: string, command: string): Json => ({
  model: "scripted",
  content: [{ type: "tool_use", id, name: "bash", input: { command } }],
  stop_reason: "tool_use",
})

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000

  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")

    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const setup = (respond: (call: ModelCall, step: number) => Json) => {
  const store = tempStore()
  const calls: Array<ModelCall> = []

  const engine = new Engine({
    store,
    config: loadConfig({ OI_AGENT_CONFIG_DIR: path.join(store.home, "config"), OI_AGENT_HOME: store.home }),
    approvals: "allow",
    model: scriptedModel((call, step) => {
      calls.push(call)

      return respond(call, step)
    }),
  })

  const sessionId = engine.createSession(fs.mkdtempSync(path.join(os.tmpdir(), "oi-attach-"))).id

  engine.attend(sessionId)

  return { store, engine, sessionId, calls }
}

/** The references `attach` gives for these images; fails the test when it refuses them. */
const attached = (s: ReturnType<typeof setup>, images: ReadonlyArray<{ name: string; bytes: Buffer }>) => {
  const refs = s.engine.attach(s.sessionId, images)

  if (isProblem(refs)) throw new Error(refs)

  return refs
}

describe("attaching images", () => {
  it("reads the format from the bytes, not from the name", () => {
    expect(imageTypeOf(png("a"))).toBe("image/png")
    expect(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(imageTypeOf(Buffer.from("GIF89a"))).toBe("image/gif")
    expect(imageTypeOf(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp")
    expect(imageTypeOf(Buffer.from("#!/bin/sh"))).toBeUndefined()

    expect(attachmentsFrom([{ name: "notes.png", bytes: Buffer.from("just text") }])).toBe(
      "notes.png is not a PNG, JPEG, GIF or WebP image.",
    )
  })

  it("refuses too many, too large, and names with a path in them", () => {
    const many = Array.from({ length: MAX_IMAGES_PER_PROMPT + 1 }, (_, index) => ({
      name: `${index}.png`,
      bytes: png(String(index)),
    }))

    expect(attachmentsFrom(many)).toMatch(/at most 10 images/)
    expect(
      attachmentsFrom([{ name: "huge.png", bytes: Buffer.concat([png(""), Buffer.alloc(MAX_IMAGE_BYTES)]) }]),
    ).toMatch(/huge\.png is 5\.2 MB; an image can be at most 5\.2 MB/)

    const files = attachmentsFrom([{ name: "/Users/ana/Desktop/shot one.png", bytes: png("a") }])

    expect(isProblem(files) ? [] : files.map((file) => file.name)).toEqual(["shot one.png"])
  })

  it("stores an image once, by its content, as a file that syncs", () => {
    const s = setup(() => say("ok"))
    const [first] = attached(s, [{ name: "a.png", bytes: png("same") }])
    const [again] = attached(s, [{ name: "renamed.png", bytes: png("same") }])

    expect(again?.id).toBe(first?.id)
    expect(again?.name).toBe("renamed.png")

    const rel = `attachments/${first?.id}.json`

    expect(s.store.manifest(s.sessionId)).toContain(rel)

    // Another machine takes the file as it is, and nothing that does not match its name.
    const other = tempStore()
    const contents = s.store.readSyncFile(s.sessionId, rel) ?? ""

    expect(other.importFile(s.sessionId, `attachments/${"0".repeat(64)}.json`, contents)).toBe(false)
    expect(other.importFile(s.sessionId, rel, contents.replace('"bytes": 12', '"bytes": 13'))).toBe(false)
    expect(other.importFile(s.sessionId, rel, contents)).toBe(true)
    expect(other.readAttachment(s.sessionId, first?.id ?? "")?.data).toBe(png("same").toString("base64"))

    const file = s.store.readAttachment(s.sessionId, first?.id ?? "")

    expect(file !== undefined && intact(file)).toBe(true)
    expect(file !== undefined && intact({ ...file, data: png("other").toString("base64") })).toBe(false)
    expect(printAttachment(file!)).toBe(contents)
    s.engine.close()
  })
})

describe("a prompt with images", () => {
  it("sends the images with the words, records references on the root span, and replays from disk", async () => {
    const s = setup(() => say("a red square"))

    const refs = attached(s, [
      { name: "one.png", bytes: png("one") },
      { name: "two.png", bytes: png("two") },
    ])

    const outcome = await s.engine.submit(s.sessionId, {
      text: "what are these?",
      userId: "tony",
      attachments: refs,
    })

    expect(outcome.ok).toBe(true)

    expect(s.calls[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png("one").toString("base64") },
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png("two").toString("base64") },
          },
          { type: "text", text: "what are these?" },
        ],
      },
    ])

    const turn = loadSession(s.store, s.sessionId).head

    expect(readMetadata(turn!.root).attachments).toEqual(refs)
    // The span holds references; the bytes are in the attachment files and in the stored request.
    expect(JSON.stringify(turn?.root)).not.toContain(png("one").toString("base64"))

    // OpenInference sees the message as contents: the images, then the text.
    const call = s.store.readTrace(s.sessionId, turn!.trace_id).ended.find((span) => span.name !== "turn")
    const contents = `${OI.LLM_INPUT_MESSAGES}.1.message.contents`

    expect(call?.attributes[`${contents}.0.message_content.type`]).toBe("image")
    expect(call?.attributes[`${contents}.0.message_content.image.image.url`]).toBe(
      `data:image/png;base64,${png("one").toString("base64")}`,
    )
    expect(call?.attributes[`${contents}.2.message_content.text`]).toBe("what are these?")

    // The next turn's context is the stored request, replayed: the image is still in it.
    await s.engine.submit(s.sessionId, { text: "and again?", userId: "tony" })
    expect(JSON.stringify(s.calls[1]?.messages[0])).toContain(png("two").toString("base64"))

    // A judge is told there were images, by name.
    expect(turnRecord(s.store, s.sessionId, turn!.trace_id).transcript).toContain(
      "[user] what are these? [with images: one.png, two.png]",
    )
    s.engine.close()
  })

  it("can be nothing but images", async () => {
    const s = setup(() => say("blue"))

    await s.engine.submit(s.sessionId, {
      text: "",
      userId: "tony",
      attachments: attached(s, [{ name: "only.png", bytes: png("only") }]),
    })

    expect(s.calls[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png("only").toString("base64") },
          },
        ],
      },
    ])
    s.engine.close()
  })

  it("says so in words when this machine has the span but not the image", async () => {
    const s = setup(() => say("ok"))
    const refs = attached(s, [{ name: "gone.png", bytes: png("gone") }])

    fs.rmSync(path.join(s.store.home, "sessions", s.sessionId, "attachments"), { recursive: true })
    await s.engine.submit(s.sessionId, { text: "what is this?", userId: "tony", attachments: refs })

    expect(s.calls[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[The image gone.png was attached here, but its contents are not available on this machine.]",
          },
          { type: "text", text: "what is this?" },
        ],
      },
    ])
    s.engine.close()
  })

  it("keeps its images when it waits in the queue, and when it steers a running turn", async () => {
    const s = setup((_call, step) => {
      if (step === 0) return bash("call-1", "sleep 0.4; echo slept")

      return say(step === 1 ? "first done" : "second done")
    })

    const turn = s.engine.submit(s.sessionId, { text: "run it", userId: "tony" })

    await until(() => s.calls.length === 1)

    const steer = attached(s, [{ name: "steer.png", bytes: png("steer") }])
    const queue = attached(s, [{ name: "queue.png", bytes: png("queue") }])

    s.engine.steer(s.sessionId, { text: "like this", userId: "tony", attachments: steer })
    s.engine.queue(s.sessionId, { text: "then this", userId: "tony", attachments: queue })
    expect(pendingInbox(s.store, s.sessionId).map((entry) => entry.attachments)).toEqual([steer, queue])

    await turn
    await s.engine.settled(s.sessionId)

    const turns = loadSession(s.store, s.sessionId).turns

    expect(readMetadata(turns[0]!.root).steered?.[0]?.attachments).toEqual(steer)
    expect(readMetadata(turns[1]!.root).attachments).toEqual(queue)

    // The steering message reached the running turn with its image, after the tool result.
    const second = JSON.stringify(s.calls[1]?.messages)

    expect(second).toContain(png("steer").toString("base64"))
    expect(second.indexOf("slept")).toBeLessThan(second.indexOf(png("steer").toString("base64")))
    expect(second).not.toContain(png("queue").toString("base64"))
    expect(JSON.stringify(s.calls[2]?.messages)).toContain(png("queue").toString("base64"))

    // Rebuilt from disk by another process, the request is the same one.
    expect(contextFor(s.store, s.sessionId, turns[1]!.trace_id)).toEqual([
      ...(s.calls[2]?.messages ?? []),
      { role: "assistant", content: [{ type: "text", text: "second done" }] },
    ])
    s.engine.close()
  })
})

describe("images across providers", () => {
  const image = { media_type: "image/png" as const, data: png("x").toString("base64") }

  it("each dialect writes an image its own way and reads it back", () => {
    for (const dialect of [anthropicMessages, openaiResponses, openaiChat]) {
      const message = dialect.userMessage(["look"], [image])

      expect(dialect.toTranscript([message])).toEqual([{ role: "user", text: "look", images: [image] }])
    }

    expect(openaiResponses.userMessage(["look"], [image])).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: `data:image/png;base64,${image.data}` },
        { type: "input_text", text: "look" },
      ],
    })
    expect(openaiChat.userMessage(["look"], [image])).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
      ],
    })
    // Without images, every dialect writes what it always wrote.
    expect(anthropicMessages.userMessage(["look"])).toEqual({ role: "user", content: "look" })
    expect(openaiChat.userMessage(["a", "b"])).toEqual({ role: "user", content: "a\n\nb" })
  })

  it("an image survives a change of provider mid-conversation", () => {
    const anthropic = [anthropicMessages.userMessage(["look"], [image])]

    for (const dialect of [openaiResponses, openaiChat]) {
      const there = translate(anthropicMessages, dialect, anthropic)

      expect(JSON.stringify(there)).toContain(image.data)
      expect(translate(dialect, anthropicMessages, there)).toEqual(anthropic)
    }
  })
})
