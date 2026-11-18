/**
 * Images in a prompt (issue #79): dropped on the terminal, sent to the model
 * as images, kept in the session, and carried from a joiner to a host that
 * cannot read the joiner's files.
 *
 * A terminal has no drop event: dropping a file pastes its path, so each
 * scenario pastes paths as a terminal does. The images are squares of one
 * colour, which a model can only name by reading the pixels.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import {
  kindOf,
  MAX_IMAGE_BYTES,
  OI,
  parseShareLink,
  pendingInbox,
  readMetadata,
  Store,
  stringAttr,
} from "@oi-agent/engine"
import type { Schema } from "effect"
import { afterAll, describe, expect } from "vite-plus/test"
import { fakeChatModel, fakeTextOnlyModel, NO_IMAGES } from "../src/fakes.ts"
import { BLUE, RED, writeImage } from "../src/images.ts"
import { expectOk, MODELS, type Scenario, scenario } from "../src/scenario.ts"

const IDLE = /enter starts a new turn/
const SCREENSHOT = "Screenshot 2026-11-18 at 1.54.09\u202FPM.png"

const COLOURS =
  "What is the main colour of each image, in order? Reply with just the colour words, separated by a comma."

/** A directory in the sandbox that is not the project: where a person's screenshots would be. */
const desktop = (s: Scenario): string => path.join(s.sandbox.root, "desktop")

/** A path as a terminal pastes a dropped file: spaces escaped. */
const dropped = (file: string): string => file.replaceAll(" ", String.raw`\ `)

/** The request bodies of a turn's model calls, joined. */
const requests = (s: Scenario, session: string, traceId: string): string =>
  s.spans
    .trace(session, traceId)
    .filter((span) => kindOf(span) === "LLM")
    .map((span) => stringAttr(span, OI.INPUT_VALUE) ?? "")
    .join("\n")

const textOnly = await fakeTextOnlyModel()
const fixtureModel = await fakeChatModel("Got it.")

afterAll(() => Promise.all([textOnly.close(), fixtureModel.close()]))

describe("images in a prompt", () => {
  scenario(
    "an immediate Enter sends a synthetic macOS screenshot without a path in the prompt",
    {
      needs: ["rex"],
      model: "fixture/tiny",
      config: new Map<string, Schema.Json>([
        ["steering", "off"],
        [
          "providers",
          [
            {
              id: "fixture",
              name: "Fixture",
              kind: "openai-compatible",
              base_url: fixtureModel.url,
              models: [{ id: "tiny" }],
            },
          ],
        ],
      ]),
    },
    async (s) => {
      const screenshot = writeImage(path.join(desktop(s), "var", "folders", "fixture"), SCREENSHOT, RED)
      const oversized = writeImage(desktop(s), "oversized.png", RED)
      const term = await s.tui()

      fs.truncateSync(oversized, MAX_IMAGE_BYTES + 1)
      await term.waitFor(IDLE)
      await term.send(`Keep this draft\u001B[200~${dropped(oversized)}\u001B[201~\r`)
      await term.waitFor(/oversized\.png is .* an image can be at most/)
      await term.waitFor(/› Keep this draft/)
      await term.key("ctrl+u")

      // Enter is in the same PTY write as the paste terminator; there is no text draft.
      await term.send(`\u001B[200~${dropped(screenshot)}\u001B[201~\r`)

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])
      const [turn] = await s.spans.settledTurns(session, 1)
      const sent = requests(s, session, turn!.trace_id)

      expect(turn?.state).toBe("complete")
      expect(readMetadata(turn!.root).attachments?.map((ref) => ref.name)).toEqual([SCREENSHOT])
      expect(sent).toContain(RED.toString("base64"))
      expect(sent).not.toContain(desktop(s))
      expect(sent).not.toContain("Keep this draft")
      expect(s.spans.turns(session)).toHaveLength(1)
    },
  )

  scenario(
    "dropped images are listed, can be removed, go to the model with the prompt, and outlive their files",
    { needs: ["rex"], approvals: "allow", config: new Map([["steering", "off"]]) },
    async (s) => {
      const red = writeImage(desktop(s), "red square.png", RED)
      const blue = writeImage(desktop(s), "blue.png", BLUE)
      const term = await s.tui()

      await term.waitFor(IDLE)

      // Two files dropped at once: both attached, and no path typed into the prompt.
      await term.paste(`${dropped(red)} ${dropped(blue)}`)

      const listed = await term.waitFor(/2 images attached/)

      expect(listed).toMatch(/▣ red square\.png \([\d.]+ kB\) · blue\.png \([\d.]+ kB\)/)
      expect(listed).not.toContain(desktop(s))

      // Backspace at the start of the line takes the last one back off; dropping it again restores it.
      await term.key("backspace")

      const one = await term.waitFor(/1 image attached/)

      expect(one.split("\n").findLast((line) => line.includes("▣"))).not.toContain("blue.png")
      await term.paste(`'${blue}'`)
      await term.waitFor(/2 images attached/)

      // Something pasted that is not an image file is text, as it always was.
      await term.paste("not a file")
      await term.waitFor(/› not a file/)
      await term.key("ctrl+u")
      await term.line(COLOURS)

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])
      const [turn] = await s.spans.settledTurns(session, 1)

      expect(turn?.state).toBe("complete")
      expect(turn?.output?.toLowerCase()).toMatch(/red\W+blue/)

      // The turn's span refers to the images; the request carried them, and not their paths.
      expect(readMetadata(turn!.root).attachments?.map((ref) => [ref.name, ref.media_type])).toEqual([
        ["red square.png", "image/png"],
        ["blue.png", "image/png"],
      ])

      const sent = requests(s, session, turn!.trace_id)

      expect(sent).toContain(RED.toString("base64"))
      expect(sent).toContain(BLUE.toString("base64"))
      expect(sent).not.toContain("red square.png")

      // The transcript shows what went with the words, and nothing is left attached.
      const after = await term.waitFor(/▣ blue\.png \([\d.]+ kB\)\n[\s\S]*enter starts a new turn/)

      expect(after).not.toMatch(/images? attached/)

      // The files are gone and so is this process: the session still has the images.
      fs.rmSync(desktop(s), { recursive: true })
      await term.close()
      expectOk(await s.run(["run", "-s", session, "Which colour was the second image? Reply with one word."]))

      const turns = await s.spans.settledTurns(session, 2)

      expect(turns[1]?.output?.toLowerCase()).toContain("blue")
    },
  )

  scenario(
    "an image sent to one provider is still there after switching to another",
    { needs: ["second-model"], config: new Map([["steering", "off"]]) },
    async (s) => {
      const red = writeImage(desktop(s), "red.png", RED)
      const blue = writeImage(desktop(s), "blue.png", BLUE)

      expectOk(await s.run(["run", "--image", red, "--image", blue, COLOURS]))

      const session = s.spans.onlySession()

      fs.rmSync(desktop(s), { recursive: true })

      // Another provider, another wire format: the conversation is translated, images included.
      expectOk(
        await s.run([
          "run",
          "-s",
          session,
          "-m",
          MODELS.second,
          "Look at the two images again. Which colour is the second one? Reply with one word.",
        ]),
      )

      const turns = await s.spans.settledTurns(session, 2)

      expect(turns[0]?.output?.toLowerCase()).toMatch(/red\W+blue/)
      expect(turns[1]?.output?.toLowerCase()).toContain("blue")

      const [first, second] = turns.map((turn) =>
        s.spans.trace(session, turn.trace_id).find((span) => kindOf(span) === "LLM"),
      )

      expect(readMetadata(first!).api).not.toBe(readMetadata(second!).api)
      expect(stringAttr(second!, OI.INPUT_VALUE)).toContain(BLUE.toString("base64"))

      // OpenInference readers get the image as message contents, whichever provider was sent it.
      for (const call of [first, second]) {
        const urls = Object.entries(call!.attributes).filter(([key]) =>
          key.endsWith("message_content.image.image.url"),
        )

        expect(urls.map(([, value]) => value)).toEqual([
          `data:image/png;base64,${RED.toString("base64")}`,
          `data:image/png;base64,${BLUE.toString("base64")}`,
        ])
      }
    },
  )

  scenario(
    "an image waits in the queue with its prompt, and comes back with it when the prompt is withdrawn",
    { needs: ["rex"], approvals: "allow", config: new Map([["steering", "off"]]) },
    async (s) => {
      const blue = writeImage(desktop(s), "blue.png", BLUE)
      const term = await s.tui()

      await term.waitFor(IDLE)
      await term.line(
        "Call the bash tool now with exactly the command `until [ -f go ]; do sleep 0.2; done; echo gate-opened` and no other arguments. Then reply with just: done.",
      )

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.waitFor("the bash call to be in flight", () =>
        s.spans.open(session).find((span) => kindOf(span) === "TOOL"),
      )
      await term.key("ctrl+t")
      await term.waitFor(/enter queues for the next turn/)
      await term.paste(dropped(blue))
      await term.waitFor(/1 image attached/)
      await term.line("What is the main colour of this image? Reply with one word.")

      // Waiting, with its image, on disk.
      await term.waitFor(/⧗ queued for the next turn: What is the main colour[\s\S]*▣ 1 image/)
      expect(pendingInbox(s.spans.store, session).map((entry) => entry.attachments?.length)).toEqual([1])

      // Escape stops the turn and takes the queued prompt back: text in the editor, image attached again.
      await term.key("escape")
      await term.waitFor(/1 image attached[\s\S]*› What is the main colour of this image/)
      expect(pendingInbox(s.spans.store, session)).toEqual([])
      await s.spans.settledTurns(session, 1)
      await term.key("enter")

      const turns = await s.spans.settledTurns(session, 2)

      expect(readMetadata(turns[1]!.root).attachments?.map((ref) => ref.name)).toEqual(["blue.png"])
      expect(turns[1]?.output?.toLowerCase()).toContain("blue")
    },
  )

  scenario(
    "a driver's images reach a host that cannot read the driver's files, a viewer sees them, and a view link cannot send any",
    { needs: ["rex"], approvals: "allow", config: new Map([["steering", "off"]]) },
    async (s) => {
      const host = await s.tui()

      await host.waitFor(IDLE)
      await host.line("/share local")

      const screen = await host.waitFor(/View \(read-only\)/)
      const links = [...screen.matchAll(/oi join (oi-share:\S+)/g)].map((match) => match[1]!)

      expect(links).toHaveLength(2)

      const homes = {
        driver: path.join(s.sandbox.root, "driver"),
        viewer: path.join(s.sandbox.root, "viewer"),
      }

      const driver = await s.tui(["join", links[0]!], {
        env: new Map([
          ["OI_AGENT_HOME", homes.driver],
          ["OI_AGENT_USER", "ana"],
        ]),
      })

      const viewer = await s.tui(["join", links[1]!], {
        env: new Map([
          ["OI_AGENT_HOME", homes.viewer],
          ["OI_AGENT_USER", "eve"],
        ]),
      })

      await viewer.waitFor(/view only/)
      await driver.waitFor(/enter starts a new turn on the host/)

      // The driver attaches two images, and then the files are deleted: from here on they exist
      // only in the driver's process, so the host can only have what was sent to it.
      const red = writeImage(desktop(s), SCREENSHOT, RED)
      const blue = writeImage(desktop(s), "blue.png", BLUE)

      await driver.paste(`${dropped(red)} ${dropped(blue)}`)
      await driver.waitFor(/2 images attached/)
      fs.rmSync(desktop(s), { recursive: true })
      await driver.line(COLOURS)

      const session = s.spans.onlySession()
      const [turn] = await s.spans.settledTurns(session, 1)
      const refs = readMetadata(turn!.root).attachments ?? []

      expect(turn?.user_id).toBe("ana")
      expect(refs.map((ref) => ref.name)).toEqual([SCREENSHOT, "blue.png"])
      expect(turn?.output?.toLowerCase()).toMatch(/red\W+blue/)
      expect(requests(s, session, turn!.trace_id)).toContain(RED.toString("base64"))

      // Everyone watching sees the prompt with what was attached to it, and holds the images themselves.
      for (const term of [host, driver, viewer])
        await term.waitFor(/▣ Screenshot 2026-11-18 at 1\.54\.09\u202FPM\.png[\s\S]*▣ blue\.png/)

      for (const home of [homes.driver, homes.viewer]) {
        const copy = await s.spans.waitFor("the images to be synced", () => {
          const store = new Store(home)

          return refs.every((ref) => store.readAttachment(session, ref.id) !== undefined) ? store : undefined
        })

        expect(refs.map((ref) => copy.readAttachment(session, ref.id)?.data)).toEqual([
          RED.toString("base64"),
          BLUE.toString("base64"),
        ])
        expect(copy.manifest(session).filter((rel) => rel.startsWith("attachments/"))).toHaveLength(2)
      }

      // A viewer who joins late, or reconnects, gets them from the manifest.
      await viewer.close()
      fs.rmSync(homes.viewer, { recursive: true })

      const again = await s.tui(["join", links[1]!], {
        env: new Map([
          ["OI_AGENT_HOME", homes.viewer],
          ["OI_AGENT_USER", "eve"],
        ]),
      })

      await again.waitFor(
        /▣ Screenshot 2026-11-18 at 1\.54\.09\u202FPM\.png[\s\S]*▣ blue\.png[\s\S]*view only/,
      )
      expect(new Store(homes.viewer).readAttachment(session, refs[1]!.id)?.data).toBe(BLUE.toString("base64"))

      // A view link attaches nothing in the terminal, and the host refuses an upload made with its token.
      const green = writeImage(desktop(s), "another.png", RED)

      await again.paste(dropped(green))
      await again.waitFor(/view only: the host has not let you prompt, so images cannot be attached/)

      const view = parseShareLink(links[1]!)

      const refused = await fetch(`${view?.address}:${view?.port}/v1/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${view?.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "look", images: [{ name: "a.png", data: RED.toString("base64") }] }),
      })

      expect(refused.status).toBe(403)
      expect(s.spans.turns(session)).toHaveLength(1)
      expect(s.spans.store.manifest(session).filter((rel) => rel.startsWith("attachments/"))).toHaveLength(2)
    },
  )

  scenario(
    "a model that cannot read images is sent them anyway, and its provider's error is what is shown",
    {
      needs: ["rex"],
      config: new Map<string, Schema.Json>([
        ["steering", "off"],
        [
          "providers",
          [
            {
              id: "textonly",
              name: "Text only",
              kind: "openai-compatible",
              base_url: textOnly.url,
              models: [{ id: "tiny" }],
            },
          ],
        ],
      ]),
    },
    async (s) => {
      const red = writeImage(desktop(s), "red.png", RED)
      const before = textOnly.requests.length
      const term = await s.tui(["-m", "textonly/tiny"])

      await term.waitFor(IDLE)
      await term.paste(dropped(red))
      await term.waitFor(/1 image attached/)
      await term.line("What colour is this?")

      // No check of what the model can read: the request went out with the image, and the provider refused it.
      const screen = await term.waitFor(new RegExp(NO_IMAGES.replaceAll(".", String.raw`\.`)))
      const request = textOnly.requests.slice(before).find((entry) => entry.url.endsWith("/chat/completions"))

      expect(request?.body).toContain(`data:image/png;base64,${RED.toString("base64")}`)
      expect(screen).toMatch(/textonly: This model does not support image input\./)
      await term.waitFor(/This conversation has images in it\./)

      const session = s.spans.onlySession()

      await s.spans.waitFor("the turn to fail", () =>
        s.spans.turns(session)[0]?.state === "failed" ? true : undefined,
      )
      expect(readMetadata(s.spans.turns(session)[0]!.root).attachments).toHaveLength(1)
    },
  )
})
