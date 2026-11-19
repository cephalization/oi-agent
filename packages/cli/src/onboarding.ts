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
  GOOGLE_MODELS,
  googleEfforts,
  hasConfig,
  loadConfig,
  saveConfig,
  setSecret,
  type Steering,
  DECISION_ACCOUNT,
  DEFAULT_DECISION,
} from "@oi-agent/engine"
import { homedir } from "node:os"
import { type Dialog, setupPhoenix } from "./phoenix-setup.ts"
import { ask, askSecret, askUntil, choose, confirm, say } from "./prompts.ts"
import { Providers } from "./providers.ts"
import { style, wrap } from "./tui/ansi.ts"

// Higher versions first; keep the curated order for models at the same version.
const ANTHROPIC_MODELS: ReadonlyArray<{ value: string; label: string; hint?: string }> = [
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
type ProviderChoice = "anthropic" | "openai" | "chatgpt" | "google" | "compatible"

const providerStep = async (current: Config): Promise<ProviderChoice> => {
  step(
    "Provider",
    "Where the agent's model runs. Add more later with /provider; switch any time with /model.",
  )

  const initial: ProviderChoice =
    current.provider === "anthropic" ||
    current.provider === "openai" ||
    current.provider === "chatgpt" ||
    current.provider === "google"
      ? current.provider
      : "compatible"

  const top = await choose<ProviderChoice>(
    "Which provider?",
    [
      { value: "anthropic", label: "Anthropic", hint: "Claude, with an API key" },
      { value: "openai", label: "OpenAI", hint: "sign in with ChatGPT, or an API key" },
      { value: "compatible", label: "OpenAI-compatible", hint: "Ollama, vLLM, LM Studio, OpenRouter, …" },
      { value: "google", label: "Google Gemini", hint: "Gemini 4, with an API key" },
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
  else warn("Could not save the key to the keychain. Set it in your shell's environment instead.")

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
  else warn("Could not save the key to the keychain. Set it in your shell's environment instead.")

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
    'After each message, a small model checks whether you corrected how oi works in general, not just this task ("we use pnpm here"), and saves that as a check on every later turn. Messages typed while oi works count too. One small call per message.',
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
    {
      value: agentModel,
      label: `The agent's model, ${agentModel}`,
      hint: "Use the same model. No extra API key.",
    },
    {
      value: HAIKU,
      label: "Claude Haiku 5.5",
      hint: "Low-cost option. Needs an Anthropic API key.",
    },
    {
      value: JEV,
      label: "TypeSafe Jev decision model",
      hint: "cheap screen per message; needs a TypeSafe key",
    },
    { value: "", label: "Another model", hint: "Enter the provider and model ID yourself." },
  ]

  if (current.steering_model !== "" && !options.some((option) => option.value === current.steering_model))
    options.splice(options.length - 1, 0, {
      value: current.steering_model,
      label: current.steering_model,
      hint: "Your current model for checking corrections.",
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

  // Compare digit runs as numbers (5.10 before 5.6), just for the setup menu.
  // Keep the configured model selectable even if it falls below the menu's cutoff.
  const shown = ids
    .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .filter((id, index) => index < 14 || id === current)

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

/** The Phoenix conversation, held in setup's plain prompts. Ctrl+C cancels all of setup, as everywhere in it. */
const setupDialog: Dialog = {
  ask,
  secret: askSecret,
  choose,
  ok,
  warn,
  note: (text) => say(style.gray(`  ${text}`)),
  open: (url) => {
    openBrowser(url)
    say(style.gray("  Opening your browser to log in to Phoenix. If it did not open, visit:"))
    say(`  ${url}`)
  },
  paste: askUntil,
}

const phoenixStep = async (current: Config["phoenix"]): Promise<Config["phoenix"]> => {
  step(
    "Phoenix",
    "Optional. With a server set, every span and evaluation is exported as it is written. Change it later with /phoenix.",
  )

  return (await setupPhoenix(setupDialog, current)) ?? current
}

/**
 * What a person would otherwise find out late, said once when setup ends:
 * things that need no setting, and so appear nowhere above.
 */
export const firstTips = (config: Config): Array<string> => [
  "Show a picture: drop an image file on the terminal, or press ctrl+v to paste one from the clipboard.",
  config.steering === "off"
    ? "Keep typing while oi works: Enter steers current work, and ctrl+t queues follow-up messages."
    : "Keep typing while oi works: Enter steers current work (ctrl+t queues it instead), and corrections are learned.",
  config.phoenix.endpoint === ""
    ? "/phoenix sends every span to a Phoenix server, and logs in through your browser when auth is enabled."
    : "/phoenix changes where spans go, or logs in again; /export sends a session now.",
  "/feedback drafts a public issue for oi for you to review and approve.",
  "/share invites someone into the session, /tour has oi explain itself from its own files, and / lists the rest of the commands.",
]

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
  } else if (choice === "google") {
    await apiKeyStep("google", "Google Gemini", false)

    model = await listedModelStep(current.provider === "google" ? current.model : "gemini-4-hydrogen", () =>
      Promise.resolve(GOOGLE_MODELS.map((option) => option.id)),
    )
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

  const levels = provider === "google" ? googleEfforts(model) : []
  const choices = levels.length === 0 ? EFFORTS : EFFORTS.filter((option) => levels.includes(option.value))
  const effort = await choose("Reasoning effort?", choices, current.effort)

  step("Tool approvals", "Reading files needs no approval. This covers shell commands and file edits.")

  const approvals = await choose(
    "Before running a tool that changes your machine:",
    [
      { value: "allow" as const, label: "Just run it" },
      {
        value: "auto" as const,
        label: "Let a decision model approve safe ones",
        hint: "TypeSafe Jev; you approve the rest",
      },
      { value: "ask" as const, label: "Ask me each time" },
    ],
    current.approvals,
  )

  if (approvals === "auto")
    await keyFor(
      DECISION_ACCOUNT,
      "TypeSafe",
      "Auto approvals use TypeSafe's Jev decision model, which needs a TypeSafe API key, kept in your keychain.",
      "Without a TypeSafe key, auto mode asks you to approve every tool call.",
    )

  const agentModel = `${provider}/${model}`
  const { steering, steering_model } = await steeringStep(current, agentModel)
  const phoenix = await phoenixStep(current.phoenix)

  step(
    "Storage",
    "Sessions are plain span files; attached images are stored with them. Point this at a synced folder to share them between machines.",
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
  say(`Run ${style.bold("oi")} in a project to start. Quick overview:`)

  // Wrapped here, with a hanging indent: a terminal would break each tip mid-word at its edge.
  for (const tip of firstTips(config)) {
    const [head = "", ...rest] = wrap(tip, Math.max((process.stdout.columns ?? 80) - 5, 40))

    say(`  ${style.gray("·")} ${head}`)

    for (const line of rest) say(`    ${line}`)
  }

  say(style.gray("oi setup changes these settings; oi --help lists commands."))
  say()

  return config
}

export { configPath }
