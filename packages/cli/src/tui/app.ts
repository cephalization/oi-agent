/**
 * The interactive terminal application.
 *
 * It renders a session from store events and sends prompts to whoever runs
 * the session: the local engine when hosting, or the host when joined as a
 * peer. Everything else here is input handling and slash commands.
 */
import {
  type ApprovalRequest,
  type Engine,
  type ModelOption,
  formatBytes,
  formatShareLink,
  listRuleVersions,
  loadEvals,
  type PeerConnection,
  type PeerServer,
  type PhoenixExporter,
  readRules,
  revertRules,
  servePeers,
  type Store,
  tailcatServe,
  type Tunnel,
} from "@oi-agent/engine"
import { homedir } from "node:os"
import { ago, summarizeSessions, type SessionSummary } from "../sessions.ts"
import { clip, control, style, width } from "./ansi.ts"
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
  /** Models the key can use, for `/model` and effort cycling. Empty until listed. */
  readonly models?: (() => ReadonlyArray<ModelOption>) | undefined
  /** Confirms a model id the list does not include. Resolves to its display name. */
  readonly checkModel?: ((id: string) => Promise<string>) | undefined
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
  /** Ends the app. With a session id, the caller should open that session next. */
  private done: (next?: string) => void = () => undefined

  constructor(options: AppOptions) {
    this.options = options
    this.transcript = new Transcript(this.screen, options.user)
  }

  // --- completion ---------------------------------------------------------

  /** Commands this terminal can run: a joined peer cannot run host-only ones. */
  private get commands(): ReadonlyArray<Command> {
    return this.options.engine === undefined ? COMMANDS.filter((command) => !command.hostOnly) : COMMANDS
  }

  private sessionSuggestions(): Array<Suggestion> {
    const here = this.cwd()

    this.sessions ??= summarizeSessions(this.options.store)

    // Sessions with no turns are launches that never sent a prompt.
    return this.sessions
      .filter((session) => session.id !== this.options.sessionId && session.turns > 0)
      .map((session) => {
        const where = session.cwd === here ? [] : [session.cwd.replace(homedir(), "~")]
        const turns = `${session.turns} turn${session.turns === 1 ? "" : "s"}`

        return {
          value: session.id,
          label: session.title === "" ? "(untitled)" : session.title,
          hint: [ago(session.activeMs), turns, ...where].join(" · "),
          keywords: session.cwd,
        }
      })
  }

  private catalog(): ReadonlyArray<ModelOption> {
    return this.options.models?.() ?? []
  }

  private modelSuggestions(): Array<Suggestion> {
    const current = this.options.engine?.config.model

    return this.catalog().map((option) => {
      const efforts = option.efforts.length === 0 ? "no effort setting" : `effort ${option.efforts.join(" ")}`

      return {
        value: option.id,
        label: option.id,
        hint: `${option.id === current ? "current · " : ""}${option.name} · ${efforts}`,
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

  private menuLines(completion: Completion): Array<string> {
    const { items } = completion
    const selected = this.highlighted(completion)
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
    const parts = [style.gray(engine?.config.model ?? options.label)]
    // Dropped last-added first when the line is wider than the terminal.
    const optional: Array<string> = []

    const add = (part: string, droppable: boolean): void => {
      parts.push(part)

      if (droppable) optional.push(part)
    }

    if (engine !== undefined) {
      if (effortsFor(this.catalog(), engine.config.model).length > 0) {
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

    if (completion !== undefined) lines.push(...this.menuLines(completion))

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

    const id = store.resolveSession(argument)

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

    const next = nextEffort(engine.config.effort, effortsFor(this.catalog(), engine.config.model))

    if (next === undefined) {
      this.notice = `${engine.config.model} has no reasoning effort setting.`

      return
    }

    engine.configure({ effort: next })
    this.notice = ""
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

    // Not in the list (or the list never loaded): ask the API before switching.
    if (!catalog.some((option) => option.id === argument)) {
      const verdict = await (this.options.checkModel?.(argument) ?? Promise.resolve(argument)).then(
        () => undefined,
        (error: Error) => error.message,
      )

      if (verdict !== undefined) return this.say([`Could not switch to ${argument}: ${verdict}`])
    }

    const previous = engine.config.effort
    const effort = fitEffort(previous, effortsFor(catalog, argument))
    const changed = effort !== undefined && effort !== previous

    engine.configure(effort === undefined ? { model: argument } : { model: argument, effort })

    this.say(
      [
        `Model is now ${argument}${changed ? `, at effort ${effort} (it does not accept ${previous})` : ""}.`,
        this.transcript.running ? "The running turn keeps the old model; the next one uses this." : "",
      ].filter((line) => line !== ""),
    )
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
  }

  private submit(text: string): void {
    const { engine, peer, sessionId, user } = this.options

    if (text.startsWith("/")) {
      void this.command(text).then(() => this.draw())

      return
    }

    if (engine !== undefined) {
      void engine.submit(sessionId, { text, userId: user }).then((outcome) => {
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
