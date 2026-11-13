/**
 * First-run setup: asks for what the agent needs, checks each answer against
 * the real service, and writes `~/.config/oi-agent/config.json`. Keys go to
 * the system keychain, never to the config file.
 */
import {
  checkModel,
  type Config,
  configPath,
  defaultHome,
  type Effort,
  getSecret,
  hasConfig,
  loadConfig,
  saveConfig,
  setSecret,
} from "@oi-agent/engine"
import { homedir } from "node:os"
import { ask, askSecret, choose, confirm, say } from "./prompts.ts"
import { style, wrap } from "./tui/ansi.ts"

const MODELS = [
  {
    value: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    hint: "most capable Opus · $4 / $20 per million tokens",
  },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "fast and capable · $2 / $10" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "cheapest · $0.10 / $0.50" },
  { value: "claude-fable-5-2", label: "Claude Fable 5.2", hint: "most capable overall · $8 / $40" },
  { value: "", label: "Another model id" },
]

const EFFORTS: ReadonlyArray<{ value: Effort; label: string; hint: string }> = [
  { value: "low", label: "low", hint: "quick answers, fewer tool calls" },
  { value: "medium", label: "medium", hint: "a balance" },
  { value: "high", label: "high", hint: "recommended for coding" },
  { value: "xhigh", label: "xhigh", hint: "most thorough, slowest" },
]

const LOCAL_PHOENIX = "http://localhost:6006"

const ok = (text: string): void => say(`  ${style.green("✓")} ${text}`)
const warn = (text: string): void => say(`  ${style.yellow("!")} ${text}`)
const tilde = (file: string): string => file.replace(homedir(), "~")
const expand = (file: string): string => file.replace(/^~(?=\/|$)/, homedir())

const step = (title: string, detail: string): void => {
  say()
  say(style.cyan(title))

  for (const line of wrap(detail, Math.min((process.stdout.columns ?? 80) - 1, 78))) say(style.gray(line))
}

/** The version a Phoenix server reports, or `undefined` if none answers. */
const phoenixVersion = async (endpoint: string): Promise<string | undefined> => {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/arize_phoenix_version`, {
      signal: AbortSignal.timeout(2000),
    })

    return response.ok ? (await response.text()).trim() : undefined
  } catch {
    return undefined
  }
}

const apiKeyStep = async (): Promise<string | undefined> => {
  const existing = getSecret("anthropic")

  step("Anthropic API key", "Stored in your system keychain. It is never written to a file or a session.")

  if (
    existing !== undefined &&
    (await confirm(`A key ending in …${existing.slice(-4)} is already stored. Keep it?`, true))
  ) {
    return existing
  }

  const entered = await askSecret("API key (input is hidden; leave empty to set it later)")

  if (entered === "") {
    warn("No key set. Run `oi auth login` before your first session.")

    return undefined
  }

  if (setSecret("anthropic", entered)) ok("Saved to the keychain.")
  else warn("The keychain refused the key. Set ANTHROPIC_API_KEY in your shell instead.")

  return entered
}

const modelStep = async (current: string, apiKey: string | undefined): Promise<string> => {
  step("Model", "Used for the agent's own turns. Change it any time with `oi setup` or `-m`.")

  const known = MODELS.some((model) => model.value === current)
  const picked = await choose("Which model?", MODELS, known ? current : "")
  const model = picked === "" ? await ask("Model id", known ? "" : current) : picked

  if (apiKey === undefined || model === "") return model

  try {
    ok(`${await checkModel(apiKey, model)} is available to your key.`)
  } catch (error) {
    warn(`Could not confirm ${model}: ${error instanceof Error ? error.message : String(error)}`)
  }

  return model
}

const phoenixStep = async (current: Config["phoenix"]): Promise<Config["phoenix"]> => {
  step("Phoenix", "Optional. With a server set, every span and evaluation is exported as it is written.")

  const detected = current.endpoint === "" ? await phoenixVersion(LOCAL_PHOENIX) : undefined

  if (detected !== undefined) ok(`Found Phoenix ${detected} at ${LOCAL_PHOENIX}.`)

  const suggestion = current.endpoint === "" && detected !== undefined ? LOCAL_PHOENIX : current.endpoint
  const answer = await ask("Phoenix URL (type `none` to skip)", suggestion === "" ? "none" : suggestion)
  const endpoint = answer === "none" ? "" : answer.replace(/\/+$/, "")

  if (endpoint === "") return { endpoint: "", project: current.project }

  const version = await phoenixVersion(endpoint)

  if (version === undefined) warn(`Nothing answered at ${endpoint}. Saved anyway; export will retry.`)
  else ok(`Connected to Phoenix ${version}.`)

  const project = await ask("Phoenix project", current.project)
  const key = await askSecret("Phoenix API key (input is hidden; leave empty if the server has no auth)")

  if (key !== "" && setSecret("phoenix", key)) ok("Saved to the keychain.")

  return { endpoint, project }
}

/** Run setup and write the config file. Resolves to the saved settings. */
export const runOnboarding = async (): Promise<Config> => {
  const current = loadConfig()
  const first = !hasConfig()

  say()
  say(`${style.bold("oi-agent setup")}${first ? "" : style.gray("  (press return to keep a current value)")}`)
  say(style.gray("A coding agent whose state is OpenInference spans on disk."))

  step("You", "Recorded on each turn you start, and shown to people you share a session with.")

  const user = await ask("Your name", current.user)
  const apiKey = await apiKeyStep()
  const model = await modelStep(current.model, apiKey)

  step("Effort", "How hard the model works on each turn.")

  const effort = await choose("Reasoning effort?", EFFORTS, current.effort)

  step("Tool approvals", "Reading files never asks. This covers shell commands and file edits.")

  const approvals = await choose(
    "Before running a tool that changes your machine:",
    [
      { value: "ask" as const, label: "Ask me each time", hint: "recommended" },
      { value: "allow" as const, label: "Just run it" },
    ],
    current.approvals,
  )

  const phoenix = await phoenixStep(current.phoenix)

  step(
    "Storage",
    "Sessions are plain span files. Point this at a synced folder to share them between machines.",
  )

  const home = expand(await ask("Sessions directory", tilde(first ? defaultHome() : current.home)))
  const config: Config = { ...current, user, model, effort, approvals, phoenix, home }
  const file = saveConfig(config)

  say()
  ok(`Saved ${tilde(file)}`)
  say()
  say(
    `Run ${style.bold("oi")} in a project to start. ${style.gray("oi setup changes these settings; oi --help lists commands.")}`,
  )
  say()

  return config
}

export { configPath }
