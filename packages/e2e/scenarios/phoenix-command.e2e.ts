/**
 * `/phoenix` (issue #48): choosing another Phoenix while a session runs,
 * logging in to it through the browser, and export following at once.
 *
 * Two servers: the one every scenario reports to (no auth), and one started
 * with auth (`needs: phoenix-auth`, see the README). The scenario is the
 * browser: it logs in as the admin and answers Phoenix's consent page over
 * HTTP, as the page itself does. The model is a fake, so the keychain can be
 * one of the scenario's own and the key it stores never meets a real one.
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { configPath, parser } from "@oi-agent/engine"
import { Schema } from "effect"
import { afterAll, describe, expect } from "vite-plus/test"
import { fakeChatModel } from "../src/fakes.ts"
import {
  answerLogin,
  PHOENIX_AUTH_ENDPOINT,
  PHOENIX_ENDPOINT,
  PHOENIX_PROJECT,
  spanIdsIn,
} from "../src/phoenix.ts"
import { type Scenario, scenario } from "../src/scenario.ts"
import type { Terminal } from "../src/term.ts"

const model = await fakeChatModel("pong")

afterAll(() => model.close())

/** A keychain service of this file's own: what a scenario stores is never a real key, and is removed after. */
const KEYCHAIN = `oi-agent-e2e-${randomBytes(6).toString("hex")}`

const storedKey = (): string | undefined => {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN, "-a", "phoenix", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

afterAll(() => {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN, "-a", "phoenix"], {
      stdio: "ignore",
    })
  } catch {
    // Nothing was stored.
  }
})

const options = {
  needs: ["rex", "phoenix-auth"] as const,
  phoenix: true,
  model: "fake/pong",
  config: new Map<string, Schema.Json>([
    ["steering", "off"],
    [
      "providers",
      [
        {
          id: "fake",
          name: "Fake",
          kind: "openai-compatible",
          base_url: model.url,
          models: [{ id: "pong" }],
        },
      ],
    ],
  ]),
  env: new Map([["OI_AGENT_KEYCHAIN_SERVICE", KEYCHAIN]]),
}

const IDLE = /enter starts a new turn/

/** Replace what a question is prefilled with, and answer it. */
const answer = async (term: Terminal, text: string): Promise<void> => {
  await term.key("ctrl+u")
  await term.line(text)
}

/** The page oi asks the person to open: long, so it wraps on screen and is read with the rows joined. */
const loginUrl = async (term: Terminal): Promise<string> => {
  const screen = await term.waitFor(/Waiting for the browser/)

  const urls = [
    ...screen.replaceAll("\n", "").matchAll(/(http\S+?\/oauth2\/authorize\?\S+?code_challenge_method=S256)/g),
  ]

  return urls.at(-1)?.[1] ?? ""
}

const turn = async (s: Scenario, term: Terminal, count: number): Promise<string> => {
  await term.waitFor(IDLE)
  await term.line(`Say pong (${count}).`)

  const session = s.spans.onlySession()
  const turns = await s.spans.settledTurns(session, count)

  return turns.at(-1)?.root.context.span_id ?? ""
}

/** `/phoenix`, up to the choice of how to authenticate to the server that asks for a login. */
const toCredentials = async (term: Terminal, project: string): Promise<void> => {
  await term.line("/phoenix")
  await term.waitFor(/\? Phoenix URL \(type `none` to turn export off\)/)
  await answer(term, PHOENIX_AUTH_ENDPOINT)
  await term.waitFor(/It asks for a login\./)
  await term.waitFor(/\? Phoenix project/)
  await answer(term, project)
  await term.waitFor(/How should oi authenticate to Phoenix\?[\s\S]*Log in with your browser/)
}

const SavedPhoenix = parser(
  Schema.Struct({
    model: Schema.String,
    phoenix: Schema.Struct({ endpoint: Schema.String, project: Schema.String }),
  }),
)

describe("/phoenix", () => {
  scenario(
    "logs in through the browser, stores a key Phoenix made, and export follows to the new server at once",
    options,
    async (s) => {
      const project = `oi-e2e-login-${randomBytes(4).toString("hex")}`
      const term = await s.tui()
      const first = await turn(s, term, 1)

      // Exporting where the config says: the server without auth.
      await s.spans.waitFor("the first turn in the first Phoenix", async () =>
        (await spanIdsIn(PHOENIX_ENDPOINT, PHOENIX_PROJECT)).includes(first) ? true : undefined,
      )

      await toCredentials(term, project)
      await term.key("enter")

      // The scenario is the browser: log in, approve, and come back to the address oi listens on.
      await answerLogin(await loginUrl(term))
      await term.waitFor(/✓ Phoenix accepted the key\./)
      await term.waitFor(/✓ Saved the key to the keychain\./)

      const switched = await term.waitFor(/Exporting to \S+, project \S+, from now on\.\s+Sent \d+ spans/)

      expect(switched.replaceAll("\n", "")).toContain(
        `Exporting to ${PHOENIX_AUTH_ENDPOINT}, project ${project}`,
      )

      // The key is in the keychain and nowhere else, and Phoenix lists it as this user's, made by oi.
      const key = storedKey() ?? ""

      expect(key).not.toBe("")

      const files = fs
        .readdirSync(s.sandbox.root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))

      expect(files.filter((file) => fs.readFileSync(file).includes(key))).toEqual([])
      expect(await term.screen()).not.toContain(key)

      const keys = await fetch(`${PHOENIX_AUTH_ENDPOINT}/v1/user/api_keys`, {
        headers: { authorization: `Bearer ${key}` },
      })

      expect(JSON.stringify(await keys.json())).toContain(`oi-agent ${os.hostname()}`)

      // What the session already had was sent to the new server when it was chosen.
      await s.spans.waitFor("the first turn in the new Phoenix", async () =>
        (await spanIdsIn(PHOENIX_AUTH_ENDPOINT, project, key)).includes(first) ? true : undefined,
      )

      // And what happens next goes there as it happens, with no restart: not to the old one.
      const second = await turn(s, term, 2)

      await s.spans.waitFor("the second turn in the new Phoenix", async () =>
        (await spanIdsIn(PHOENIX_AUTH_ENDPOINT, project, key)).includes(second) ? true : undefined,
      )
      expect(await spanIdsIn(PHOENIX_ENDPOINT, PHOENIX_PROJECT)).not.toContain(second)
      await term.line("/export")

      const exported = await term.waitFor(/Sent \d+ spans and \d+ annotations to Phoenix at[\s\S]*\(project/)

      expect(exported.replaceAll("\n", "")).toContain(
        `to Phoenix at ${PHOENIX_AUTH_ENDPOINT} (project ${project})`,
      )

      // Only the Phoenix section of the config changed.
      const saved = SavedPhoenix(
        fs.readFileSync(configPath({ OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "utf8"),
      )

      expect(saved).toEqual({ model: "fake/pong", phoenix: { endpoint: PHOENIX_AUTH_ENDPOINT, project } })
    },
  )

  scenario(
    "backing out changes nothing, a refused login is said plainly, and a pasted redirect finishes one the browser could not",
    options,
    async (s) => {
      const project = `oi-e2e-paste-${randomBytes(4).toString("hex")}`
      const term = await s.tui()

      await term.waitFor(IDLE)

      // Esc at the first question: nothing is saved, and export stays where it was.
      await term.line("/phoenix")
      await term.waitFor(/\? Phoenix URL/)
      await term.key("escape")
      await term.waitFor(/Phoenix is unchanged\./)

      const config = configPath({ OI_AGENT_CONFIG_DIR: s.sandbox.configDir })

      expect(SavedPhoenix(fs.readFileSync(config, "utf8"))?.phoenix.endpoint).toBe(PHOENIX_ENDPOINT)

      // Refusing on Phoenix's consent page comes back as that, and the ways to authenticate are offered again.
      await toCredentials(term, project)
      await term.key("enter")
      await answerLogin(await loginUrl(term), { approved: false })
      await term.waitFor(/! The login was not approved\.[\s\S]*How should oi authenticate to Phoenix\?/)

      // A browser that cannot reach this machine: the person pastes the address it ended on.
      await term.key("enter")

      const redirect = await answerLogin(await loginUrl(term), { deliver: false })

      await term.send("not a url")
      await term.key("enter")
      await term.waitFor(/! That is not a URL\./)
      await term.waitFor(/Waiting for the browser/)
      await term.paste(redirect)
      await term.key("enter")
      await term.waitFor(/✓ Phoenix accepted the key\./)
      await term.waitFor(/Exporting to \S+, project \S+, from now on\./)
      expect(SavedPhoenix(fs.readFileSync(config, "utf8"))?.phoenix).toEqual({
        endpoint: PHOENIX_AUTH_ENDPOINT,
        project,
      })

      // Turning export off is the same command.
      await term.line("/phoenix")
      await term.waitFor(/\? Phoenix URL/)
      await answer(term, "none")
      await term.waitFor(/Export to Phoenix is off\./)
      expect(await term.screen()).not.toMatch(/→ phoenix\s*\n›/)
      expect(SavedPhoenix(fs.readFileSync(config, "utf8"))?.phoenix.endpoint).toBe("")
    },
  )
})
