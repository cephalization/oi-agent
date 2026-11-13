#!/usr/bin/env node
import { parseArgs } from "node:util"
import {
  anthropicModel,
  type ApprovalMode,
  Engine,
  getSecret,
  loadConfig,
  loadSession,
  PhoenixExporter,
  Redactor,
  setSecret,
  Store,
  type StoreEvent,
} from "@oi-agent/engine"

const HELP = `oi — an agent whose state is OpenInference spans on disk

Usage:
  oi run <prompt>            Run one prompt and print the answer
  oi sessions                List sessions
  oi show <session>          Print a session's turns
  oi export [session]        Send sessions to the configured Phoenix server
  oi auth login              Store an Anthropic API key in the keychain
  oi where                   Print the directory sessions are stored in

Options:
  -s, --session <id>         Continue a session (id or unique prefix)
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

const store = new Store()

const buildEngine = (approvals: ApprovalMode): Engine => {
  const base = loadConfig(store.home)
  const config = values.model === undefined ? base : { ...base, model: values.model }
  const apiKey = getSecret("anthropic") ?? fail("No Anthropic API key found. Run `oi auth login`.")
  const redactor = new Redactor()

  redactor.add(apiKey)

  return new Engine({
    store,
    config,
    approvals,
    redactor,
    model: anthropicModel({
      model: config.model,
      effort: config.effort,
      maxTokens: config.max_tokens,
      apiKey,
    }),
  })
}

const pickSession = (engine: Engine): string => {
  if (values.session !== undefined) {
    return store.resolveSession(values.session) ?? fail(`No session matches "${values.session}".`)
  }

  const latest = values.continue ? store.listSessionIds().at(-1) : undefined

  return latest ?? engine.createSession(process.cwd()).id
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
  const sessionId = pickSession(engine)
  const unsubscribe = store.subscribe(printEvents(sessionId))
  const phoenix = engine.config.phoenix.endpoint === "" ? undefined : exporter()
  const stopExport = phoenix?.watch()
  const outcome = await engine.submit(sessionId, { text: prompt, userId: engine.config.user })

  unsubscribe()
  stopExport?.()
  await phoenix?.flush()
  store.close()
  process.stdout.write("\n")
  process.stderr.write(`\u001B[2msession ${sessionId}\u001B[0m\n`)

  if (!outcome.ok) fail(`Turn failed: ${outcome.message}`)
}

const sessions = (): void => {
  for (const id of store.listSessionIds()) {
    const view = loadSession(store, id)
    const title = view.turns[0]?.input.split("\n")[0]?.slice(0, 60) ?? "(empty)"

    process.stdout.write(`${id}  ${String(view.turns.length).padStart(3)} turns  ${title}\n`)
  }
}

const show = (idOrPrefix: string): void => {
  const id = store.resolveSession(idOrPrefix) ?? fail(`No session matches "${idOrPrefix}".`)

  for (const turn of loadSession(store, id).turns) {
    process.stdout.write(`\n[${turn.state}] ${turn.user_id}> ${turn.input}\n${turn.output ?? ""}\n`)
  }
}

const exporter = (): PhoenixExporter => {
  const { phoenix } = loadConfig(store.home)

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

const authLogin = async (): Promise<void> => {
  process.stderr.write("Paste your Anthropic API key and press return: ")

  const chunks: Array<Buffer> = []

  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))

  const key = Buffer.concat(chunks).toString("utf8").trim()

  if (key === "" || !setSecret("anthropic", key)) fail("Could not store the key.")

  process.stderr.write("Stored in the system keychain.\n")
}

const [command, ...rest] = positionals

if (values.help || command === undefined) {
  process.stdout.write(HELP)
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
