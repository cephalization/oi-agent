/**
 * First-run setup: asks for what the agent needs, checks each answer against
 * the real service, and writes `~/.config/oi-agent/config.json`. Keys go to
 * the system keychain, never to the config file.
 */
import {
  checkModel,
  type Config,
  chatgptSignIn,
  listOpenAIModels,
  chatgptToken,
  OPENAI_BASE_URL,
  openBrowser,
  type ProviderConfig,
  configPath,
  defaultHome,
  type Effort,
  getSecret,
  hasConfig,
  loadConfig,
  saveConfig,
  setSecret,
  type Steering,
  DECISION_ACCOUNT,
  DEFAULT_DECISION,
} from "@oi-agent/engine"
import { homedir } from "node:os"
import { ask, askSecret, choose, confirm, say } from "./prompts.ts"
import { Providers } from "./providers.ts"
import { style, wrap } from "./tui/ansi.ts"

const MODELS: ReadonlyArray<{ value: string; label: string; hint?: string }> = [
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

type ProviderChoice = "anthropic" | "openai" | "chatgpt" | "compatible"

const providerStep = async (current: Config): Promise<ProviderChoice> => {
  step(
    "Provider",
    "Where the agent's model runs. Add more later with /provider; switch any time with /model.",
  )

  const initial: ProviderChoice =
    current.provider === "anthropic" || current.provider === "openai" || current.provider === "chatgpt"
      ? current.provider
      : "compatible"

  const top = await choose<ProviderChoice>(
    "Which provider?",
    [
      { value: "anthropic", label: "Anthropic", hint: "Claude, with an API key" },
      { value: "openai", label: "OpenAI", hint: "sign in with ChatGPT, or an API key" },
      { value: "compatible", label: "OpenAI-compatible", hint: "Ollama, vLLM, LM Studio, OpenRouter, …" },
    ],
    initial === "chatgpt" ? "openai" : initial,
  )

  if (top !== "openai") return top

  return choose<ProviderChoice>(
    "How do you want to use OpenAI?",
    [
      { value: "chatgpt", label: "Sign in with ChatGPT", hint: "uses your plan instead of a key" },
      { value: "openai", label: "API key", hint: "billed to your API account" },
    ],
    initial === "openai" ? "openai" : "chatgpt",
  )
}

/** Ask for an API key for a keychain account. Resolves to the key in use, if any. */
const apiKeyStep = async (account: string, name: string, optional: boolean): Promise<string | undefined> => {
  const existing = getSecret(account)

  step(`${name} API key`, "Stored in your system keychain. It is never written to a file or a session.")

  if (
    existing !== undefined &&
    (await confirm(`A key ending in …${existing.slice(-4)} is already stored. Keep it?`, true))
  ) {
    return existing
  }

  const entered = await askSecret(
    optional
      ? "API key (input is hidden; leave empty if the server needs none)"
      : "API key (input is hidden; leave empty to set it later)",
  )

  if (entered === "") {
    if (!optional) warn(`No key set. Run \`oi auth login ${account}\` before your first session.`)

    return undefined
  }

  if (setSecret(account, entered)) ok("Saved to the keychain.")
  else warn("The keychain refused the key. Set it in your shell's environment instead.")

  return entered
}

/** Ask for a key for an account when it has none. Resolves to whether one is stored now. */
const keyFor = async (account: string, name: string, why: string, without: string): Promise<boolean> => {
  if (getSecret(account) !== undefined) return true

  say(style.gray(`  ${why}`))

  const entered = await askSecret(`${name} API key (input is hidden; leave empty to skip)`)

  if (entered === "") {
    warn(`${without} Add one later with \`oi auth login ${account}\`.`)

    return false
  }

  if (setSecret(account, entered)) ok("Saved to the keychain.")
  else warn("The keychain refused the key. Set it in your shell's environment instead.")

  return true
}

const HAIKU = "claude-haiku-5-5"
const JEV = `decision:${DEFAULT_DECISION.model}`

/**
 * Whether corrections become standing checks, and what reads each message
 * for them: Anthropic's Haiku (the detector the experiment measured), the
 * agent's own model (no extra key), a decision model, or any other
 * `provider/model`. The default is whatever this machine already has a
 * key for. Without the key a choice needs, say plainly that learning will
 * not run.
 */
const steeringStep = async (
  current: Config,
  agentModel: string,
): Promise<{ steering: Steering; steering_model: string }> => {
  step(
    "Learning from corrections",
    'After each message, a small model checks whether you corrected how oi works in general, not just this task ("we use pnpm here"), and saves that as a check on every later turn. One small call per message.',
  )

  const steering = await choose(
    "When you correct oi:",
    [
      { value: "auto" as const, label: "Learn lasting preferences", hint: "recommended" },
      { value: "off" as const, label: "Don't learn from corrections" },
    ],
    current.steering,
  )

  if (steering === "off") return { steering, steering_model: current.steering_model }

  const options = [
    { value: agentModel, label: `The agent's model, ${agentModel}`, hint: "no extra key" },
    { value: HAIKU, label: "Claude Haiku 5.5", hint: "measured for this; needs an Anthropic key" },
    {
      value: JEV,
      label: "TypeSafe Jev decision model",
      hint: "cheap screen per message; needs a TypeSafe key",
    },
    { value: "", label: "Another model (provider/model)" },
  ]

  if (current.steering_model !== "" && !options.some((option) => option.value === current.steering_model))
    options.splice(options.length - 1, 0, {
      value: current.steering_model,
      label: current.steering_model,
      hint: "current steering model",
    })

  const fallback = getSecret("anthropic") !== undefined ? HAIKU : agentModel

  const known =
    current.steering_model !== "" && options.some((option) => option.value === current.steering_model)

  const picked = await choose(
    "Which model reads your messages for corrections?",
    options,
    known ? current.steering_model : fallback,
  )

  const steering_model = picked === "" ? await ask("Model (provider/model)", current.steering_model) : picked

  if (steering_model === HAIKU)
    await keyFor(
      "anthropic",
      "Anthropic",
      "It runs on Anthropic's claude-haiku, so it needs an Anthropic API key, kept in your keychain.",
      "Without an Anthropic key, oi will not learn from corrections.",
    )

  if (steering_model === JEV)
    await keyFor(
      DECISION_ACCOUNT,
      "TypeSafe",
      "The decision model needs a TypeSafe API key, kept in your keychain.",
      "Without a TypeSafe key, oi will not learn from corrections.",
    )

  return { steering, steering_model }
}

const signInStep = async (): Promise<boolean> => {
  step("ChatGPT", "Your browser opens to sign in. oi-agent then uses your plan's allowance, not an API key.")

  try {
    const account = await chatgptSignIn({
      onUrl: (url) => {
        openBrowser(url)
        say(style.gray(`  If the browser did not open, visit: ${url}`))
      },
    })

    ok(`Signed in as ${account}.`)

    return true
  } catch (error) {
    warn(
      `${error instanceof Error ? error.message : String(error)} Try again later with \`oi auth login chatgpt\`.`,
    )

    return false
  }
}

/** Add or change an OpenAI-compatible server. Resolves to its provider id. */
const compatibleStep = async (current: Config, providers: Providers): Promise<string> => {
  step(
    "Server",
    "Any server with an OpenAI-style /chat/completions endpoint. The key, if any, goes to the keychain.",
  )

  const existing = current.providers.find((provider) => provider.id === current.provider)

  for (;;) {
    const name = await ask("Name", existing?.name ?? "Ollama")
    const baseUrl = await ask("Base URL", existing?.base_url ?? "http://localhost:11434/v1")

    const key = await askSecret(
      "API key (input is hidden; leave empty if it needs none, or to keep the stored one)",
    )

    const models = await ask(
      "Models, comma-separated (type `none` to use the server's own list)",
      existing?.models?.map((model) => model.id).join(", ") ?? "none",
    )

    try {
      const id = await providers.saveServer(
        { name, baseUrl, key, models: models === "none" ? "" : models },
        existing !== undefined && existing.name === name ? existing.id : undefined,
      )

      ok(`Saved ${name} as ${id}.`)

      return id
    } catch (error) {
      warn(error instanceof Error ? error.message : String(error))
    }
  }
}

const ANTHROPIC_MODELS = MODELS

/** Choose among a provider's listed models, or type one. */
const listedModelStep = async (
  current: string,
  list: () => Promise<ReadonlyArray<string>>,
): Promise<string> => {
  step("Model", "Used for the agent's own turns. Change it any time with /model or `-m`.")

  const ids = await list().catch((error: Error) => {
    warn(`Could not list models: ${error.message}`)

    return []
  })

  if (ids.length === 0) return ask("Model id", current)

  const shown = ids.slice(0, 14)

  const picked = await choose(
    "Which model?",
    [...shown.map((id) => ({ value: id, label: id })), { value: "", label: "Another model id" }],
    shown.includes(current) ? current : (shown[0] ?? ""),
  )

  return picked === "" ? ask("Model id", current) : picked
}

const modelStep = async (current: string, apiKey: string | undefined): Promise<string> => {
  step("Model", "Used for the agent's own turns. Change it any time with /model or `-m`.")

  const known = ANTHROPIC_MODELS.some((model) => model.value === current)
  const picked = await choose("Which model?", ANTHROPIC_MODELS, known ? current : "")
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
  const choice = await providerStep(current)
  const servers = new Providers()
  let provider: string = choice
  let providers = current.providers
  let model: string

  if (choice === "anthropic") {
    const apiKey = await apiKeyStep("anthropic", "Anthropic", false)

    model = await modelStep(current.provider === "anthropic" ? current.model : "claude-opus-5-5", apiKey)
  } else {
    let server: ProviderConfig | undefined
    let token: string | undefined

    if (choice === "compatible") {
      provider = await compatibleStep(current, servers)
      providers = loadConfig().providers
      server = providers.find((entry) => entry.id === provider)
      token = server === undefined ? undefined : servers.key(server)
    } else if (choice === "openai") {
      token = await apiKeyStep("openai", "OpenAI", false)
    } else if (await signInStep()) {
      token = await chatgptToken().catch(() => undefined)
    }

    const baseUrl = server?.base_url ?? OPENAI_BASE_URL

    model = await listedModelStep(current.provider === provider ? current.model : "", async () => {
      if (server?.models !== undefined && server.models.length > 0)
        return server.models.map((entry) => entry.id)

      if (choice !== "compatible" && token === undefined) return []

      const listed = await listOpenAIModels({
        provider,
        baseUrl,
        token,
        openaiCatalog: choice !== "compatible",
      })

      return listed.map((entry) => entry.id)
    })
  }

  step("Effort", "How hard the model works on each turn.")

  const effort = await choose("Reasoning effort?", EFFORTS, current.effort)

  step("Tool approvals", "Reading files never asks. This covers shell commands and file edits.")

  const approvals = await choose(
    "Before running a tool that changes your machine:",
    [
      { value: "ask" as const, label: "Ask me each time", hint: "recommended" },
      {
        value: "auto" as const,
        label: "Let a decision model approve safe ones",
        hint: "TypeSafe Jev; asks about the rest",
      },
      { value: "allow" as const, label: "Just run it" },
    ],
    current.approvals,
  )

  if (approvals === "auto")
    await keyFor(
      DECISION_ACCOUNT,
      "TypeSafe",
      "Auto approvals ask TypeSafe's Jev decision model, which needs a TypeSafe API key, kept in your keychain.",
      "Without a TypeSafe key, auto mode asks about every tool call.",
    )

  const agentModel = `${provider}/${model}`
  const { steering, steering_model } = await steeringStep(current, agentModel)
  const phoenix = await phoenixStep(current.phoenix)

  step(
    "Storage",
    "Sessions are plain span files. Point this at a synced folder to share them between machines.",
  )

  const home = expand(await ask("Sessions directory", tilde(first ? defaultHome() : current.home)))

  const config: Config = {
    ...current,
    user,
    provider,
    providers,
    model,
    effort,
    approvals,
    steering,
    steering_model,
    phoenix,
    home,
  }

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
