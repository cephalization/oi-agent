/**
 * `oi setup`, driven like a person would, without any model calls: an
 * OpenAI-compatible server and no Anthropic key. Learning from corrections
 * then defaults to the agent's own model. Choosing Anthropic's Haiku without
 * a key means it will not run: setup has to say so, and the terminal has to
 * keep saying so, rather than leaving it silently off.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import { describe, expect } from "vite-plus/test"
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
    steering: Schema.String,
    steering_model: Schema.String,
  }),
)

const savedConfig = (s: Scenario) =>
  Schema.decodeUnknownSync(SavedConfig)(
    fs.readFileSync(path.join(s.sandbox.configDir, "config.json"), "utf8"),
  )

/** Answer every step of `oi setup` up to the learning step, with a local server and its one model. */
const setupUntilLearning = async (term: Terminal): Promise<void> => {
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
  await term.line("m1")
  await term.waitFor(/Which model\?/)
  await term.key("enter")
  await term.waitFor(/Reasoning effort\?/)
  await term.key("enter")
  await term.waitFor(/Before running a tool/)
  await term.key("enter")
  await term.waitFor(/Learning from corrections[\s\S]*When you correct oi:/)
}

/** The rest of setup: no Phoenix, the default sessions directory. */
const finishSetup = async (term: Terminal): Promise<string> => {
  await term.waitFor(/Phoenix URL/)
  await term.line("none")
  await term.waitFor(/Sessions directory/)
  await term.key("enter")

  const screen = await term.waitFor(/Saved /)

  await term.exited()

  return screen
}

describe("onboarding", () => {
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

      const screen = await finishSetup(setup)

      expect(screen).not.toMatch(/Anthropic API key/)
      expect(savedConfig(s).steering).toBe("off")

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

      const term = await s.tui([], { env: NO_KEY })

      await term.waitFor(/Every step is an OpenInference span on disk/)
      expect(await term.screen()).not.toMatch(/Learning from corrections/)
    },
  )
  scenario(
    "rerunning setup preserves a custom steering model",
    { needs: ["rex"], config: new Map([["steering_model", "other/custom-model"]]) },
    async (s) => {
      const setup = await s.tui(["setup"], { env: NO_KEY })

      await setupUntilLearning(setup)
      await setup.key("enter")
      await setup.waitFor(
        /Which model reads your messages[\s\S]*other\/custom-model[\s\S]*current steering model/,
      )
      await setup.key("enter")
      await finishSetup(setup)
      expect(savedConfig(s).steering_model).toBe("other/custom-model")
    },
  )
})
