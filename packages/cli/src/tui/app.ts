/**
 * The interactive terminal application.
 *
 * It renders a session from store events and sends prompts to whoever runs
 * the session: the local engine when hosting, or the host when joined as a
 * peer. Everything else here is input handling and slash commands.
 */
import {
  type ApprovalRequest,
  chatgptAccount,
  type Engine,
  type ModelChoice,
  type ModelRef,
  openBrowser,
  splitModel,
  type ModelOption,
  formatBytes,
  formatShareLink,
  listRuleVersions,
  loadEvals,
  type PeerConnection,
  type PeerServer,
  type PhoenixExporter,
  type ProviderConfig,
  readRules,
  revertRules,
  servePeers,
  type Store,
  tailcatServe,
  type Tunnel,
} from "@oi-agent/engine"
import { homedir } from "node:os"
import { ago, type SessionSummary, summarizeSessions } from "../sessions.ts"
import type { Providers, ServerForm } from "../providers.ts"
import type { Sessions } from "../storage.ts"
import { clip, control, style, width, wrap } from "./ansi.ts"
import {
  accept,
  type Command,
  COMMANDS,
  complete,
  type Completion,
  findCommand,
  helpLines,
  onEnter,
  type Suggestion,
} from "./commands.ts"
import { Editor } from "./editor.ts"
import { effortsFor, fitEffort, nextEffort } from "./modes.ts"
import { Screen } from "./screen.ts"
import { compact, Transcript } from "./transcript.ts"

export interface AppOptions {
  readonly store: Store
  readonly sessionId: string
  readonly user: string
  /** Shown in the status line: the model when hosting, the host when joined. */
  readonly label: string
  /** Present when this process runs the session. */
  readonly engine?: Engine | undefined
  /** Present when this process joined someone else's session. */
  readonly peer?: PeerConnection | undefined
  readonly phoenix?: PhoenixExporter | undefined
  /** Providers and their models, for `/model`, `/provider` and effort cycling. */
  readonly providers?: Providers | undefined
  /** Sessions on disk and in Phoenix, for `/resume`. Without it, only those on disk. */
  readonly sessions?: Sessions | undefined
  /** A turn to continue from instead of the latest one, for the first prompt only. */
  readonly from?: string | undefined
  /** Shown under the banner when the session opens. */
  readonly notes?: ReadonlyArray<string> | undefined
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Rows the completion menu shows at once. */
const MENU_ROWS = 8

const UP = "\u001B[A"
const DOWN = "\u001B[B"
const SHIFT_TAB = "\u001B[Z"

const SHARE_ARGUMENTS: ReadonlyArray<Suggestion> = [
  { value: "local", label: "local", hint: "share on this machine only, without a tunnel" },
]

const TOUR =
  "Give me a short tour of how you work, using this session as the example. Read your guide first, then show me the real files: what a turn looks like on disk, and what you actually sent the model. Keep it brief and offer where to go deeper."

interface Question {
  readonly label: string
  /** Shown as dots, and kept out of history. */
  readonly secret: boolean
  value: string
  readonly answer: (value: string | undefined) => void
}

/** A list the user picks from with the arrows (the /provider menus). */
interface Picker {
  readonly title: string
  readonly items: ReadonlyArray<Suggestion>
  selected: number
  readonly answer: (value: string | undefined) => void
}

interface Share {
  readonly server: PeerServer
  readonly tunnel: Tunnel
}

class App {
  private readonly options: AppOptions
  private readonly screen = new Screen(process.stdout)
  private readonly editor = new Editor()
  private readonly transcript: Transcript
  private readonly approvals: Array<ApprovalRequest> = []
  private share: Share | undefined
  private notice = ""
  private frame = 0
  /** Highlighted row of the completion menu. */
  private selected = 0
  /** Input the user closed the menu on; it stays closed until the input changes. */
  private dismissed: string | undefined
  /** Read once per menu opening: listing sessions reads every root span. */
  private sessions: ReadonlyArray<SessionSummary> | undefined
  /** Phoenix is being asked for its sessions. */
  private listing = false
  /** A session is moving between this disk and Phoenix. */
  private moving = false
  /** The turn the next prompt continues from, when not the latest. */
  private from: string | undefined
  /** A question the input line is answering instead of taking a prompt (an API key, say). */
  private question: Question | undefined
  /** A menu the keys move through instead of editing the prompt. */
  private picker: Picker | undefined
  /** Ends the app. With a session id, the caller should open that session next. */
  private done: (next?: string) => void = () => undefined

  constructor(options: AppOptions) {
    this.options = options
    this.from = options.from
    this.transcript = new Transcript(this.screen, options.user)
  }

  // --- completion ---------------------------------------------------------

  /** Commands this terminal can run: a joined peer cannot run host-only ones. */
  private get commands(): ReadonlyArray<Command> {
    return this.options.engine === undefined ? COMMANDS.filter((command) => !command.hostOnly) : COMMANDS
  }

  private listSessions(): ReadonlyArray<SessionSummary> {
    const { sessions, store } = this.options

    if (this.sessions !== undefined) return this.sessions

    this.sessions = sessions?.all() ?? summarizeSessions(store)

    // Phoenix answers later; the menu fills in when it does.
    if (sessions?.connected === true && !this.listing) {
      this.listing = true
      void sessions.refresh().then((error) => {
        this.listing = false

        if (error !== undefined) this.notice = `Could not list Phoenix sessions: ${error}`

        if (this.sessions !== undefined) this.sessions = sessions.all()

        this.draw()
      })
    }

    return this.sessions
  }

  /** Sessions the picker offers, in the order it shows them. */
  private pickable(): Array<SessionSummary> {
    // Sessions with no turns are launches that never sent a prompt.
    return this.listSessions().filter((session) => session.id !== this.options.sessionId && session.turns > 0)
  }

  private sessionSuggestions(): Array<Suggestion> {
    const here = this.cwd()

    return this.pickable().map((session) => {
      const where = session.cwd === "" || session.cwd === here ? [] : [session.cwd.replace(homedir(), "~")]
      const turns = `${session.turns} turn${session.turns === 1 ? "" : "s"}`
      const kept = session.storage === "phoenix" ? ["in Phoenix"] : []

      return {
        value: session.id,
        label: session.title === "" ? "(untitled)" : session.title,
        hint: [...kept, ago(session.activeMs), turns, ...where].join(" · "),
        keywords: `${session.cwd} ${kept.join("")}`,
      }
    })
  }

  /** Tab in the /resume menu: keep the highlighted session on disk or only in Phoenix. */
  private toggleStorage(id: string): void {
    const { sessions } = this.options
    const session = this.listSessions().find((entry) => entry.id === id)

    if (sessions === undefined || session === undefined || this.moving) return

    this.moving = true
    this.notice =
      session.storage === "phoenix"
        ? `Downloading ${id.slice(0, 13)}…`
        : `Moving ${id.slice(0, 13)} to Phoenix…`

    void sessions.toggle(session).then((message) => {
      this.moving = false
      this.notice = message
      this.sessions = sessions.all()
      this.draw()
    })
  }

  private catalog(): ReadonlyArray<ModelOption> {
    return this.options.providers?.catalog ?? []
  }

  /** The model in use, as `/model` takes it. */
  private currentRef(): ModelRef | undefined {
    const config = this.options.engine?.config

    return config === undefined ? undefined : { provider: config.provider, model: config.model }
  }

  private modelSuggestions(): Array<Suggestion> {
    const current = this.currentRef()

    return this.catalog().map((option) => {
      const efforts = option.efforts.length === 0 ? "no effort setting" : `effort ${option.efforts.join(" ")}`
      const here = option.provider === current?.provider && option.id === current.model

      return {
        value: `${option.provider}/${option.id}`,
        label: `${option.provider}/${option.id}`,
        hint: `${here ? "current · " : ""}${option.name} · ${efforts}`,
        keywords: option.name,
      }
    })
  }

  private argumentsFor(command: Command): ReadonlyArray<Suggestion> {
    if (command.name === "/resume") return this.sessionSuggestions()

    if (command.name === "/model") return this.modelSuggestions()

    if (command.name === "/share") return SHARE_ARGUMENTS

    return []
  }

  private completion(): Completion | undefined {
    const { text, cursor } = this.editor

    if (text === this.dismissed || this.approvals.length > 0) return undefined

    const result = complete(text, cursor, this.commands, (command) => this.argumentsFor(command))

    if (result === undefined) this.sessions = undefined

    return result
  }

  private highlighted(completion: Completion): number {
    return Math.min(this.selected, completion.items.length - 1)
  }

  private menuLines(items: ReadonlyArray<Suggestion>, selected: number): Array<string> {
    const start = Math.max(0, Math.min(selected - Math.floor(MENU_ROWS / 2), items.length - MENU_ROWS))
    const visible = items.slice(start, start + MENU_ROWS)
    const labelWidth = Math.min(Math.max(...visible.map((item) => width(item.label))), 48)
    const hintWidth = this.screen.columns - labelWidth - 6

    const lines = visible.map((item, index) => {
      const active = start + index === selected
      const label = clip(item.label, labelWidth)
      const padded = `${label}${" ".repeat(Math.max(labelWidth - width(label), 0))}`
      const hint = hintWidth > 8 ? style.gray(clip(item.hint, hintWidth)) : ""

      return `${active ? style.cyan("❯") : " "} ${active ? style.cyan(padded) : padded}  ${hint}`
    })

    if (items.length > MENU_ROWS) lines.push(style.gray(`  ${selected + 1} of ${items.length}`))

    return lines
  }

  /**
   * Handle a key the open menu owns: tab and enter accept, arrows move, esc
   * closes. Returns false when the key should go to the editor instead.
   */
  private menuKey(key: string, completion: Completion): boolean {
    const index = this.highlighted(completion)
    const item = completion.items[index]
    const count = completion.items.length

    if (item === undefined) return false

    if (key === "\t" && completion.command?.name === "/resume") {
      this.toggleStorage(item.value)

      return true
    }

    if (key === "\t") {
      this.editor.set(accept(this.editor.text, completion, item))
      this.selected = 0

      return true
    }

    if (key === UP || key === SHIFT_TAB || key === DOWN) {
      this.selected = (index + (key === DOWN ? 1 : -1) + count) % count

      return true
    }

    if (key === "\u001B") {
      this.dismissed = this.editor.text

      return true
    }

    if (key !== "\r") return false

    const action = onEnter(this.editor.text, completion, item)

    if (action.type === "submit") return false

    this.editor.set(action.text)
    this.selected = 0

    // Through the editor, so the line lands in history like a typed one.
    const sent = action.type === "send" ? this.editor.feed("\r") : undefined

    if (sent?.type === "submit") this.submit(sent.text)

    return true
  }

  // --- drawing ------------------------------------------------------------

  private status(): string {
    const { transcript, options } = this
    const engine = options.engine
    const ref = this.currentRef()

    const label =
      ref === undefined
        ? options.label
        : ref.provider === "anthropic"
          ? ref.model
          : `${ref.provider}/${ref.model}`

    const parts = [style.gray(label)]
    // Dropped last-added first when the line is wider than the terminal.
    const optional: Array<string> = []

    const add = (part: string, droppable: boolean): void => {
      parts.push(part)

      if (droppable) optional.push(part)
    }

    if (engine !== undefined) {
      if (ref !== undefined && effortsFor(this.catalog(), ref).length > 0) {
        add(style.gray(`effort ${engine.config.effort}`), false)
      }

      add(engine.approvals === "allow" ? style.yellow("⏵⏵ yolo") : style.gray("ask before tools"), false)
    }

    if (this.share !== undefined) {
      const peers = this.share.server.peers()

      add(style.green(`● shared${peers.length === 0 ? "" : ` with ${peers.join(", ")}`}`), false)
    }

    if (transcript.totalTokens > 0) add(style.gray(`${compact(transcript.totalTokens)} tokens`), true)

    if (transcript.sessionBytes > 0) add(style.gray(formatBytes(transcript.sessionBytes)), true)

    if (options.phoenix !== undefined) add(style.gray("→ phoenix"), true)

    if (transcript.running) {
      const spinner = SPINNER[this.frame % SPINNER.length] ?? ""

      const hint = style.gray("esc to interrupt")

      parts.unshift(style.cyan(`${spinner} working ${transcript.elapsedSeconds}s`))
      parts.push(hint)
      // The interrupt hint goes last: it matters most while a turn runs.
      optional.unshift(hint)
    }

    const separator = style.gray(" · ")
    const line = (): string => parts.join(separator)

    for (const part of optional.toReversed()) {
      if (width(line()) < this.screen.columns) break

      parts.splice(parts.indexOf(part), 1)
    }

    return line()
  }

  private approvalLines(request: ApprovalRequest): Array<string> {
    const input = clip(JSON.stringify(request.input), this.screen.columns * 3)

    return [
      `${style.yellow("?")} ${style.bold(`Allow ${request.tool}`)}${request.user_id === this.options.user ? "" : style.yellow(` (requested by ${request.user_id})`)}`,
      style.gray(`  ${input}`),
      `  ${style.bold("y")} yes   ${style.bold("n")} no   ${style.bold("a")} always allow in this session`,
    ]
  }

  private draw(): void {
    const lines = this.transcript.live()
    const approval = this.approvals[0]

    if (lines.length > 0) lines.push("")

    if (approval !== undefined) {
      const prompt = this.approvalLines(approval)

      this.screen.render({
        lines: [...lines, ...prompt],
        cursor: { line: lines.length + prompt.length - 1, column: 1 },
      })

      return
    }

    lines.push(this.status())

    if (this.notice !== "") lines.push(style.yellow(this.notice))

    const question = this.question

    if (question !== undefined) {
      const shown = question.secret ? "•".repeat(question.value.length) : question.value
      const line = `${style.cyan("?")} ${question.label}: ${shown}`

      this.screen.render({ lines: [...lines, line], cursor: { line: lines.length, column: width(line) } })

      return
    }

    const picker = this.picker

    if (picker !== undefined) {
      const title = `${style.cyan("?")} ${picker.title} ${style.gray("· enter to choose, esc to go back")}`

      this.screen.render({
        lines: [...lines, title, ...this.menuLines(picker.items, picker.selected)],
        cursor: { line: lines.length, column: 1 },
      })

      return
    }

    const canPrompt = this.options.peer === undefined || this.options.peer.info.role === "driver"
    const before = this.editor.text.slice(0, this.editor.cursor).split("\n")
    const input = this.editor.text.split("\n")
    const first = lines.length

    const completion = this.completion()
    const item = completion === undefined ? undefined : completion.items[this.highlighted(completion)]

    // The rest of the highlighted suggestion, dimmed after the cursor.
    const ghost =
      completion?.kind === "command" && item?.value.startsWith(completion.token) === true
        ? style.gray(item.value.slice(completion.token.length))
        : ""

    for (const [index, line] of input.entries()) {
      lines.push(`${index === 0 ? style.cyan(canPrompt ? "›" : "◦") : " "} ${line}`)
    }

    if (!canPrompt && this.editor.text === "") lines[first] = `${style.gray("◦ view only")} `

    lines[lines.length - 1] += ghost

    const cursorLine = first + before.length - 1

    if (completion !== undefined)
      lines.push(...this.menuLines(completion.items, this.highlighted(completion)))

    this.screen.render({
      lines,
      cursor: { line: cursorLine, column: 3 + width(before.at(-1) ?? "") },
    })
  }

  private say(lines: ReadonlyArray<string>): void {
    this.screen.commit(lines.map((line) => style.gray(line)))
  }

  // --- commands -----------------------------------------------------------

  private async startShare(local: boolean): Promise<void> {
    const { engine, sessionId } = this.options

    if (engine === undefined) return this.say(["Only the host can share a session."])

    if (this.share !== undefined) return this.printShare(this.share)

    this.notice = "opening a tailcat tunnel…"
    this.draw()

    const server = await servePeers(engine, sessionId)

    try {
      // A local share skips the tunnel: useful on one machine or a trusted network.
      const tunnel = local
        ? { value: "http://127.0.0.1", stop: () => undefined }
        : await tailcatServe(server.port)

      this.share = { server, tunnel }
      this.printShare(this.share)
    } catch (error) {
      await server.close()
      this.say([error instanceof Error ? error.message : String(error)])
    }

    this.notice = ""
  }

  private printShare(share: Share): void {
    const link = (token: string): string =>
      formatShareLink({ address: share.tunnel.value, port: share.server.port, token })

    this.screen.commit([
      "",
      style.green("● This session is shared."),
      "",
      `${style.bold("Drive")} (can send prompts; tool approvals stay with you):`,
      `  oi join ${link(share.server.tokens.driver)}`,
      "",
      `${style.bold("View")} (read-only):`,
      `  oi join ${link(share.server.tokens.viewer)}`,
      "",
      style.gray("Anyone with a link can read this session. /unshare closes it."),
      "",
    ])
  }

  private async stopShare(): Promise<void> {
    if (this.share === undefined) return this.say(["This session is not shared."])

    this.share.tunnel.stop()
    await this.share.server.close()
    this.share = undefined
    this.say(["Sharing stopped."])
  }

  private cwd(): string {
    return this.options.store.readHeader(this.options.sessionId)?.cwd ?? process.cwd()
  }

  private async exportNow(): Promise<void> {
    const { phoenix, sessionId } = this.options

    if (phoenix === undefined) return this.say(["No Phoenix endpoint is configured."])

    phoenix.sweep(sessionId)
    await phoenix.flush()

    const report = phoenix.report()

    this.say([
      `Sent ${report.spans} spans and ${report.annotations} annotations to Phoenix.`,
      ...report.errors,
    ])
  }

  /** Switch this terminal to another session. The app restarts on it. */
  private resume(argument: string): void {
    const { store, sessionId } = this.options

    if (argument === "") {
      // Bare /resume opens the picker rather than guessing.
      this.dismissed = undefined
      this.editor.set("/resume ")

      return
    }

    if (this.transcript.running) return this.say(["A turn is running. Press esc to interrupt it first."])

    const id = this.options.sessions?.resolve(argument) ?? store.resolveSession(argument)

    if (id === undefined) return this.say([`No session matches "${argument}".`])

    if (id === sessionId) return this.say(["That is this session."])

    this.done(id)
  }

  /** Tab: ask before tools, or run them unasked. */
  private toggleApprovals(): void {
    const engine = this.options.engine

    engine?.setApprovalMode(engine.approvals === "allow" ? "ask" : "allow")
  }

  /** Shift+Tab: the next effort level the current model accepts. */
  private cycleEffort(): void {
    const engine = this.options.engine

    if (engine === undefined) return

    const ref = { provider: engine.config.provider, model: engine.config.model }
    const next = nextEffort(engine.config.effort, effortsFor(this.catalog(), ref))

    if (next === undefined) {
      this.notice = `${engine.config.model} has no reasoning effort setting.`

      return
    }

    this.notice = this.configure({ effort: next }) ?? ""
  }

  private async switchModel(argument: string): Promise<void> {
    const engine = this.options.engine

    if (engine === undefined) return

    if (argument === "") {
      this.dismissed = undefined
      this.editor.set("/model ")

      return
    }

    const catalog = this.catalog()
    const providers = this.options.providers
    const ref = splitModel(providers?.configured() ?? [], argument, engine.config.provider)
    const name = `${ref.provider}/${ref.model}`

    // Not in the list (or the list never loaded): ask the provider before switching.
    if (!catalog.some((option) => option.provider === ref.provider && option.id === ref.model)) {
      const verdict = await (providers?.check(ref.provider, ref.model) ?? Promise.resolve(ref.model)).then(
        () => undefined,
        (error: Error) => error.message,
      )

      if (verdict !== undefined) return this.say([`Could not switch to ${name}: ${verdict}`])
    }

    const previous = engine.config.effort
    const before = engine.config.provider
    const levels = effortsFor(catalog, ref)
    const effort = fitEffort(previous, levels)
    const changed = effort !== undefined && effort !== previous
    const failed = this.configure(effort === undefined ? ref : { ...ref, effort })

    if (failed !== undefined) return this.say([`Could not switch to ${name}: ${failed}`])

    const crossing = ref.provider !== before

    this.say(
      [
        `Model is now ${name}${changed ? `, at effort ${effort} (it does not accept ${previous})` : ""}.`,
        crossing
          ? `The conversation carries over to ${ref.provider} as text, tool calls and results; reasoning from ${before} does not.`
          : "",
        this.transcript.running ? "The running turn keeps the old model; the next one uses this." : "",
      ].filter((line) => line !== ""),
    )
  }

  /** Change model settings. Resolves to why it could not, if it could not. */
  private configure(choice: ModelChoice): string | undefined {
    try {
      this.options.engine?.configure(choice)

      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Ask for a line of input (an API key, say). Resolves to undefined on esc. */
  private ask(label: string, secret: boolean, initial = ""): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.question = {
        label,
        secret,
        value: initial,
        answer: (value) => {
          this.question = undefined
          resolve(value)
          this.draw()
        },
      }
      this.draw()
    })
  }

  private answerQuestion(data: string): void {
    const question = this.question

    if (question === undefined) return

    if (data === "\r") return question.answer(question.value.trim())

    if (data === "\u001B" || data === "\u0003") return question.answer(undefined)

    // Held backspace can arrive as several in one chunk.
    if (/^[\u007F\b]+$/.test(data)) {
      question.value = question.value.slice(0, -data.length)

      return this.draw()
    }

    // Typed or pasted text; paste markers and other escape sequences are dropped.
    const text = data
      .replaceAll("\u001B[200~", "")
      .replaceAll("\u001B[201~", "")
      // oxlint-disable-next-line no-control-regex
      .replaceAll(/\u001B\[[0-9;]*[A-Za-z~]/g, "")
      .replaceAll(/[\r\n]/g, "")

    // oxlint-disable-next-line no-control-regex
    if (!/[\u0000-\u001F\u007F]/.test(text)) question.value += text

    this.draw()
  }

  /** Show a menu and wait for a choice. Resolves to undefined on esc. */
  private pick(title: string, items: ReadonlyArray<Suggestion>): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.picker = {
        title,
        items,
        selected: 0,
        answer: (value) => {
          this.picker = undefined
          resolve(value)
          this.draw()
        },
      }
      this.draw()
    })
  }

  private pickerKey(data: string): void {
    const picker = this.picker

    if (picker === undefined) return

    const count = picker.items.length

    if (data === UP || data === SHIFT_TAB || data === DOWN || data === "\t") {
      const step = data === UP || data === SHIFT_TAB ? -1 : 1

      picker.selected = (picker.selected + step + count) % count

      return this.draw()
    }

    if (data === "\r") return picker.answer(picker.items[picker.selected]?.value)

    if (data === "\u001B" || data === "\u0003") picker.answer(undefined)
  }

  // --- /provider ------------------------------------------------------------
  //
  // Each menu resolves to true when it did something (the menus then close, so
  // the result shows), or false when the user backed out with esc.

  /** `/provider`: pick a provider, then what to do with it. Esc goes back a level. */
  private async providerMenu(): Promise<void> {
    const providers = this.options.providers

    if (providers === undefined) return

    const menus = new Map<string, () => Promise<boolean>>([
      ["anthropic", () => this.anthropicMenu(providers)],
      ["openai", () => this.openaiMenu(providers)],
      ["compatible", () => this.compatibleMenu(providers)],
    ])

    const picked = await this.pick("Which provider?", this.providerItems(providers))

    if (picked === undefined) return

    if ((await menus.get(picked)?.()) === false) return this.providerMenu()
  }

  private providerItems(providers: Providers): Array<Suggestion> {
    const status = new Map(providers.status().map((entry) => [entry.provider.id, entry]))

    const describe = (id: string): string => {
      const entry = status.get(id)

      return [entry?.credentials ?? "", entry?.models ?? ""].filter((part) => part !== "").join(" · ")
    }

    const servers = this.servers(providers).map((server) => server.name)

    return [
      { value: "anthropic", label: "Anthropic", hint: describe("anthropic") },
      { value: "openai", label: "OpenAI", hint: this.openaiHint(providers) },
      {
        value: "compatible",
        label: "OpenAI-compatible",
        hint: servers.length === 0 ? "Ollama, vLLM, LM Studio, OpenRouter, …" : servers.join(", "),
      },
    ]
  }

  /** "API key set · signed in to ChatGPT as …", and so on. */
  private openaiHint(providers: Providers): string {
    const openai = providers.find("openai")
    const account = chatgptAccount()

    return [
      openai !== undefined && providers.key(openai) !== undefined ? "API key set" : "no API key",
      account === undefined ? "not signed in to ChatGPT" : `signed in to ChatGPT as ${account}`,
    ].join(" · ")
  }

  private servers(providers: Providers): Array<ProviderConfig> {
    return providers.configured().filter((provider) => provider.kind === "openai-compatible")
  }

  /** Add or replace a provider's key, and forget it once there is one. */
  private keyItems(providers: Providers, id: string): Array<Suggestion> {
    const provider = providers.find(id)
    const key = provider === undefined ? undefined : providers.key(provider)

    if (key === undefined)
      return [{ value: "key", label: "Add an API key", hint: "kept in the system keychain" }]

    return [
      { value: "key", label: "Replace the API key", hint: `the stored key ends in …${key.slice(-4)}` },
      { value: "forget", label: "Forget the API key", hint: "remove it from the keychain" },
    ]
  }

  private async keyAction(providers: Providers, id: string, action: string): Promise<boolean> {
    if (action === "forget") {
      this.say([(await providers.forget(id)) ?? `Forgot ${id}'s key.`])

      return true
    }

    const key = await this.ask(`API key for ${id} (hidden)`, true)

    if (key === undefined) return false

    const failed = key === "" ? "No key stored." : providers.setKey(id, key)

    if (failed !== undefined) this.say([failed])
    else await this.listed(id, `Stored ${id}'s key in the keychain.`)

    return true
  }

  private async anthropicMenu(providers: Providers): Promise<boolean> {
    const action = await this.pick("Anthropic", this.keyItems(providers, "anthropic"))

    return action === undefined ? false : this.keyAction(providers, "anthropic", action)
  }

  private async openaiMenu(providers: Providers): Promise<boolean> {
    const account = chatgptAccount()

    const plan =
      account === undefined
        ? { value: "login", label: "Sign in with ChatGPT", hint: "use your ChatGPT plan instead of a key" }
        : { value: "logout", label: "Sign out of ChatGPT", hint: `signed in as ${account}` }

    const action = await this.pick("OpenAI", [plan, ...this.keyItems(providers, "openai")])

    if (action === undefined) return false

    if (action === "login") await this.login(providers)
    else if (action === "logout") this.say([(await providers.forget("chatgpt")) ?? "Signed out of ChatGPT."])
    else return this.keyAction(providers, "openai", action)

    return true
  }

  private async compatibleMenu(providers: Providers): Promise<boolean> {
    const servers = this.servers(providers)

    const picked = await this.pick("OpenAI-compatible servers", [
      { value: "", label: "Add a server", hint: "name, base URL, an API key if it needs one, models" },
      ...servers.map((server) => {
        const models = server.models?.map((model) => model.id).join(", ") ?? "models from the server"

        return { value: server.id, label: server.name, hint: `${server.base_url ?? ""} · ${models}` }
      }),
    ])

    if (picked === undefined) return false

    const done = picked === "" ? await this.addServer(providers) : await this.serverMenu(providers, picked)

    return done || this.compatibleMenu(providers)
  }

  private async addServer(providers: Providers): Promise<boolean> {
    const name = await this.ask("Name, like Ollama or DwarfStar", false)

    if (name === undefined || name === "") return false

    const baseUrl = await this.ask("Base URL, like http://localhost:11434/v1", false)

    if (baseUrl === undefined || baseUrl === "") return false

    const key = await this.ask("API key (hidden; enter if it needs none)", true)

    if (key === undefined) return false

    const models = await this.ask("Models, comma-separated (enter to use the server's own list)", false)

    if (models === undefined) return false

    return this.saveServer(providers, { name, baseUrl, key, models })
  }

  private async serverMenu(providers: Providers, id: string): Promise<boolean> {
    const server = this.servers(providers).find((entry) => entry.id === id)

    if (server === undefined) return false

    const models = server.models?.map((model) => model.id).join(", ") ?? ""

    const action = await this.pick(`${server.name} (${server.id})`, [
      { value: "models", label: "Edit models", hint: models === "" ? "using the server's own list" : models },
      { value: "url", label: "Change the base URL", hint: server.base_url ?? "" },
      ...this.keyItems(providers, id),
      { value: "remove", label: "Remove", hint: "forget this server and its key" },
    ])

    if (action === undefined) return false

    if (action === "remove") {
      this.say([providers.remove(id) ?? `Removed ${server.name}.`])

      return true
    }

    if (action !== "models" && action !== "url") return this.keyAction(providers, id, action)

    const form: ServerForm = { name: server.name, baseUrl: server.base_url ?? "", key: "", models }

    const value =
      action === "url"
        ? await this.ask("Base URL", false, form.baseUrl)
        : await this.ask("Models, comma-separated (empty to use the server's own list)", false, models)

    if (value === undefined) return this.serverMenu(providers, id)

    return this.saveServer(
      providers,
      action === "url" ? { ...form, baseUrl: value } : { ...form, models: value },
      id,
    )
  }

  private async saveServer(providers: Providers, form: ServerForm, id?: string): Promise<boolean> {
    const saved = await providers.saveServer(form, id).then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    )

    if ("error" in saved) this.say([saved.error])
    else
      await this.listed(
        saved.value,
        id === undefined ? `Added ${form.name} as ${saved.value}.` : `Saved ${form.name}.`,
      )

    return true
  }

  /** Sign in with ChatGPT in the browser; esc cancels. */
  private async login(providers: Providers): Promise<void> {
    this.notice = "Opening your browser to sign in with ChatGPT…"
    this.draw()

    const cancel = new AbortController()

    const waiting = this.ask("Waiting for the browser. Press esc to cancel", false).then(() => cancel.abort())

    const account = await providers
      .login((url) => {
        openBrowser(url)
        this.say(["If the browser did not open, visit:", url])
      }, cancel.signal)
      .then(
        (who) => ({ who }),
        (error: Error) => ({ error: error.message }),
      )

    this.question?.answer(undefined)
    await waiting
    this.notice = ""

    if ("error" in account) return this.say([account.error])

    await this.listed(
      "chatgpt",
      `Signed in to ChatGPT as ${account.who}. Its models are under chatgpt/ in /model.`,
    )
  }

  /** List a provider's models after a change, and say how it went. */
  private async listed(id: string, done: string): Promise<void> {
    const providers = this.options.providers

    await providers?.refresh(id)

    const models = providers?.status().find((entry) => entry.provider.id === id)?.models ?? ""

    // `models` is "12 models", or "could not list models: …".
    const note = models.startsWith("could not")
      ? `It ${models}. You can still pick a model by typing its id after /model ${id}/.`
      : models === ""
        ? ""
        : `It offers ${models}; pick one with /model.`

    this.say(note === "" ? [done] : [done, note])
  }

  private startNew(): void {
    if (this.transcript.running) return this.say(["A turn is running. Press esc to interrupt it first."])

    this.done(this.options.engine?.createSession(process.cwd()).id)
  }

  private async command(text: string): Promise<void> {
    const [typed = ""] = text.split(/\s+/)
    const argument = text.slice(typed.length).trim()
    const known = findCommand(typed)
    const name = known?.name

    if (known === undefined) return this.say([`Unknown command ${typed}. Try /help.`])

    if (findCommand(typed, this.commands) === undefined) return this.say([`Only the host can run ${name}.`])

    if (name === "/help") return this.say(helpLines(this.commands))

    if (name === "/quit") return this.done()

    if (name === "/tour") return this.submit(TOUR)

    if (name === "/resume") return this.resume(argument)

    if (name === "/new") return this.startNew()

    if (name === "/share") return this.startShare(argument === "local")

    if (name === "/unshare") return this.stopShare()

    if (name === "/export") return this.exportNow()

    if (name === "/evals") {
      const evals = loadEvals(this.cwd()).map(
        (entry) => `${entry.name} (${entry.kind}) — ${entry.description}`,
      )

      return this.say(
        evals.length === 0 ? ["No evaluators yet. Ask the agent for a standing check to create one."] : evals,
      )
    }

    if (name === "/rules") {
      const rules = readRules(this.cwd()).trim()

      return this.say(
        rules === ""
          ? ["No learned rules yet."]
          : [...rules.split("\n"), `${listRuleVersions(this.cwd()).length} earlier versions`],
      )
    }

    if (name === "/revert") {
      return this.say([revertRules(this.cwd()) ? "Restored the previous rules." : "Nothing to revert."])
    }

    if (name === "/yolo") {
      this.options.engine?.setApprovalMode("allow")

      return this.say(["Tools now run without asking. Tab switches back."])
    }

    if (name === "/model") return this.switchModel(argument)

    if (name === "/provider") return this.providerMenu()
  }

  private submit(text: string): void {
    const { engine, peer, sessionId, user } = this.options

    if (text.startsWith("/")) {
      void this.command(text).then(() => this.draw())

      return
    }

    if (engine !== undefined) {
      const from = this.from

      this.from = undefined
      void engine.submit(sessionId, { text, userId: user, previous: from }).then((outcome) => {
        if (!outcome.ok && !outcome.interrupted) this.say([outcome.message])

        this.draw()
      })

      return
    }

    void peer?.prompt(text).then((error) => {
      if (error !== undefined) this.say([error])

      this.draw()
    })
  }

  // --- input --------------------------------------------------------------

  private answer(key: string): void {
    const request = this.approvals[0]
    const engine = this.options.engine

    if (request === undefined || engine === undefined || !"yna".includes(key.toLowerCase())) return

    if (key.toLowerCase() === "a") engine.setApprovalMode("allow")

    this.approvals.shift()
    engine.resolveApproval(request.span_id, key.toLowerCase() === "n" ? "deny" : "allow")
  }

  private input(data: string): void {
    if (this.question !== undefined) return this.answerQuestion(data)

    if (this.picker !== undefined) return this.pickerKey(data)

    if (this.approvals.length > 0 && data !== "\u0003") {
      this.answer(data)

      return this.draw()
    }

    const completion = this.completion()

    if (completion !== undefined && this.menuKey(data, completion)) return this.draw()

    // With the menu closed, tab and shift+tab switch modes.
    if (data === "\t") {
      this.toggleApprovals()

      return this.draw()
    }

    if (data === SHIFT_TAB) {
      this.cycleEffort()

      return this.draw()
    }

    const before = this.editor.text
    const action = this.editor.feed(data)

    // A line recalled from history keeps the menu closed, so arrows keep recalling.
    if (data === UP || data === DOWN) this.dismissed = this.editor.text

    if (this.editor.text !== before) this.selected = 0

    if (action.type === "submit") this.submit(action.text)

    if (action.type === "interrupt") this.options.engine?.interrupt(this.options.sessionId)

    if (action.type === "exit") {
      if (!this.transcript.running) return this.done()

      this.options.engine?.interrupt(this.options.sessionId)
    }

    this.draw()
  }

  // --- lifecycle ----------------------------------------------------------

  /** Runs until the user leaves. Resolves to the session to open next, if they switched. */
  async run(): Promise<string | undefined> {
    const { store, sessionId, engine, peer, phoenix, label } = this.options
    const header = store.readHeader(sessionId)

    this.screen.commit([
      `${style.bold("oi-agent")} ${style.gray(clip(`· ${label} · session ${sessionId.slice(0, 13)} · ${(header?.cwd ?? "").replace(homedir(), "~")}`, this.screen.columns - 10))}`,
      style.gray("Every step is an OpenInference span on disk. /help for commands."),
      ...(this.options.notes ?? []).flatMap((note) =>
        wrap(note, this.screen.columns).map((line) => style.yellow(line)),
      ),
    ])
    this.editor.seedHistory(this.transcript.replay(store, sessionId))

    const unsubscribe = store.subscribe((event) => {
      if (event.session_id !== sessionId) return

      this.transcript.onEvent(event)
      this.draw()
    })

    const stopExport = phoenix?.watch()

    const stopApprovals = engine?.onApproval((request) => {
      this.approvals.push(request)
      this.draw()
    })

    const ticker = setInterval(() => {
      this.frame += 1

      if (this.transcript.running || this.share !== undefined) this.draw()
    }, 100)

    const onData = (data: Buffer): void => this.input(data.toString("utf8"))
    const onResize = (): void => this.draw()

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", onData)
    process.stdout.on("resize", onResize)
    process.stdout.write(control.bracketedPasteOn)
    this.draw()

    const next = await Promise.race([
      new Promise<string | undefined>((resolve) => (this.done = resolve)),
      peer?.closed.then(() => {
        this.say(["The host ended the session."])

        return undefined
      }) ?? new Promise<undefined>(() => undefined),
    ])

    clearInterval(ticker)
    process.stdin.off("data", onData)
    process.stdout.off("resize", onResize)
    process.stdin.setRawMode(false)
    process.stdin.pause()
    this.screen.clear()
    process.stdout.write(control.bracketedPasteOff)
    unsubscribe()
    stopApprovals?.()
    engine?.interrupt(sessionId)
    this.share?.tunnel.stop()
    await this.share?.server.close()
    peer?.close()
    stopExport?.()
    await phoenix?.flush()
    process.stdout.write(
      `${style.gray(
        next === undefined
          ? `session saved · resume with: oi -s ${sessionId.slice(0, 13)}`
          : `left session ${sessionId.slice(0, 13)} · opening ${next.slice(0, 13)}`,
      )}\n\n`,
    )

    return next
  }
}

/** Resolves to a session id when the user asked to switch to it (`/resume`, `/new`). */
export const runApp = (options: AppOptions): Promise<string | undefined> => new App(options).run()
