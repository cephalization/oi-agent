#!/usr/bin/env node
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { runOnboarding } from "./onboarding.ts"
import { isCancelled } from "./prompts.ts"
import { ago, summarizeSessions } from "./sessions.ts"
import { type Opened, type Phoenix, Sessions } from "./storage.ts"
import { runApp } from "./tui/app.ts"
import {
  anthropicModel,
  attachEvals,
  builtinTools,
  createEvalTool,
  drainInbox,
  joinSession,
  parseShareLink,
  tailcatForward,
  modelDistiller,
  phoenixJudge,
  type ApprovalMode,
  checkModel,
  type Config,
  listModels,
  type ModelOption,
  Engine,
  getSecret,
  hasConfig,
  loadConfig,
  loadSession,
  parsePhoenixLink,
  PhoenixClient,
  PhoenixExporter,
  stringAttr,
  OI,
  Redactor,
  setSecret,
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
  oi auth login              Store an Anthropic API key in the keychain
  oi where                   Print the directory sessions are stored in

Options:
  -s, --session <id>         Continue a session (id, unique prefix or Phoenix URL)
  -c, --continue             Continue the most recent session
  -m, --model <id>           Model to use (default from config: claude-opus-5-5)
      --yolo                 Run tools that change the machine without asking
  -h, --help                 Show this help
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    session: { type: "string", short: "s" },
    continue: { type: "boolean", short: "c", default: false },
    model: { type: "string", short: "m" },
    yolo: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
})

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

const buildEngine = (override?: ApprovalMode): Engine => {
  const base = loadConfig()
  const approvals = override ?? base.approvals
  const config = values.model === undefined ? base : { ...base, model: values.model }
  const apiKey = getSecret("anthropic") ?? fail("No Anthropic API key found. Run `oi auth login`.")
  const redactor = new Redactor()

  redactor.add(apiKey)

  const modelFor = (settings: Config) =>
    anthropicModel({
      model: settings.model,
      effort: settings.effort,
      maxTokens: settings.max_tokens,
      apiKey,
    })

  const engine = new Engine({
    store,
    config,
    approvals,
    redactor,
    tools: [...builtinTools, createEvalTool],
    selfDir: existsSync(SELF_DIR) ? SELF_DIR : undefined,
    model: modelFor(config),
    modelFor,
  })

  attachEvals(engine, {
    store,
    judge: phoenixJudge(apiKey, config.judge_model),
    distill: modelDistiller(apiKey, config.judge_model),
  })

  return engine
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
  if (!opened.foreign || engine.approvals !== "allow") return [...opened.notes]

  engine.setApprovalMode(interactive ? "ask" : "deny")

  return [
    ...opened.notes,
    interactive
      ? "It was written on another machine, so tools ask before running. Tab to change that."
      : "It was written on another machine, so tools that change anything are denied despite --yolo.",
  ]
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
  const engine = buildEngine(values.yolo ? "allow" : "deny")
  const remote = connectPhoenix()
  const sessions = new Sessions(store, remote)
  const target = await initialTarget(engine, remote)
  const opened = await open(sessions, target)
  const sessionId = opened.sessionId

  for (const note of guard(engine, opened, false)) process.stderr.write(`\u001B[2m${note}\u001B[0m\n`)

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
    if (!outcome.ok || annotation.target.trace_id !== outcome.result.traceId) continue

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
  const catalog: Array<ModelOption> = []

  // Listed in the background for /model and effort cycling; offline just means no list.
  listModels(getSecret("anthropic") ?? "")
    .then((list) => catalog.push(...list))
    .catch(() => undefined)

  // `/resume` and `/new` end the app with the session to open next.
  while (target !== undefined) {
    const sessionId = opened.sessionId

    drainInbox(engine, sessionId)

    const next = await runApp({
      store,
      sessionId,
      user: engine.config.user,
      label: engine.config.model,
      engine,
      phoenix: remote?.exporter,
      sessions,
      from: target.from,
      notes: guard(engine, opened, true),
      models: () => catalog,
      checkModel: (id) => checkModel(getSecret("anthropic") ?? "", id),
    })

    const away = await sessions.putAway(sessionId)

    if (away !== undefined) process.stdout.write(`\u001B[2m${away}\u001B[0m\n`)

    target = next === undefined ? undefined : { identifier: next }

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

  store.close()
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

const authLogin = async (): Promise<void> => {
  process.stderr.write("Paste your Anthropic API key and press return: ")

  const chunks: Array<Buffer> = []

  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))

  const key = Buffer.concat(chunks).toString("utf8").trim()

  if (key === "" || !setSecret("anthropic", key)) fail("Could not store the key.")

  process.stderr.write("Stored in the system keychain.\n")
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
  await authLogin()
} else if (command === "where") {
  process.stdout.write(`${store.sessionsDir}\n`)
} else {
  fail(`Unknown command: ${command}\n\n${HELP}`)
}
