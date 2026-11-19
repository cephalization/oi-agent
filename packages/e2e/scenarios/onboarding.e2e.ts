/**
 * `oi setup`, driven like a person would, without any model calls: an
 * OpenAI-compatible server and no Anthropic key. Learning from corrections
 * then defaults to the agent's own model. Choosing Anthropic's Haiku without
 * a key means it will not run: setup has to say so, and the terminal has to
 * keep saying so, rather than leaving it silently off.
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import { afterAll, describe, expect } from "vite-plus/test"
import { answerLogin, PHOENIX_AUTH_ENDPOINT } from "../src/phoenix.ts"
import { type Scenario, scenario } from "../src/scenario.ts"
import type { Terminal } from "../src/term.ts"

/** No Anthropic key, even if the machine running the scenarios has one. */
const NO_KEY = new Map([["ANTHROPIC_API_KEY", ""]])

// The banner wraps, so match across lines.
const NOT_RUNNING = /Learning from corrections runs on[\s\S]*claude-haiku-5-5[\s\S]*no credentials/

const SavedConfig = Schema.fromJsonString(
  Schema.Struct({
    provider: Schema.String,
    model: Schema.String,
    approvals: Schema.String,
    steering: Schema.String,
    steering_model: Schema.String,
    auto_correction: Schema.Boolean,
    max_correction_turns: Schema.Int,
  }),
)

const savedConfig = (s: Scenario) =>
  Schema.decodeUnknownSync(SavedConfig)(
    fs.readFileSync(path.join(s.sandbox.configDir, "config.json"), "utf8"),
  )

/** Set up a local server and wait for its model menu. */
const setupUntilModel = async (term: Terminal, models: string = "m1"): Promise<string> => {
  await term.waitFor(/Your name/)
  await term.key("enter")
  await term.waitFor(/Which provider\?/)
  // 1 Anthropic, 2 OpenAI, 3 OpenAI-compatible.
  await term.line("3")
  await term.waitFor(/Name/)
  await term.line("Local")
  await term.waitFor(/Base URL/)
  await term.line("http://127.0.0.1:9/v1")
  await term.waitFor(/API key/)
  await term.key("enter")
  await term.waitFor(/Models, comma-separated/)
  await term.line(models)

  return term.waitFor(/Which model\?[\s\S]*choice \(\d+\)/)
}

/** Accept the default model and effort, then wait for the approvals menu. */
const setupUntilApprovals = async (term: Terminal): Promise<string> => {
  await term.key("enter")
  await term.waitFor(/Reasoning effort\?/)
  await term.key("enter")

  return term.waitFor(/Before running a tool[\s\S]*choice \(\d+\)/)
}

const setupUntilLearning = async (term: Terminal): Promise<void> => {
  await setupUntilModel(term)
  await setupUntilApprovals(term)
  await term.key("enter")
  await term.waitFor(/Learning from corrections[\s\S]*When you correct oi:/)
}

const chooseCorrection = async (term: Terminal, initial = 1, selection?: number): Promise<void> => {
  // An old setup skips straight to Phoenix; fail immediately rather than waiting for a missing prompt.
  const screen = await term.waitFor(/When a check fails:[\s\S]*choice \(\d+\)|Phoenix URL/)

  expect(screen).toMatch(
    new RegExp(
      `When a check fails:\\s+1\\s+Wait until my next message\\s+2\\s+Automatically try to fix eligible failed checks\\s+choice \\(${initial}\\)`,
    ),
  )

  if (selection === undefined) await term.key("enter")
  else await term.line(String(selection))
}

/** The rest of setup: no Phoenix, the default sessions directory. */
const finishSetup = async (term: Terminal, initial = 1, selection?: number): Promise<string> => {
  await chooseCorrection(term, initial, selection)
  await term.waitFor(/Phoenix URL/)
  await term.line("none")
  await term.waitFor(/Sessions directory/)
  await term.key("enter")

  const screen = await term.waitFor(/Saved /)

  await term.exited()

  return screen
}

/** A keychain service of this file's own, so the key setup stores is never a real one. */
const KEYCHAIN = `oi-agent-e2e-${randomBytes(6).toString("hex")}`

afterAll(() => {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN, "-a", "phoenix"], {
      stdio: "ignore",
    })
  } catch {
    // Nothing was stored.
  }
})

describe("onboarding", () => {
  scenario(
    "first-run setup lists higher model versions first and still defaults to asking for approval",
    { needs: ["rex"] },
    async (s) => {
      fs.unlinkSync(path.join(s.sandbox.configDir, "config.json"))

      const setup = await s.tui(["setup"], { env: NO_KEY })
      const models = await setupUntilModel(setup, "gpt-5.2, gpt-5.10, gpt-5.6-luna")

      expect(models).toMatch(
        /1\s+gpt-5\.10\s+2\s+gpt-5\.6-luna\s+3\s+gpt-5\.2\s+4\s+Another model id\s+choice \(1\)/,
      )

      const approvals = await setupUntilApprovals(setup)

      expect(approvals).toMatch(
        /1\s+Just run it\s+2\s+Let a decision model approve safe ones[^\n]*\n\s*3\s+Ask me each time\s+choice \(3\)/,
      )
      await setup.key("enter")
      await setup.waitFor(/When you correct oi:/)
      await setup.key("enter")

      const corrections = await setup.waitFor(/Which model reads your messages[\s\S]*choice \(\d+\)/)
      const hints = corrections.replaceAll(/\s+/g, " ")

      expect(hints).toContain("Use the same model. No extra API key.")
      expect(hints).toContain("Low-cost option. Needs an Anthropic API key.")
      expect(hints).toContain("TypeSafe Jev decision model cheap screen per message; needs a TypeSafe key")
      expect(hints).toContain("Enter the provider and model ID yourself.")
      await setup.key("enter")
      await finishSetup(setup)
      expect(savedConfig(s)).toMatchObject({
        model: "gpt-5.10",
        approvals: "ask",
        auto_correction: false,
        max_correction_turns: 2,
      })
    },
  )

  scenario(
    "setup logs in to a Phoenix that asks for it through the browser, and keeps the key in the keychain",
    { needs: ["rex", "phoenix-auth"] },
    async (s) => {
      const project = `oi-e2e-setup-${randomBytes(4).toString("hex")}`

      const setup = await s.tui(["setup"], {
        env: new Map([...NO_KEY, ["OI_AGENT_KEYCHAIN_SERVICE", KEYCHAIN]]),
      })

      await setupUntilLearning(setup)
      await setup.key("enter")
      await setup.waitFor(/Which model reads your messages/)
      await setup.key("enter")

      await chooseCorrection(setup)

      // The same conversation as /phoenix: the server is asked what it wants before anything is saved.
      await setup.waitFor(/Phoenix URL \(type `none` to turn export off\)/)
      await setup.line(PHOENIX_AUTH_ENDPOINT)
      await setup.waitFor(/Auth is enabled\./)
      await setup.waitFor(/Phoenix project/)
      await setup.line(project)
      await setup.waitFor(/How should oi authenticate to Phoenix\?[\s\S]*1\s+Log in with your browser/)
      await setup.line("1")

      const waiting = await setup.waitFor(/Waiting for browser login/)

      const url = [
        ...waiting
          .replaceAll("\n", "")
          .matchAll(/(http\S+?\/oauth2\/authorize\?\S+?code_challenge_method=S256)/g),
      ].at(-1)?.[1]

      await answerLogin(url ?? "")
      await setup.waitFor(/Phoenix accepted the key\./)
      await setup.waitFor(/Saved the key to the keychain\./)
      await setup.waitFor(/Sessions directory/)
      await setup.key("enter")
      await setup.waitFor(/Saved /)
      await setup.exited()

      const saved = fs.readFileSync(path.join(s.sandbox.configDir, "config.json"), "utf8")

      expect(JSON.parse(saved).phoenix).toEqual({ endpoint: PHOENIX_AUTH_ENDPOINT, project })

      const key = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN, "-a", "phoenix", "-w"], {
        encoding: "utf8",
      }).trim()

      expect(saved).not.toContain(key)
      expect(await setup.screen()).not.toContain(key)

      const accepted = await fetch(`${PHOENIX_AUTH_ENDPOINT}/v1/projects?limit=1`, {
        headers: { authorization: `Bearer ${key}` },
      })

      expect(accepted.status).toBe(200)
    },
  )

  scenario(
    "choosing Haiku without an Anthropic key, setup and the terminal say that learning from corrections will not run",
    { needs: ["rex"] },
    async (s) => {
      const setup = await s.tui(["setup"], { env: NO_KEY })

      await setupUntilLearning(setup)
      await setup.key("enter")
      // 1 the agent's model, 2 Claude Haiku, 3 a decision model, 4 another.
      await setup.waitFor(/Which model reads your messages/)
      await setup.line("2")
      await setup.waitFor(/It runs on Anthropic's claude-haiku, so it needs an Anthropic API key/)
      await setup.waitFor(/Anthropic API key \(input is hidden; leave empty to skip\)/)
      await setup.key("enter")
      expect(await setup.waitFor(/oi will not learn from corrections/)).toMatch(/oi auth login/)
      await finishSetup(setup)

      expect(savedConfig(s)).toMatchObject({
        provider: "local",
        model: "m1",
        steering: "auto",
        steering_model: "claude-haiku-5-5",
      })

      // And the terminal keeps saying so, under the banner.
      const term = await s.tui([], { env: NO_KEY })

      await term.waitFor(NOT_RUNNING)
    },
  )

  scenario(
    "turning learning off in setup asks for no key, and the terminal says nothing about it",
    { needs: ["rex"] },
    async (s) => {
      const setup = await s.tui(["setup"], { env: NO_KEY })

      await setupUntilLearning(setup)
      // 1 learn lasting preferences, 2 don't learn.
      await setup.line("2")

      const screen = await finishSetup(setup, 1, 2)

      expect(screen).not.toMatch(/Anthropic API key/)
      expect(savedConfig(s)).toMatchObject({
        steering: "off",
        auto_correction: true,
        max_correction_turns: 2,
      })

      const term = await s.tui([], { env: NO_KEY })

      await term.waitFor(/Every step is an OpenInference span on disk/)
      expect(await term.screen()).not.toMatch(NOT_RUNNING)
    },
  )

  scenario(
    "without an Anthropic key, learning defaults to the agent's own model and needs no key",
    { needs: ["rex"] },
    async (s) => {
      const setup = await s.tui(["setup"], { env: NO_KEY })

      await setupUntilLearning(setup)
      await setup.key("enter")
      await setup.waitFor(/Which model reads your messages[\s\S]*The agent's model, local\/m1/)
      await setup.key("enter")

      const screen = await finishSetup(setup)

      expect(screen).not.toMatch(/API key \(input is hidden; leave empty to skip\)/)
      expect(savedConfig(s)).toMatchObject({ steering: "auto", steering_model: "local/m1" })

      // Setup ends on what needs no setting and so was asked nowhere: images, steering, Phoenix, sharing.
      const tips = screen.replaceAll(/\s+/g, " ")

      expect(tips).toContain("drop an image file on the terminal")
      expect(tips).toContain("corrections are learned")
      expect(tips).toContain("/phoenix sends every span to a Phoenix server")
      expect(tips).toContain("/share invites someone into the session")
      expect(tips).toContain("/feedback")

      const term = await s.tui([], { env: NO_KEY })

      await term.waitFor(/Every step is an OpenInference span on disk/)
      expect(await term.screen()).not.toMatch(/Learning from corrections/)
    },
  )
  scenario(
    "rerunning setup preserves configured approvals and a custom correction model",
    {
      needs: ["rex"],
      approvals: "allow",
      config: new Map<string, string | boolean | number>([
        ["steering_model", "other/custom-model"],
        ["auto_correction", true],
        ["max_correction_turns", 4],
      ]),
    },
    async (s) => {
      const setup = await s.tui(["setup"], { env: NO_KEY })

      await setupUntilLearning(setup)
      await setup.key("enter")
      await setup.waitFor(
        /Which model reads your messages[\s\S]*other\/custom-model[\s\S]*Your current model for checking corrections/,
      )
      await setup.key("enter")
      await finishSetup(setup, 2)
      expect(savedConfig(s)).toMatchObject({
        approvals: "allow",
        steering_model: "other/custom-model",
        auto_correction: true,
        max_correction_turns: 4,
      })
    },
  )
})
