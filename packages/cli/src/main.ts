#!/usr/bin/env node
import { execFile } from "node:child_process"
import { closeSync, existsSync, writeSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { runOnboarding } from "./onboarding.ts"
import { isCancelled } from "./prompts.ts"
import { Providers } from "./providers.ts"
import { ago, summarizeSessions } from "./sessions.ts"
import { type Opened, type Phoenix, Sessions } from "./storage.ts"
import { runApp } from "./tui/app.ts"
import {
  attachEvals,
  builtinTools,
  createEvalTool,
  drainInbox,
  joinSession,
  parseShareLink,
  tailcatForward,
  modelDistiller,
  modelDetector,
  llmDetector,
  decisionDetector,
  DECISION_ACCOUNT,
  type Config,
  type Decider,
  type Detector,
  setSecret,
  deleteSecret,
  shownInTerminal,
  phoenixJudge,
  type ApprovalMode,
  Engine,
  getSecret,
  configProblems,
  hasConfig,
  loadConfig,
  lastModelOf,
  loadSession,
  parseEffort,
  parseApprovals,
  parsePhoenixLink,
  PhoenixClient,
  PhoenixExporter,
  stringAttr,
  OI,
  Redactor,
  splitModel,
  type ModelLayer,
  openBrowser,
  Store,
  type StoreEvent,
} from "@oi-agent/engine"

const HELP = `oi — an agent whose state is OpenInference spans on disk

Usage:
  oi                         Start an interactive session in this directory
  oi resume <session|url>    Continue a session from disk or Phoenix; a Phoenix
                             trace URL continues from that turn
  oi join <share-link>       Join a session someone shared with /share
  oi run <prompt>            Run one prompt and print the answer
  oi sessions                List sessions
  oi show <session>          Print a session's turns
  oi export [session]        Send sessions to the configured Phoenix server
  oi setup                   Choose a model, store keys, connect Phoenix
  oi auth login [provider]   Store a provider's API key in the keychain (default
                             anthropic); \`oi auth login chatgpt\` signs in with
                             a ChatGPT plan in the browser; \`oi auth login
                             typesafe\` stores the decision model's key
  oi auth logout <provider>  Forget a provider's key, or sign out of ChatGPT
  oi where                   Print the directory sessions are stored in

Options:
  -s, --session <id>         Continue a session (id, unique prefix or Phoenix URL)
  -c, --continue             Continue the most recent session
  -m, --model <id>           Model to use, as provider/model or a model of the
                             configured provider (default: claude-opus-5-5)
      --effort <level>       Reasoning effort: low, medium, high, xhigh or max
      --approvals <mode>    Tool approvals: ask, auto or allow (overrides config)
      --yolo                 Run tools that change the machine without asking
      --check                Load every module and exit (what /reload checks first)
  -h, --help                 Show this help
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string", short: "s" },
    continue: { type: "boolean", short: "c", default: false },
    model: { type: "string", short: "m" },
    effort: { type: "string" },
    approvals: { type: "string" },
    yolo: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

// Static imports have all loaded by now, so this process got as far as a reload needs.
if (values.check) process.exit(0)

// What the launcher told this process; removed so that nothing it spawns thinks it has a launcher.
const RELOAD_ENTRY = process.env["OI_AGENT_RELOAD_ENTRY"]
const LAUNCHER_FD = Number(process.env["OI_AGENT_LAUNCHER_FD"] ?? Number.NaN)

// The launcher is this process's parent; if it dies, the parent changes and nobody can restart oi.
const LAUNCHER_PID = process.ppid
const FALLBACK = process.env["OI_AGENT_FALLBACK"]

delete process.env["OI_AGENT_RELOAD_ENTRY"]

delete process.env["OI_AGENT_LAUNCHER_FD"]

delete process.env["OI_AGENT_FALLBACK"]

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// The AI SDK prints deprecation notices from inside phoenix-evals; keep the terminal clean.
process.env["AI_SDK_LOG_WARNINGS"] = "false"

process.removeAllListeners("warning")

const [command, ...rest] = positionals
const firstRun = command === undefined && !values.help && !hasConfig() && process.stdin.isTTY

// Setup runs before the store opens, because it decides where sessions live.
if (command === "setup" || firstRun) {
  await runOnboarding().catch((error: Error) =>
    fail(isCancelled(error) ? "\nSetup cancelled. Nothing was saved." : error.message),
  )

  if (command === "setup") process.exit(0)
}

// The agent's own source and docs sit beside the build output (and beside `src` in a checkout).
const SELF_DIR = fileURLToPath(new URL("../self", import.meta.url))

const store = new Store()

const providers = new Providers()

/** The requested approval mode, checked before any engine starts. */
const approvalChoice = (): Config["approvals"] | undefined => {
  const mode = parseApprovals(values.approvals)

  if (values.approvals !== undefined && mode === undefined)
    fail(`--approvals takes ask, auto or allow, not ${values.approvals}.`)

  return mode
}

const buildEngine = (override?: ApprovalMode): Engine => {
  const base = loadConfig()
  const approvals = override ?? approvalChoice() ?? base.approvals

  // `-m openai/gpt-5.1` picks the provider too; a bare id stays with the configured one.
  const chosen =
    values.model === undefined
      ? base
      : { ...base, ...splitModel(base.providers, values.model, base.provider) }

  const effort = values.effort === undefined ? undefined : parseEffort(values.effort)

  if (values.effort !== undefined && effort === undefined)
    fail(`--effort takes low, medium, high, xhigh or max, not ${values.effort}.`)

  const config = effort === undefined ? chosen : { ...chosen, effort }

  const redactor = new Redactor()
  const decider = deciderFor(config)

  for (const key of providers.keys()) redactor.add(key)

  redactor.add(decider?.apiKey)

  // Keys added in /provider during the session are scrubbed too.
  providers.onKey = (key) => redactor.add(key)

  let model: ModelLayer

  try {
    model = providers.modelFor(config)
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)} (or \`oi auth login\`)`)
  }

  const engine = new Engine({
    store,
    config,
    approvals,
    redactor,
    tools: [...builtinTools, createEvalTool],
    selfDir: existsSync(SELF_DIR) ? SELF_DIR : undefined,
    model,
    modelFor: (settings) => providers.modelFor(settings),
    decider,
  })

  // LLM evaluators judge with an Anthropic model; code evaluators and steering need no key of their own.
  const judgeKey = getSecret("anthropic")
  const steering = steeringSetup(config, redactor)

  attachEvals(engine, {
    store,
    judge: judgeKey === undefined ? noJudge : phoenixJudge(judgeKey, config.judge_model),
    distill: judgeKey === undefined ? noJudge : modelDistiller(judgeKey, config.judge_model),
    detect: steering.detect,
  })

  return engine
}

/** Stands in for the judge without an Anthropic key: the evaluator's span records why it did not run. */
const noJudge = (): Promise<never> =>
  Promise.reject(new Error("LLM evaluators need an Anthropic API key (oi auth login)."))

/** The decision model, when its key is set. */
const deciderFor = (config: Config): Decider | undefined => {
  const apiKey = getSecret(DECISION_ACCOUNT)

  return apiKey === undefined ? undefined : { settings: config.decision, apiKey }
}

/** A model for a background task (steering), or undefined when its provider has no credentials. */
const backgroundModel = (config: Config, spec: string): ModelLayer | undefined => {
  const ref = splitModel(config.providers, spec, "anthropic")

  try {
    return providers.modelFor({ ...config, ...ref, effort: "low", max_tokens: 8192 })
  } catch {
    return undefined
  }
}

/**
 * The detector for an LLM spec. Anthropic models use the detector the
 * steering experiment measured; every other provider gets the same prompt
 * through oi's own model layer.
 */
const llmDetectorFor = (config: Config, spec: string): Detector | undefined => {
  const ref = splitModel(config.providers, spec, "anthropic")
  const anthropicKey = getSecret("anthropic")

  if (ref.provider === "anthropic")
    return anthropicKey === undefined ? undefined : modelDetector(anthropicKey, ref.model)

  const model = backgroundModel(config, spec)

  return model === undefined ? undefined : llmDetector(model)
}

const DECISION_PREFIX = "decision:"

/** The configured steering model; unset means the judge model with an Anthropic key, else the session's own. */
const steeringModelOf = (config: Config): string => {
  if (config.steering_model !== "") return config.steering_model

  return getSecret("anthropic") === undefined ? `${config.provider}/${config.model}` : config.judge_model
}

/** The steering detector to run, or why there is none when steering is on. */
interface SteeringSetup {
  readonly detect?: Detector
  readonly problem?: string
}

/**
 * What reads prompts for durable corrections (`steering_model`), or why
 * nothing can: `provider/model` needs that provider's credentials, and
 * `decision:<model>` needs a TypeSafe key, with the judge model (or else
 * the session's model) writing the evaluators it finds.
 */
const steeringSetup = (config: Config, redactor?: Redactor): SteeringSetup => {
  if (config.steering === "off") return {}

  const spec = steeringModelOf(config)
  const fix = `Fix it, or set "steering_model" to a model you have a key for (or "steering": "off") in the config.`

  if (spec.startsWith(DECISION_PREFIX)) {
    const decider = deciderFor(config)

    if (decider === undefined)
      return {
        problem: `Learning from corrections uses the decision model ${spec}, but there is no TypeSafe API key, so it is not running. Add one with \`oi auth login typesafe\` and restart oi. ${fix}`,
      }

    const writer =
      llmDetectorFor(config, config.judge_model) ??
      llmDetectorFor(config, `${config.provider}/${config.model}`)

    const settings = { ...decider.settings, model: spec.slice(DECISION_PREFIX.length) }

    return { detect: decisionDetector(settings, decider.apiKey, writer, redactor) }
  }

  const detect = llmDetectorFor(config, spec)

  if (detect !== undefined) return { detect }

  const ref = splitModel(config.providers, spec, "anthropic")

  return {
    problem: `Learning from corrections runs on ${ref.provider}/${ref.model}, but ${ref.provider} has no credentials here, so it is not running. Add them with \`oi auth login ${ref.provider}\` (or /provider) and restart oi. ${fix}`,
  }
}

/**
 * Settings that are on but cannot work, shown under the banner like a bad
 * config value, so nothing is silently off.
 */
const inactiveFeatures = (): Array<string> => {
  const config = loadConfig()
  const problems: Array<string> = []
  const steering = steeringSetup(config).problem

  if (steering !== undefined) problems.push(steering)

  if (config.approvals === "auto" && deciderFor(config) === undefined)
    problems.push(
      "Auto approvals need a decision model and there is no TypeSafe API key, so every tool call will ask, as in ask mode. Add one with `oi auth login typesafe` and restart oi.",
    )

  return problems
}

/** Phoenix, for reading sessions back as well as exporting, when an endpoint is configured. */
const connectPhoenix = (): Phoenix | undefined => {
  const { phoenix } = loadConfig()

  if (phoenix.endpoint === "") return undefined

  const target = { ...phoenix, apiKey: getSecret("phoenix") }

  return { exporter: new PhoenixExporter(store, target), client: new PhoenixClient(target) }
}

/** What to open: a session (id, prefix or Phoenix session id), and maybe a turn to continue from. */
interface Target {
  readonly identifier: string
  readonly from?: string | undefined
}

/** A session id, prefix, or Phoenix session or trace URL, as something to open. */
const targetFor = async (text: string, phoenix: Phoenix | undefined): Promise<Target> => {
  const link = parsePhoenixLink(text)

  if (link === undefined) return { identifier: text }

  if (link.kind === "session") return { identifier: link.id }

  const client = phoenix?.client ?? fail("A Phoenix URL needs a Phoenix endpoint. Run `oi setup`.")
  const [root] = await client.spans([link.id], { roots: true, project: link.project })
  const sessionId = root === undefined ? undefined : stringAttr(root, OI.SESSION_ID)

  return {
    identifier: sessionId ?? fail(`Phoenix has no oi-agent turn with trace id ${link.id}.`),
    from: link.id,
  }
}

const initialTarget = async (engine: Engine, phoenix: Phoenix | undefined): Promise<Target> => {
  const named = command === "resume" ? (rest[0] ?? fail("Usage: oi resume <session|url>")) : values.session

  if (named !== undefined) return targetFor(named, phoenix)

  const latest = values.continue ? store.listSessionIds().at(-1) : undefined

  return { identifier: latest ?? engine.createSession(process.cwd()).id }
}

const open = async (sessions: Sessions, target: Target): Promise<Opened> =>
  sessions.open(target.identifier).catch((error: Error) => fail(error.message))

/**
 * Notes for a session written elsewhere, which also stops tools running
 * unasked: its tool output is now part of what the model reads, and the
 * tools run here. Interactively they ask; `oi run` has nobody to ask.
 */
const guard = (engine: Engine, opened: Opened, interactive: boolean): Array<string> => {
  if (!opened.foreign || (engine.approvals !== "allow" && engine.approvals !== "auto"))
    return [...opened.notes]

  engine.setApprovalMode(interactive ? "ask" : "deny")

  return [
    ...opened.notes,
    interactive
      ? "It was written on another machine, so tools ask before running. Tab to change that."
      : "It was written on another machine, so tools that change anything are denied despite yolo or auto mode.",
  ]
}

/**
 * Continue a session on the model, provider and effort it last used, so
 * that resuming it does not quietly swap the model. Returns a note when the
 * model changed, or when the session's model is not available here.
 */
const restoreModel = (engine: Engine, sessionId: string): string | undefined => {
  const last = lastModelOf(store, sessionId)
  const current = engine.config

  if (last === undefined) return undefined

  const sameModel = last.provider === current.provider && last.model === current.model

  if (sameModel && (last.effort === undefined || last.effort === current.effort)) return undefined

  const name = `${last.provider}/${last.model}`

  try {
    engine.configure(last)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    return `This session used ${name}, which is not available (${reason}). Using ${current.provider}/${current.model}.`
  }

  const effort = last.effort === undefined ? "" : ` at effort ${last.effort}`

  return `Continuing on ${name}${effort}, the model this session last used.`
}

/** Restore the session's model unless `-m` chose one for the session this process opened with. */
const modelNotes = (engine: Engine, sessionId: string, first: boolean): Array<string> => {
  if (first && values.model !== undefined) return []

  const note = restoreModel(engine, sessionId)

  return note === undefined ? [] : [note]
}

// --- reload ----------------------------------------------------------------

/** The exit code that tells the launcher a reload was asked for (`EX_TEMPFAIL`). */
const RELOAD_EXIT = 75

/** Under a launcher, the code a reload would start. Without one, /reload cannot work. */
const reloadEntry = Number.isInteger(LAUNCHER_FD) ? RELOAD_ENTRY : undefined

/** Write a line to the launcher, if there is one. */
const tellLauncher = (fields: ReadonlyArray<string>): void => {
  if (!Number.isInteger(LAUNCHER_FD)) return

  try {
    writeSync(LAUNCHER_FD, `${fields.join("\0")}\n`)
  } catch {
    // The launcher is gone; there is nobody to tell.
  }
}

/** The last lines of a failed preflight's output: enough to see the error. */
const PREFLIGHT_LINES = 15

/** Load the code a reload would start, without starting it. Resolves to why it failed. */
const preflight = (entry: string) => (): Promise<string | undefined> =>
  new Promise((resolve) => {
    if (process.ppid !== LAUNCHER_PID)
      return resolve(
        "The launcher that started this oi has exited, so nothing can start it again. Quit, then run oi.",
      )

    execFile(process.execPath, [entry, "--check"], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error === null) return resolve(undefined)

      const output = `${stderr}${stdout}`.trim() || error.message

      const tail = output.split("\n").slice(-PREFLIGHT_LINES).join("\n")

      resolve(`The new code failed the preflight (${entry} --check):\n${tail}`)
    })
  })

/** Tell the launcher the terminal is up. */
const signalReady = (): void => tellLauncher(["ready"])

/**
 * Hand the session to the launcher and exit: it starts the CLI again on the
 * same session, model, effort and approval mode.
 */
const reloadInto = (engine: Engine, sessionId: string): never => {
  const { provider, model, effort } = engine.config
  const args = ["-s", sessionId, "-m", `${provider}/${model}`, "--effort", effort]

  if (engine.approvals !== "deny") args.push("--approvals", engine.approvals)

  if (engine.approvals === "allow") args.push("--yolo")

  tellLauncher(["reload", ...args])
  closeSync(LAUNCHER_FD)

  return process.exit(RELOAD_EXIT)
}

const printEvents =
  (sessionId: string) =>
  (event: StoreEvent): void => {
    if (event.session_id !== sessionId) return

    if (event.type === "delta" && event.delta.k === "text") process.stdout.write(event.delta.d)

    if (event.type === "span_open" && event.span.attributes["openinference.span.kind"] === "TOOL") {
      process.stderr.write(
        `\n\u001B[2m⏵ ${event.span.name} ${String(event.span.attributes["input.value"] ?? "")}\u001B[0m\n`,
      )
    }
  }

const run = async (prompt: string): Promise<void> => {
  // Nobody can answer a question here: auto mode runs what the decision model allows and denies the rest.
  const requested = approvalChoice() ?? loadConfig().approvals
  const auto = !values.yolo && requested === "auto"
  const engine = buildEngine(values.yolo || approvalChoice() === "allow" ? "allow" : auto ? "auto" : "deny")

  engine.onApproval((request) => engine.resolveApproval(request.span_id, "deny"))
  const remote = connectPhoenix()
  const sessions = new Sessions(store, remote)
  const target = await initialTarget(engine, remote)
  const opened = await open(sessions, target)
  const sessionId = opened.sessionId

  const notes = [
    ...configProblems(),
    ...inactiveFeatures(),
    ...modelNotes(engine, sessionId, true),
    ...guard(engine, opened, false),
  ]

  for (const note of notes) process.stderr.write(`\u001B[2m${note}\u001B[0m\n`)

  const unsubscribe = store.subscribe(printEvents(sessionId))
  const phoenix = remote?.exporter
  const stopExport = phoenix?.watch()

  const outcome = await engine.submit(sessionId, {
    text: prompt,
    userId: engine.config.user,
    previous: target.from,
  })

  process.stdout.write("\n")
  await engine.idle(sessionId)

  for (const annotation of store.listAnnotations(sessionId)) {
    if (!outcome.ok || annotation.target.trace_id !== outcome.result.traceId || !shownInTerminal(annotation))
      continue

    const { name, label, explanation } = annotation.annotation

    process.stderr.write(`\u001B[2m◆ eval ${name}: ${label ?? ""} ${explanation ?? ""}\u001B[0m\n`)
  }

  unsubscribe()
  stopExport?.()
  await phoenix?.flush()

  const away = await sessions.putAway(sessionId)

  if (away !== undefined) process.stderr.write(`\u001B[2m${away}\u001B[0m\n`)

  store.close()
  process.stderr.write(`\u001B[2msession ${sessionId}\u001B[0m\n`)

  if (!outcome.ok) fail(`Turn failed: ${outcome.message}`)
}

const sessions = (): void => {
  for (const session of summarizeSessions(store).toReversed()) {
    const title = session.title === "" ? "(empty)" : session.title.slice(0, 60)
    const kept = session.storage === "phoenix" ? "phoenix" : "disk"

    process.stdout.write(
      `${session.id}  ${ago(session.activeMs).padStart(10)}  ${kept.padEnd(7)}  ${String(session.turns).padStart(3)} turns  ${title}\n`,
    )
  }
}

const show = (idOrPrefix: string): void => {
  const id = store.resolveSession(idOrPrefix) ?? fail(`No session matches "${idOrPrefix}".`)

  for (const turn of loadSession(store, id).turns) {
    process.stdout.write(`\n[${turn.state}] ${turn.user_id}> ${turn.input}\n${turn.output ?? ""}\n`)
  }
}

const exporter = (): PhoenixExporter => {
  const { phoenix } = loadConfig()

  if (phoenix.endpoint === "")
    fail("No Phoenix endpoint. Set PHOENIX_COLLECTOR_ENDPOINT or phoenix.endpoint in config.")

  return new PhoenixExporter(store, { ...phoenix, apiKey: getSecret("phoenix") })
}

const exportSessions = async (idOrPrefix: string | undefined): Promise<void> => {
  const phoenix = exporter()

  const ids =
    idOrPrefix === undefined
      ? store.listSessionIds()
      : [store.resolveSession(idOrPrefix) ?? fail(`No session matches "${idOrPrefix}".`)]

  for (const id of ids) phoenix.sweep(id)

  await phoenix.flush()

  const report = phoenix.report()

  process.stdout.write(`Sent ${report.spans} spans and ${report.annotations} annotations.\n`)

  if (report.errors.length > 0) fail(report.errors.join("\n"))
}

const interactive = async (): Promise<void> => {
  const engine = buildEngine(values.yolo ? "allow" : undefined)
  const remote = connectPhoenix()
  const sessions = new Sessions(store, remote)
  let target: Target | undefined = await initialTarget(engine, remote)
  let opened = await open(sessions, target)

  // Shown under the banner of the first session opened, with why this is the bundled build if a reload failed.
  let problems =
    FALLBACK === undefined
      ? [...configProblems(), ...inactiveFeatures()]
      : [FALLBACK, ...configProblems(), ...inactiveFeatures()]

  let first = true
  let reloading: string | undefined

  // Listed in the background for /model and effort cycling; a provider that fails just has no list.
  void providers.refresh()

  // `/resume` and `/new` end the app with the session to open next.
  while (target !== undefined) {
    const sessionId = opened.sessionId

    drainInbox(engine, sessionId)

    const notes = [...problems, ...modelNotes(engine, sessionId, first), ...guard(engine, opened, true)]

    first = false

    const exit = await runApp({
      store,
      sessionId,
      user: engine.config.user,
      label: `${engine.config.provider}/${engine.config.model}`,
      engine,
      phoenix: remote?.exporter,
      sessions,
      from: target.from,
      notes,
      providers,
      reload: reloadEntry === undefined ? undefined : preflight(reloadEntry),
      onStart: signalReady,
    })

    problems = []

    // A reload keeps the session where it is: the next process opens it again.
    if (exit.reload) {
      reloading = sessionId
      break
    }

    const away = await sessions.putAway(sessionId)

    if (away !== undefined) process.stdout.write(`\u001B[2m${away}\u001B[0m\n`)

    target = exit.next === undefined ? undefined : { identifier: exit.next }

    if (target === undefined) break

    // A session that cannot be opened (Phoenix is down, say) returns you to the one you left.
    const failed = await sessions.open(target.identifier).then(
      (session) => {
        opened = session

        return undefined
      },
      (error: Error) => error.message,
    )

    if (failed !== undefined) {
      process.stdout.write(`\u001B[33m${failed}\u001B[0m\n`)
      target = { identifier: sessionId }
      opened = await open(sessions, target)
    }
  }

  if (reloading !== undefined) await engine.idle(reloading)

  store.close()

  if (reloading !== undefined) reloadInto(engine, reloading)
}

const join = async (text: string): Promise<void> => {
  const link = parseShareLink(text) ?? fail("That is not a share link. It should start with oi-share:")
  const direct = link.address.startsWith("http")
  const tunnel = direct ? undefined : await tailcatForward(link.address, link.port)
  const base = tunnel === undefined ? `${link.address}:${link.port}` : `http://${tunnel.value}`
  const user = loadConfig().user
  const peer = await joinSession(store, base, link.token, user)

  await runApp({
    store,
    sessionId: peer.sessionId,
    user,
    label: `joined ${peer.info.host}'s session as ${peer.info.role}`,
    peer,
  })
  tunnel?.stop()
  store.close()
}

/** The first line of standard input (a pasted key), without echoing anything else. */
const readLine = async (): Promise<string> => {
  let text = ""

  for await (const chunk of process.stdin) {
    text += Buffer.from(chunk).toString("utf8")

    if (text.includes("\n")) break
  }

  return text.split("\n")[0]?.trim() ?? ""
}

const authLogin = async (id: string): Promise<void> => {
  // The decision model's key is not a chat provider's: it has no models to pick in /model.
  if (id === DECISION_ACCOUNT) {
    process.stderr.write("Paste your TypeSafe API key and press return: ")

    const key = await readLine()

    if (key === "") fail("No key given. Nothing was stored.")

    if (!setSecret(DECISION_ACCOUNT, key)) fail("The system keychain did not accept the key.")

    process.stderr.write(
      'Stored in the system keychain. Use it with "approvals": "auto" or "steering_model": "decision:jev-latest".\n',
    )

    return
  }

  const provider =
    providers.find(id) ?? fail(`No provider named ${id}. Built in: anthropic, openai, chatgpt.`)

  if (provider.kind === "chatgpt") {
    const account = await providers
      .login((url) => {
        openBrowser(url)
        process.stderr.write(`Sign in with ChatGPT in your browser. If it did not open, visit:\n${url}\n`)
      })
      .catch((error: Error) => fail(error.message))

    process.stderr.write(`Signed in to ChatGPT as ${account}. Use it with: oi -m chatgpt/<model>\n`)

    return
  }

  process.stderr.write(`Paste your ${provider.name} API key and press return: `)

  const failed = providers.setKey(provider.id, await readLine())

  if (failed !== undefined) fail(failed)

  process.stderr.write("Stored in the system keychain.\n")
}

const authLogout = async (id: string): Promise<void> => {
  if (id === DECISION_ACCOUNT) {
    if (!deleteSecret(DECISION_ACCOUNT)) fail("There was no TypeSafe key in the keychain.")

    process.stderr.write("Removed the TypeSafe key from the keychain.\n")

    return
  }

  const failed = await providers.forget(id)

  if (failed !== undefined) fail(failed)

  process.stderr.write(
    id === "chatgpt" ? "Signed out of ChatGPT.\n" : `Removed ${id}'s key from the keychain.\n`,
  )
}

if (values.help) {
  process.stdout.write(HELP)
} else if (command === undefined || command === "resume") {
  await interactive()
} else if (command === "join") {
  await join(rest[0] ?? fail("Usage: oi join <share-link>"))
} else if (command === "run") {
  await run(rest.join(" ") || fail("Usage: oi run <prompt>"))
} else if (command === "sessions") {
  sessions()
} else if (command === "show") {
  show(rest[0] ?? fail("Usage: oi show <session>"))
} else if (command === "export") {
  await exportSessions(rest[0])
} else if (command === "auth" && rest[0] === "login") {
  await authLogin(rest[1] ?? "anthropic")
} else if (command === "auth" && rest[0] === "logout") {
  await authLogout(rest[1] ?? fail("Usage: oi auth logout <provider>"))
} else if (command === "where") {
  process.stdout.write(`${store.sessionsDir}\n`)
} else {
  fail(`Unknown command: ${command}\n\n${HELP}`)
}
