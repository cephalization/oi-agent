/**
 * The interactive terminal application.
 *
 * It renders a session from store events and sends prompts to whoever runs
 * the session: the local engine when hosting, or the host when joined as a
 * peer. Everything else here is input handling and slash commands.
 */
import {
  type ApprovalMode,
  type Approvals,
  type ApprovalRequest,
  chatgptAccount,
  DECISION_ACCOUNT,
  attachmentsFrom,
  describeAttachment,
  isProblem,
  getSecret,
  handoffSeedFor,
  readMetadata,
  type InboxFile,
  kindOf,
  pendingInbox,
  type BackgroundWork,
  type Engine,
  type ModelChoice,
  type ModelRef,
  openBrowser,
  splitModel,
  type ModelOption,
  type NewImage,
  formatBytes,
  feedbackIssue,
  formatShareLink,
  branchTo,
  listRuleVersions,
  loadSession,
  renderMetrics,
  sessionMetrics,
  loadConfig,
  loadEvals,
  type ModelDefault,
  type PeerConnection,
  type PeerServer,
  type ProviderConfig,
  readRules,
  revertRules,
  saveApprovals,
  saveModel,
  savePhoenix,
  servePeers,
  type Store,
  tailcatServe,
  type Tunnel,
} from "@oi-agent/engine"
import { homedir } from "node:os"
import { FEEDBACK_DESTINATION, FEEDBACK_MANUAL, postFeedback } from "../feedback.ts"
import { clipboardImage, droppedImages, readImage, shellWords } from "../images.ts"
import { type Dialog, setupPhoenix } from "../phoenix-setup.ts"
import { ProgramStatus } from "../program-status.ts"
import { ago, type SessionSummary, summarizeSessions } from "../sessions.ts"
import type { Providers, ServerForm } from "../providers.ts"
import type { PhoenixConnection, Sessions } from "../storage.ts"
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
import { approvalAction } from "./approvals.ts"
import { Editor, normalizeKeys } from "./editor.ts"
import { effortsFor, fitEffort, nextEffort, parseModelArgument } from "./modes.ts"
import { Screen } from "./screen.ts"
import { compact, Transcript } from "./transcript.ts"
import { orderTasks } from "./tasks.ts"

/** The approval mode, as the status line shows it. */
const APPROVAL_LABELS = new Map<ApprovalMode, string>([
  ["allow", style.yellow("⏵⏵ yolo")],
  ["auto", style.cyan("⏵ auto")],
])

const approvalLabel = (mode: ApprovalMode): string =>
  APPROVAL_LABELS.get(mode) ?? style.gray("ask before tools")

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
  /** The Phoenix this process exports to, which `/phoenix` can change while the session runs. */
  readonly phoenix?: PhoenixConnection | undefined
  /** Providers and their models, for `/model`, `/provider` and effort cycling. */
  readonly providers?: Providers | undefined
  /** Sessions on disk and in Phoenix, for `/resume`. Without it, only those on disk. */
  readonly sessions?: Sessions | undefined
  /** A turn to continue from instead of the latest one, for the first prompt only. */
  readonly from?: string | undefined
  /** Shown under the banner when the session opens. */
  readonly notes?: ReadonlyArray<string> | undefined
  /**
   * Check that the code a reload would start can load. Resolves to why not,
   * or undefined when it can. Present only under the launcher, which does the
   * restarting; without it `/reload` explains that it cannot.
   */
  readonly reload?: (() => Promise<string | undefined>) | undefined
  /** Called once the terminal is drawn: from then on, a crash is not a failed start. */
  readonly onStart?: (() => void) | undefined
  /**
   * Who answers tool approvals from this terminal, when not `engine`: a
   * terminal attached to a task answers through the session that delegated it.
   */
  readonly approver?: Approver | undefined
  /** Present when this terminal is attached to a delegated task: the session `/detach` returns to. */
  readonly detachTo?: string | undefined
}

/** The part of an engine a terminal needs to answer tool approvals. */
export type Approver = Pick<Engine, "approvals" | "onApproval" | "resolveApproval" | "setApprovalMode">

/** How the app ended: with the session to open next, or asking to reload the code on this one. */
export interface AppExit {
  readonly next: string | undefined
  readonly reload: boolean
}

/** Background work is looked at again every this many 100 ms frames: it asks the system about each job. */
const BACKGROUND_EVERY_FRAMES = 10

/** At most this many lines of running work are shown above the status line. */
const BACKGROUND_ROWS = 5

/** Results are held back until the person has typed nothing for this long. */
const CALM_MS = 1500

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Rows the completion menu shows at once. */
const MENU_ROWS = 8

const UP = "\u001B[A"
const DOWN = "\u001B[B"
const SHIFT_TAB = "\u001B[Z"
const CTRL_T = "\u0014"
const CTRL_V = "\u0016"

/** How many waiting prompts are listed above the status line. */
const WAITING_ROWS = 3

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
  private readonly program: ProgramStatus
  private readonly transcript: Transcript
  private readonly approvals: Array<ApprovalRequest> = []
  private share: Share | undefined
  private sharing = false
  private feedbackActive = false
  private notice = ""
  private frame = 0
  /** This session's commands and tasks still running, as last looked at. */
  private work: ReadonlyArray<BackgroundWork> = []
  /** Results waiting to be delivered until the person stops typing. */
  private held = 0
  /** What Enter does with a prompt while a turn runs: say it to that turn, or leave it for the next. */
  private whileRunning: "steer" | "queue" = "steer"
  /** Images that go with the next message, in the order they were attached. */
  private attached: Array<NewImage> = []
  /** Why the last attempt to attach something did nothing; shown until the next key. */
  private attachNotice = ""
  /** Prompts sent from here that no turn has taken yet, as last read from the inbox. */
  private waiting: ReadonlyArray<InboxFile> = []
  /** Messages sent to a running turn from here, until it reads them or they become a turn. */
  private readonly steers = new Set<string>()
  private lastKeyMs = 0
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
  private finish: (exit: AppExit) => void = () => undefined

  private done(next?: string): void {
    this.finish({ next, reload: false })
  }

  constructor(options: AppOptions) {
    this.options = options
    this.program = new ProgramStatus((text) => {
      if (process.stdout.isTTY) process.stdout.write(text)
    }, options.engine?.redactor)
    this.from = options.from
    this.transcript = new Transcript(this.screen, options.user)
    this.editor.onPaste = (text) => this.paste(text)
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
    return this.listSessions().filter(
      (session) => session.id !== this.options.sessionId && (session.turns > 0 || session.title !== ""),
    )
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

    if (command.name === "/attach") return this.taskSuggestions()

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

    const parts = [style.gray(`session ${options.sessionId.slice(0, 18)}`)]
    // Dropped last-added first when the line is wider than the terminal.
    const optional: Array<string> = []

    const add = (part: string, droppable: boolean): void => {
      parts.push(part)

      if (droppable) optional.push(part)
    }

    add(style.gray(label), true)

    if (engine !== undefined) {
      if (ref !== undefined && effortsFor(this.catalog(), ref).length > 0) {
        add(style.gray(`effort ${engine.config.effort}`), false)
      }

      add(approvalLabel(engine.approvals), false)
    }

    if (this.share !== undefined) {
      const peers = this.share.server.peers()

      add(style.green(`● shared${peers.length === 0 ? "" : ` with ${peers.join(", ")}`}`), false)
    }

    if (transcript.contextTokens > 0) {
      const context = style.gray(`${compact(transcript.contextTokens)} context`)

      parts.push(context)
      // How full the context is matters more than the model name or session size: dropped last.
      optional.unshift(context)
    }

    if (transcript.passedEvals > 0)
      add(
        style.green(`◆ ${transcript.passedEvals} eval${transcript.passedEvals === 1 ? "" : "s"} passed`),
        false,
      )

    if (transcript.decisionTokens > 0)
      add(
        style.gray(
          `${compact(transcript.decisionTokens)} decision tokens (~$${transcript.decisionCost.toFixed(6)})`,
        ),
        true,
      )

    if (transcript.sessionBytes > 0) add(style.gray(formatBytes(transcript.sessionBytes)), true)

    if (options.phoenix?.exporter !== undefined) add(style.gray("→ phoenix"), true)

    if (this.held > 0) add(style.yellow(`✉ ${this.held} result${this.held === 1 ? "" : "s"} waiting`), false)

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

  /** One line per command or task still running, above the status line. */
  private workLines(): Array<string> {
    const columns = this.screen.columns

    const lines = this.work.slice(0, BACKGROUND_ROWS).map((item) => {
      const mark = item.waiting === true ? style.yellow("⏸") : style.cyan("⚙")
      const head = `${item.kind} ${item.id} `
      // The state is what changes: a long command gives up its width to keep it in view.
      const status = clip(` · ${item.status}`, Math.max(columns - head.length - 20, 20))

      const title = clip(
        item.title.replaceAll(/\s+/g, " "),
        Math.max(columns - head.length - status.length - 3, 8),
      )

      return `${mark} ${head}${title}${style.gray(status)}`
    })

    return this.work.length > BACKGROUND_ROWS
      ? [...lines, style.gray(`  … ${this.work.length - BACKGROUND_ROWS} more (/tasks)`)]
      : lines
  }

  /** What pressing Enter will do with what is typed, decided by what the conversation itself is doing. */
  private enterHint(canPrompt: boolean): string {
    const { engine, peer, detachTo } = this.options

    if (!canPrompt) return "view only: the host has not let you prompt"

    if (this.editor.text.trimStart().startsWith("/")) return "enter runs the command"

    if (detachTo !== undefined) return "enter sends to the task, which reads it when its current turn ends"

    if (peer !== undefined) {
      if (!peer.state().busy) return "enter starts a new turn on the host"

      if (!peer.state().steerable) return "enter queues for the next turn"

      return this.whileRunning === "steer"
        ? "enter steers the running turn · ctrl+t to queue for the next turn instead"
        : "enter queues for the next turn · ctrl+t to steer the running turn instead"
    }

    if (engine === undefined) return ""

    if (!this.transcript.running) {
      const background = this.work.length === 0 ? "" : " · background work keeps running"

      return this.work.length > 0
        ? `enter starts a new turn${background} · esc stop all`
        : "enter starts a new turn · shift+enter newline · ↑↓ history · tab/⇧tab modes"
    }

    // A turn this terminal only watches: another process runs it, and cannot be steered from here.
    if (!engine.busy(this.options.sessionId))
      return "enter starts a new turn here · another process is running one in this session"

    // A /compact or /handoff reads nothing said to it: whatever is sent waits for it to finish.
    if (!engine.steerable(this.options.sessionId)) return "enter queues for the next turn"

    return this.whileRunning === "steer"
      ? "enter steers the running turn · ctrl+t to queue for the next turn instead"
      : "enter queues for the next turn · ctrl+t to steer the running turn instead"
  }

  /** Prompts from all participants that are still waiting: said to the running turn, or queued behind it. */
  private waitingLines(): Array<string> {
    const columns = this.screen.columns

    const lines = this.waiting.slice(0, WAITING_ROWS).map((entry) => {
      const label =
        entry.steers === true
          ? "↳ steering, when the turn's current step ends: "
          : "⧗ queued for the next turn: "

      const count = entry.attachments?.length ?? 0
      const images = count === 0 ? "" : ` ▣ ${count} ${count === 1 ? "image" : "images"}`
      const sender = `${images} (${entry.user_id})`

      return `${style.yellow(label)}${clip(entry.text.replaceAll(/\s+/g, " "), Math.max(columns - label.length - sender.length - 1, 8))}${style.gray(sender)}`
    })

    return this.waiting.length > WAITING_ROWS
      ? [...lines, style.gray(`  … ${this.waiting.length - WAITING_ROWS} more waiting`)]
      : lines
  }

  /** Read again which shared prompts are waiting, and say what became of the ones meant for a running turn. */
  private watchPrompts(): void {
    const { store, sessionId, peer } = this.options

    this.waiting =
      peer?.state().waiting ??
      pendingInbox(store, sessionId).filter(
        (entry) => entry.delivers === undefined && entry.origin === undefined,
      )

    if (this.steers.size === 0) return

    for (const turn of loadSession(store, sessionId).turns) {
      const metadata = readMetadata(turn.root)

      for (const entry of metadata.steered ?? []) this.steers.delete(entry.inbox_id)

      // Its turn ended before reading it, so it ran as a turn of its own: say so, once.
      if (metadata.inbox_id !== undefined && this.steers.delete(metadata.inbox_id))
        this.say(["  the turn ended before it could be steered: this ran as the next turn instead"])
    }
  }

  /** Nothing is being typed, asked or chosen: a result can arrive without interrupting. */
  private calm(): boolean {
    return (
      this.editor.text === "" &&
      this.approvals.length === 0 &&
      this.question === undefined &&
      this.picker === undefined &&
      Date.now() - this.lastKeyMs > CALM_MS
    )
  }

  /** Look at background work again, and let waiting results through if the moment is calm. */
  private watchBackground(): boolean {
    const { engine, sessionId, peer } = this.options

    if (peer !== undefined) {
      this.work = [...peer.state().work]
      this.held = peer.state().held
      this.watchPrompts()

      return true
    }

    if (engine === undefined) return false

    const before = `${this.held} ${this.work.map((item) => `${item.id} ${item.status}`).join("|")}`

    this.work = engine.background(sessionId)
    this.held = engine.waitingResults(sessionId).length

    if (this.held > 0 && this.calm()) engine.drainInbox(sessionId)

    return before !== `${this.held} ${this.work.map((item) => `${item.id} ${item.status}`).join("|")}`
  }

  private approvalLines(request: ApprovalRequest): Array<string> {
    const input = clip(JSON.stringify(request.input), this.screen.columns * 3)

    const lines = [
      `${style.yellow("?")} ${style.bold(`Allow ${request.tool}`)}${request.user_id === this.options.user ? "" : style.yellow(` (requested by ${request.user_id})`)}`,
      style.gray(`  ${input}`),
    ]

    if (request.reason !== undefined)
      lines.push(
        ...wrap(`Auto asked: ${request.reason}`, this.screen.columns - 2).map((line) =>
          style.gray(`  ${line}`),
        ),
      )

    const choices = `  ${style.bold("y")} yes, this call   ${style.bold("n")} no`

    lines.push(
      this.options.engine?.approvals === "ask"
        ? `${choices}   ${style.bold("a")} enable yolo for this session`
        : choices,
    )

    return lines
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

    lines.push(...this.workLines(), ...this.waitingLines(), this.status())

    if (this.notice !== "") lines.push(style.yellow(this.notice))

    if (this.attachNotice !== "") lines.push(style.yellow(this.attachNotice))

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

      const detail = picker.items[picker.selected]?.detail

      const details =
        detail === undefined
          ? []
          : detail
              .split("\n")
              .flatMap((line) => wrap(line, this.screen.columns - 2))
              .map((line) => style.gray(line))

      this.screen.render({
        lines: [...lines, title, ...this.menuLines(picker.items, picker.selected), ...details],
        cursor: { line: lines.length, column: 1 },
      })

      return
    }

    const canPrompt = this.options.peer === undefined || this.options.peer.info.role === "driver"
    const before = this.editor.text.slice(0, this.editor.cursor).split("\n")
    const input = this.editor.text.split("\n")

    lines.push(...this.attachedLines())

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
    else lines.push(style.gray(clip(this.enterHint(canPrompt), this.screen.columns - 1)))

    this.screen.render({
      lines,
      cursor: { line: cursorLine, column: 3 + width(before.at(-1) ?? "") },
    })
  }

  private say(lines: ReadonlyArray<string>): void {
    this.screen.commit(lines.map((line) => style.gray(line)))
  }

  // --- commands -----------------------------------------------------------

  private taskSuggestions(): Array<Suggestion> {
    const { engine, sessionId } = this.options

    if (engine === undefined) return []

    const entries = engine.tasks.list(sessionId).map((task) => ({ task, status: engine.tasks.status(task) }))

    return orderTasks(entries).map(({ task, status }) => {
      const worktree = task.task.worktree

      const location =
        worktree === undefined
          ? `shares this directory: ${task.header.cwd}`
          : `${worktree.branch} in ${worktree.path}`

      const description = engine.tasks.describe(status)

      return {
        value: task.id,
        label: `${task.id} ${task.task.title}`,
        hint: description,
        detail: `${task.id} "${task.task.title}" · ${description}\nsession ${task.header.id} · ${location}`,
      }
    })
  }

  /** Browse every task, including finished ones, using the shared keyboard picker. */
  private async pickTask(): Promise<void> {
    const items = this.taskSuggestions()

    if (items.length === 0) return this.say(["No tasks have been delegated from this session."])

    const id = await this.pick("Tasks", items)

    if (id !== undefined) this.attach(id)
  }

  /** Deliver waiting results now, whatever is being typed, and say what is still running. */
  private inbox(): void {
    const { engine, sessionId } = this.options

    if (engine === undefined) return

    const waiting = engine.waitingResults(sessionId)
    const running = engine.background(sessionId)

    this.say([
      waiting.length === 0
        ? "No results are waiting."
        : `Delivering ${waiting.length} result${waiting.length === 1 ? "" : "s"} to the agent.`,
      ...running.map((item) => `still running: ${item.kind} ${item.id} ${item.title} · ${item.status}`),
    ])
    engine.drainInbox(sessionId, true)
  }

  /** Switch this terminal to a delegated task's session. */
  private attach(id: string): void {
    const { engine, sessionId } = this.options
    const tasks = engine?.tasks.list(sessionId) ?? []

    const task =
      tasks.find((entry) => entry.id === id) ?? (id === "" && tasks.length === 1 ? tasks[0] : undefined)

    if (task === undefined)
      return this.say([id === "" ? "Usage: /attach <task> (see /tasks)" : `No task ${id} here. See /tasks.`])

    this.done(task.header.id)
  }

  /** Every annotation on the latest turn that has any, read from disk, with all its fields. */
  private verdicts(): Array<string> {
    const { store, sessionId } = this.options
    const view = loadSession(store, sessionId)
    const turns = view.head === undefined ? [] : branchTo(view, view.head.trace_id)
    const annotations = store.listAnnotations(sessionId)
    const columns = this.screen.columns - 4

    const turn = turns.findLast((candidate) =>
      annotations.some((file) => file.target.trace_id === candidate.trace_id),
    )

    if (turn === undefined) return [style.gray("No evaluator has reviewed a turn in this session yet.")]

    const lines = [
      style.gray(`Verdicts on the turn "${clip(turn.input.replaceAll(/\s+/g, " "), columns - 20)}":`),
    ]

    for (const file of annotations.filter((candidate) => candidate.target.trace_id === turn.trace_id)) {
      const { name, label, score, annotator_kind, explanation, metadata } = file.annotation
      const failed = metadata?.["failed"] === true

      const verdict = [label, score === undefined ? undefined : `score ${score}`].filter(
        (part) => part !== undefined,
      )

      lines.push(
        "",
        `${failed ? style.red("◆") : metadata?.["skipped"] === true ? style.gray("◇") : style.green("◆")} ${style.bold(name)}: ${verdict.join(", ")} ${style.gray(`(${annotator_kind})`)}`,
      )

      if (explanation !== undefined)
        lines.push(...explanation.split("\n").flatMap((line) => wrap(`  ${line}`, columns)))

      if (metadata !== undefined && Object.keys(metadata).length > 0)
        lines.push(...wrap(`  ${JSON.stringify(metadata)}`, columns).map((line) => style.gray(line)))
    }

    return lines
  }

  private async startShare(local: boolean): Promise<void> {
    const { engine, sessionId } = this.options

    if (engine === undefined) return this.say(["Only the host can share a session."])

    if (this.share !== undefined) return this.printShare(this.share)

    if (this.sharing) return

    this.sharing = true
    this.notice = "opening a tailcat tunnel…"
    this.draw()

    let server: PeerServer | undefined

    try {
      server = await servePeers(engine, sessionId)

      // A local share skips the tunnel: useful on one machine or a trusted network.
      const tunnel = local
        ? { value: "http://127.0.0.1", stop: () => undefined }
        : await tailcatServe(server.port)

      this.share = { server, tunnel }
      this.printShare(this.share)
    } catch (error) {
      await server?.close()
      this.say([error instanceof Error ? error.message : String(error)])
    } finally {
      this.sharing = false
      this.notice = ""
    }
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

    await this.share.server.close()
    this.share.tunnel.stop()
    this.share = undefined
    this.say(["Sharing stopped."])
  }

  private cwd(): string {
    return this.options.store.readHeader(this.options.sessionId)?.cwd ?? process.cwd()
  }

  private async exportNow(): Promise<void> {
    const phoenix = this.options.phoenix?.exporter

    if (phoenix === undefined) return this.say(["No Phoenix server is set. /phoenix chooses one."])

    // The report counts since the exporter was made: say what this sweep sent, not the session's total.
    const before = phoenix.report()

    phoenix.sweep(this.options.sessionId)
    await phoenix.flush()

    const report = phoenix.report()

    this.say([
      `Sent ${report.spans - before.spans} spans and ${report.annotations - before.annotations} annotations to Phoenix at ${phoenix.target.endpoint} (project ${phoenix.target.project}).`,
      ...report.errors.slice(before.errors.length),
    ])
  }

  // --- /phoenix -------------------------------------------------------------

  /** The Phoenix conversation, held with this terminal's own prompt and menus. Esc backs out. */
  private phoenixDialog(): Dialog {
    return {
      ask: async (label, fallback) => {
        const answer = await this.ask(label, false, fallback)

        return answer === "" ? fallback : answer
      },
      secret: (label) => this.ask(label, true),
      choose: (title, options) =>
        this.pick(
          title,
          options.map((option) => ({ value: option.value, label: option.label, hint: option.hint ?? "" })),
        ),
      ok: (text) => this.screen.commit([`${style.green("✓")} ${text}`]),
      warn: (text) =>
        this.screen.commit(wrap(`! ${text}`, this.screen.columns - 1).map((line) => style.yellow(line))),
      note: (text) => this.say(wrap(text, this.screen.columns - 1)),
      open: (url) => {
        openBrowser(url)
        // Not wrapped by us: a terminal lets a long line be selected whole, and a URL must be copied whole.
        this.say(["Opening your browser to log in to Phoenix. If it did not open, visit:", url])
      },
      paste: (label, until) => {
        const waiting = this.ask(label, false)
        const mine = this.question

        // What was waited for happened: take the question away, unless another has replaced it.
        void until.finally(() => {
          if (this.question === mine) mine?.answer(undefined)
        })

        return waiting
      },
    }
  }

  /**
   * `/phoenix`: choose the server, project and login, then switch to it at
   * once. The live export, `/export` and `/resume`'s listing all follow, and
   * this session is sent to the new server straight away.
   */
  private async choosePhoenix(): Promise<void> {
    const { phoenix, sessions, sessionId } = this.options

    if (phoenix === undefined) return

    const before = phoenix.exporter?.target
    const chosen = await setupPhoenix(this.phoenixDialog(), loadConfig().phoenix)

    if (chosen === undefined) return this.say(["Phoenix is unchanged."])

    try {
      savePhoenix(chosen)
    } catch (error) {
      return this.say([
        `Could not save the config file: ${error instanceof Error ? error.message : String(error)}`,
      ])
    }

    await phoenix.connect({ ...chosen, apiKey: getSecret("phoenix") })
    sessions?.forgetListing()

    const exporter = phoenix.exporter

    if (exporter === undefined) return this.say(["Export to Phoenix is off."])

    exporter.sweep(sessionId)
    await exporter.flush()

    const report = exporter.report()
    const moved = before !== undefined && before.endpoint !== exporter.target.endpoint

    // Sessions put away in the old server stay there: oi does not move them, and cannot open them from the new one.
    const stranded = moved
      ? (sessions?.all() ?? []).filter((session) => session.storage === "phoenix").length
      : 0

    this.say([
      `Exporting to ${exporter.target.endpoint}, project ${exporter.target.project}, from now on. Sent ${report.spans} spans and ${report.annotations} annotations of this session.`,
      ...report.errors,
      ...(stranded === 0
        ? []
        : [
            `${stranded} ${stranded === 1 ? "session is" : "sessions are"} kept only in the Phoenix at ${before?.endpoint ?? ""}. Switch back with /phoenix to open ${stranded === 1 ? "it" : "them"}.`,
          ]),
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

  /** Tab: ask before tools, let the decision model approve (when there is one), or run them unasked. */
  private toggleApprovals(): void {
    const engine = this.options.engine

    if (engine === undefined) return

    const modes: ReadonlyArray<Approvals> =
      engine.decider === undefined ? ["ask", "allow"] : ["ask", "auto", "allow"]

    const next = modes[(modes.findIndex((mode) => mode === engine.approvals) + 1) % modes.length] ?? "ask"

    this.chooseApprovals(next)
  }

  /** A mode the user picked: it applies now and is the default the next time oi starts. */
  private chooseApprovals(mode: Approvals): void {
    this.options.engine?.setApprovalMode(mode)

    try {
      saveApprovals(mode)
    } catch (error) {
      this.notice = `Could not save the approval mode: ${error instanceof Error ? error.message : String(error)}`
    }
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

  private async switchModel(input: string): Promise<void> {
    const engine = this.options.engine

    if (engine === undefined) return

    const { argument, temporary } = parseModelArgument(input)

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
    const saved = temporary ? undefined : this.saveModelDefault(changed ? { ...ref, effort } : ref)

    this.say(
      [
        `Model is now ${name}${changed ? `, at effort ${effort} (it does not accept ${previous})` : ""}.`,
        temporary
          ? "Only for this process: new sessions still start on the saved default."
          : (saved ?? "It is also the default for new sessions; add --temp to switch only for now."),
        crossing
          ? `The conversation carries over to ${ref.provider} as text, tool calls and results; reasoning from ${before} does not.`
          : "",
        this.transcript.running ? "The running turn keeps the old model; the next one uses this." : "",
      ].filter((line) => line !== ""),
    )
  }

  /** Make a model the default for the next start. Returns why it could not, if it could not. */
  private saveModelDefault(choice: ModelDefault): string | undefined {
    try {
      saveModel(choice)

      return undefined
    } catch (error) {
      return `Could not save it as the default: ${error instanceof Error ? error.message : String(error)}`
    }
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

    // Ctrl+U clears the line, as at the prompt: an answer often starts from the current value.
    if (data === "\u0015") {
      question.value = ""

      return this.draw()
    }

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
      [
        DECISION_ACCOUNT,
        async () => {
          const action = await this.pick(
            "TypeSafe decision model",
            this.keyItems(providers, DECISION_ACCOUNT),
          )

          return action === undefined ? false : this.keyAction(providers, DECISION_ACCOUNT, action)
        },
      ],
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
        value: DECISION_ACCOUNT,
        label: "TypeSafe decision model",
        hint: "auto approvals and steering; not a chat model",
      },
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

    const key =
      id === DECISION_ACCOUNT ? getSecret(id) : provider === undefined ? undefined : providers.key(provider)

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

      if (id === DECISION_ACCOUNT)
        this.say(["Restart or /reload oi to apply the decision model's key change."])

      return true
    }

    const key = await this.ask(`API key for ${id} (hidden)`, true)

    if (key === undefined) return false

    const failed = key === "" ? "No key stored." : providers.setKey(id, key)

    if (failed !== undefined) this.say([failed])
    else if (id === DECISION_ACCOUNT)
      this.say([
        "Stored the TypeSafe key. Restart or /reload oi to enable auto approvals and decision-model steering.",
      ])
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

  /** Start oi again on the code as it is now, in this session. The launcher does the restart. */
  private async reload(): Promise<void> {
    const check = this.options.reload

    if (check === undefined)
      return this.say([
        "/reload needs the launcher that `oi` (or bin/oi in a checkout) starts with, and this oi was started without it.",
      ])

    if (this.transcript.running) return this.say(["A turn is running. Press esc to interrupt it first."])

    this.say(["Checking that the new code loads…"])
    this.draw()

    const failed = await check()

    if (failed !== undefined)
      return this.say(["Not reloading; this build keeps running.", ...failed.split("\n")])

    this.finish({ next: undefined, reload: true })
  }

  private startNew(): void {
    if (this.transcript.running) return this.say(["A turn is running. Press esc to interrupt it first."])

    this.done(this.options.engine?.createSession(process.cwd()).id)
  }

  private get feedbackIsPrivate(): boolean {
    return !this.sharing && this.share === undefined && this.options.phoenix?.exporter === undefined
  }

  private async feedback(description: string): Promise<void> {
    const { engine, sessionId, user } = this.options

    if (description === "")
      return this.say([
        "Usage: /feedback <short description of the bug or suggestion>",
        "Do not include personal details, secrets, or logs. Drafting uses your configured model and is recorded in this session.",
        FEEDBACK_MANUAL,
      ])

    if (this.transcript.running) return this.say(["A turn is running. Press esc to interrupt it first."])

    if (engine === undefined) return

    if (!this.feedbackIsPrivate)
      return this.say([
        "Drafting feedback requires an unshared session with Phoenix export off.",
        FEEDBACK_MANUAL,
      ])

    this.feedbackActive = true

    try {
      this.say([
        `Public issue destination: ${FEEDBACK_DESTINATION}`,
        "Review the title and body below for private details. Nothing is posted without your confirmation.",
      ])

      const previous = this.from

      this.from = undefined

      const outcome = await engine.submit(sessionId, {
        text: description,
        userId: user,
        previous,
        operation: "feedback",
      })

      if (!outcome.ok) {
        if (!outcome.interrupted) this.say([FEEDBACK_MANUAL])

        return
      }

      // Transcript has rendered this same outcome as plain content. Never restore a pending
      // confirmation from history or accept it as an agent prompt or tool approval.
      const issue = feedbackIssue(outcome.result.output)

      if (issue === undefined || !this.feedbackIsPrivate) return this.say(["Not posted.", FEEDBACK_MANUAL])

      const consent = await this.ask("Type POST to publish this preview (default: no)", false)

      if (consent !== "POST" || !this.feedbackIsPrivate) return this.say(["Not posted."])

      this.say(["Posting feedback with gh…"])

      const result = await postFeedback(issue)

      if (result.status === "posted") return this.say([`Issue posted: ${result.url}`])

      this.say([
        result.status === "missing"
          ? "GitHub CLI (gh) was not found. Nothing was posted."
          : "Could not confirm posting with gh. Check GitHub before retrying to avoid a duplicate.",
        FEEDBACK_MANUAL,
      ])
    } finally {
      this.feedbackActive = false
    }
  }

  private async command(text: string): Promise<void> {
    const [typed = ""] = text.split(/\s+/)
    const argument = text.slice(typed.length).trim()
    const known = findCommand(typed)
    const name = known?.name

    if (known === undefined) return this.say([`Unknown command ${typed}. Try /help.`])

    if (findCommand(typed, this.commands) === undefined) return this.say([`Only the host can run ${name}.`])

    if (name === "/help") return this.say(helpLines(this.commands))

    if (name === "/session")
      return this.say([
        `Session: ${this.options.sessionId}`,
        `Resume: oi -s ${this.options.sessionId}`,
        `Context: ${this.transcript.contextTokens} tokens in the latest model call`,
        `Tokens used: ${this.transcript.totalTokens} across every model call, evaluators included`,
      ])

    if (name === "/quit") return this.done()

    if (name === "/tour") return this.submit(TOUR)

    if (name === "/feedback") return this.feedback(argument)

    if (name === "/image") return this.image(argument)

    if (name === "/resume") return this.resume(argument)

    if (name === "/handoff") {
      const { engine, sessionId, user } = this.options

      if (argument === "") return this.say(["Usage: /handoff <query>"])

      if (this.transcript.running) return this.say(["A turn is running. Press esc to interrupt it first."])

      if (engine === undefined) return

      const previous = this.from

      this.from = undefined

      // Strip only the command separator, not the user's query formatting.
      const query = text.slice(typed.length).replace(/^\s/, "")

      const outcome = await engine.submit(sessionId, {
        text: query,
        userId: user,
        previous,
        operation: "handoff",
      })

      if (!outcome.ok) return this.say([outcome.message])

      this.done(outcome.result.destination)

      return
    }

    if (name === "/compact") {
      const { engine, sessionId, user } = this.options

      if (this.transcript.running) return this.say(["A turn is running. Press esc to interrupt it first."])

      if (engine === undefined) return

      const previous = this.from

      this.from = undefined

      const outcome = await engine.submit(sessionId, { text, userId: user, previous, operation: "compact" })

      if (!outcome.ok) this.say([outcome.message])

      return
    }

    if (name === "/new") return this.startNew()

    if (name === "/inbox") return this.inbox()

    if (name === "/tasks") return this.pickTask()

    if (name === "/attach") return this.attach(argument)

    if (name === "/detach") {
      const parent = this.options.detachTo

      return parent === undefined ? this.say(["This is not a task you attached to."]) : this.done(parent)
    }

    if (name === "/reload") return this.reload()

    if (name === "/share") return this.startShare(argument === "local")

    if (name === "/unshare") return this.stopShare()

    if (name === "/export") return this.exportNow()

    if (name === "/phoenix") return this.choosePhoenix()

    if (name === "/metrics")
      return this.say(
        renderMetrics(sessionMetrics(this.options.store, this.options.sessionId), this.screen.columns - 2),
      )

    if (name === "/evals") {
      const evals = loadEvals(this.cwd()).map(
        (entry) => `${entry.name} (${entry.kind}) — ${entry.description}`,
      )

      return this.say(
        evals.length === 0 ? ["No evaluators yet. Ask the agent for a standing check to create one."] : evals,
      )
    }

    if (name === "/verdicts") return this.screen.commit(this.verdicts())

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

    if (name === "/auto") {
      const engine = this.options.engine

      if (engine?.decider === undefined)
        return this.say([
          "Auto approvals need a decision model: store a TypeSafe key with `oi auth login typesafe`, then restart oi.",
        ])

      this.chooseApprovals("auto")

      return this.say([
        `${engine.decider.settings.model} now approves tool calls it is confident are safe; you are asked about the rest. Tab switches mode.`,
      ])
    }

    if (name === "/yolo") {
      this.chooseApprovals("allow")

      return this.say(["Tools now run without asking. Tab switches back."])
    }

    if (name === "/model") return this.switchModel(argument)

    if (name === "/provider") return this.providerMenu()
  }

  private submit(text: string): void {
    if (this.feedbackActive) return this.say(["Feedback is in progress."])

    const { engine, peer, sessionId, user } = this.options

    if (text.startsWith("/")) {
      void this.command(text).then(() => this.draw())

      return
    }

    if (peer?.info.role === "viewer") return

    // The message takes the images with it; a command above leaves them for the message that follows.
    const images = this.attached

    this.attached = []

    if (engine !== undefined) {
      const attachments = engine.attach(sessionId, images)

      // Checked when each was attached, so this is a file that changed since: keep them, and say why.
      if (isProblem(attachments)) {
        this.attached = images
        this.editor.set(text)

        return this.say([attachments])
      }

      const said = { text, userId: user, attachments }

      if (engine.busy(sessionId)) {
        const steered = this.whileRunning === "steer" ? engine.steer(sessionId, said) : undefined

        if (steered === undefined) engine.queue(sessionId, said)
        else this.steers.add(steered.id)

        this.watchPrompts()

        return
      }

      const from = this.from

      this.from = undefined
      void engine.submit(sessionId, { ...said, previous: from }).then((outcome) => {
        if (!outcome.ok && !outcome.interrupted)
          this.say([outcome.message, ...this.imageHint(outcome.message)])

        this.draw()
      })

      return
    }

    this.program.report("working", text)
    void peer?.prompt(text, this.whileRunning, images).then((error) => {
      if (error !== undefined) {
        this.program.report("error", error)
        this.say([error])

        // Nothing was sent: give the images back instead of making them be found again.
        if (this.attached.length === 0) this.attached = images
      }

      this.draw()
    })
  }

  // --- images -------------------------------------------------------------

  /** The images waiting to go with the next message, above the line being typed. */
  private attachedLines(): Array<string> {
    if (this.attached.length === 0) return []

    const names = this.attached
      .map((image) => describeAttachment({ name: image.name, bytes: image.bytes.length }))
      .join(" · ")

    const hint = "backspace at the start of the line removes the last"

    return [
      `${style.cyan("▣")} ${clip(names, Math.max(this.screen.columns - 4, 8))}`,
      style.gray(
        `  ${this.attached.length === 1 ? "1 image" : `${this.attached.length} images`} attached · ${hint}`,
      ),
    ]
  }

  /** Attach images to the next message, all or none: a prompt that would be refused is refused here, with the reason. */
  private attachImages(images: ReadonlyArray<NewImage>): void {
    if (this.options.peer?.info.role === "viewer") {
      this.attachNotice = "view only: the host has not let you prompt, so images cannot be attached"

      return
    }

    const problem = attachmentsFrom([...this.attached, ...images])

    if (isProblem(problem)) {
      this.attachNotice = problem

      return
    }

    this.attachNotice = ""
    this.attached.push(...images)
  }

  /** Read image files and attach them. Returns false, attaching nothing, when one cannot be read. */
  private attachFiles(files: ReadonlyArray<string>): boolean {
    const cwd = this.options.store.readHeader(this.options.sessionId)?.cwd ?? process.cwd()
    const images: Array<NewImage> = []

    for (const file of files) {
      const image = readImage(file, cwd)

      if (isProblem(image)) {
        this.attachNotice = image

        return false
      }

      images.push(image)
    }

    this.attachImages(images)

    return true
  }

  /** A paste that is nothing but image files is a drop: attach them, and insert nothing. */
  private paste(text: string): string {
    const cwd = this.options.store.readHeader(this.options.sessionId)?.cwd ?? process.cwd()
    const dropped = droppedImages(text, cwd)

    if (dropped === undefined) return text

    this.attachFiles(dropped)

    return ""
  }

  private pasteClipboard(): void {
    const image = clipboardImage()

    if (image === undefined) this.attachNotice = "There is no image on the clipboard."
    else this.attachImages([image])
  }

  /** `/image a.png b.jpg` attaches files; alone, it says what is attached and how else to attach. */
  private image(argument: string): void {
    if (argument !== "") {
      this.attachFiles(shellWords(argument))

      return
    }

    this.say([
      this.attached.length === 0
        ? "No images attached."
        : `Attached: ${this.attached.map((image) => describeAttachment({ name: image.name, bytes: image.bytes.length })).join(", ")}`,
      "Drop image files on the terminal, press ctrl+v to paste one from the clipboard, or /image <path>.",
      "They go with your next message. Backspace at the start of the line removes the last one.",
    ])
  }

  /**
   * After a turn fails in a conversation that has images: the likeliest cause
   * worth naming. oi does not ask whether a model reads images before sending
   * them, so the provider's own error is what was shown above.
   */
  private imageHint(message: string): Array<string> {
    const { store, sessionId } = this.options
    const view = loadSession(store, sessionId)

    const images =
      view.head !== undefined &&
      branchTo(view, view.head.trace_id).some((turn) => {
        const metadata = readMetadata(turn.root)

        return (
          metadata.attachments !== undefined ||
          (metadata.steered ?? []).some((entry) => entry.attachments !== undefined)
        )
      })

    return images && /image|vision|multimodal|modalit/i.test(message)
      ? wrap(
          "This conversation has images in it. If this model cannot read them, switch to one that can with /model: the images are still here.",
          this.screen.columns - 1,
        )
      : []
  }

  // --- input --------------------------------------------------------------

  private answer(key: string): void {
    const request = this.approvals[0]
    const engine = this.options.approver ?? this.options.engine

    if (request === undefined || engine === undefined) return

    const action = approvalAction(engine.approvals, key)

    if (action === undefined) return

    if (action === "yolo") engine.setApprovalMode("allow")

    this.approvals.shift()
    engine.resolveApproval(request.span_id, action === "deny" ? "deny" : "allow")
    this.reportApproval()
  }

  private reportApproval(): void {
    const request = this.approvals[0]

    if (request === undefined) this.program.report("working")
    else this.program.report("blocked", `${request.tool} ${JSON.stringify(request.input)}`, "permission")
  }

  private input(raw: string): void {
    const data = raw.includes("\u001B[200~") ? raw : normalizeKeys(raw)

    this.program.acknowledge()
    this.lastKeyMs = Date.now()
    this.attachNotice = ""

    // Escape in a picker or a question goes back; only Escape at the prompt stops work.
    if (data === "\u001B" && this.picker === undefined && this.question === undefined) {
      const entries = this.options.engine?.cancel(this.options.sessionId) ?? []

      const mine = entries.filter((entry) => entry.user_id === this.options.user)

      this.editor.restore(mine.map((entry) => entry.text))

      // The prompt back in the editor gets its images back too; they are still in the session.
      const withdrawn = (mine.at(-1)?.attachments ?? []).flatMap((ref) => {
        const file = this.options.store.readAttachment(this.options.sessionId, ref.id)

        return file === undefined ? [] : [{ name: ref.name, bytes: Buffer.from(file.data, "base64") }]
      })

      if (withdrawn.length > 0) this.attached = withdrawn
      this.approvals.length = 0
      this.watchPrompts()
      this.program.report("idle")
    }

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

    if (data === CTRL_T) {
      this.whileRunning = this.whileRunning === "steer" ? "queue" : "steer"

      return this.draw()
    }

    if (data === CTRL_V) {
      this.pasteClipboard()

      return this.draw()
    }

    // At the start of the line there is nothing left to delete but the last image.
    if ((data === "\u007F" || data === "\b") && this.editor.cursor === 0 && this.attached.length > 0) {
      this.attached.pop()

      return this.draw()
    }

    // An empty line with images is a message: the images are what is said.
    if (data === "\r" && this.editor.text.trim() === "" && this.attached.length > 0) {
      this.submit("")

      return this.draw()
    }

    // Ctrl+C clears what is being composed before it means leaving.
    if (data === "\u0003" && this.editor.text === "" && this.attached.length > 0) {
      this.attached = []

      return this.draw()
    }

    const before = this.editor.text
    const action = this.editor.feed(data)

    // A line recalled from history keeps the menu closed, so arrows keep recalling.
    if (data === UP || data === DOWN) this.dismissed = this.editor.text

    if (this.editor.text !== before) this.selected = 0

    if (action.type === "submit") this.submit(action.text)

    if (action.type === "interrupt") this.dismissed = this.editor.text

    if (action.type === "exit") {
      if (!this.transcript.running) return this.done()

      this.options.engine?.interrupt(this.options.sessionId)
    }

    this.draw()
  }

  // --- lifecycle ----------------------------------------------------------

  /** Runs until the user leaves, switches session or reloads. */
  async run(): Promise<AppExit> {
    const { store, sessionId, engine, peer, phoenix, label } = this.options
    const header = store.readHeader(sessionId)

    this.screen.commit([
      `${style.bold("oi-agent")} ${style.gray(clip(`· ${label} · session ${sessionId.slice(0, 13)} · ${(header?.cwd ?? "").replace(homedir(), "~")}`, this.screen.columns - 10))}`,
      style.gray("Every step is an OpenInference span on disk. /help for commands."),
      ...(this.options.notes ?? []).flatMap((note) =>
        wrap(note, this.screen.columns).map((line) => style.yellow(line)),
      ),
    ])
    const handoff = handoffSeedFor(store, sessionId)

    if (handoff !== undefined)
      this.screen.commit([
        style.gray(
          `Handoff from session ${readMetadata(handoff).handoff?.source_session_id}. Original thread preserved.`,
        ),
      ])

    this.editor.seedHistory(this.transcript.replay(store, sessionId))
    this.watchPrompts()
    this.watchBackground()

    const unsubscribe = store.subscribe((event) => {
      if (event.session_id !== sessionId) return

      this.transcript.onEvent(event)
      this.program.event(event)

      // A model call starting is where a running turn takes what was said to it.
      if (event.type === "span_open" && kindOf(event.span) === "LLM") {
        const root = store.readTraceRoots(sessionId, event.span.context.trace_id)
        const span = root.open[0]?.span ?? root.ended[0]

        if (span !== undefined) this.transcript.steered(readMetadata(span).steered ?? [])
      }

      // Reading the inbox means reading every turn's root, so only when it can have changed: a
      // prompt arrives, a turn starts or ends, or a model call starts (which is where a steer is read).
      if (
        event.type === "inbox" ||
        ((event.type === "span_open" || event.type === "span_end") &&
          (event.span.parent_id === null || (event.type === "span_open" && kindOf(event.span) === "LLM")))
      )
        this.watchPrompts()

      this.draw()
    })

    const stopExport = phoenix?.watch()

    // Results for this session wait while its person is typing; other sessions are not this terminal's to hold.
    const calm = engine?.calm

    if (engine !== undefined) engine.calm = (id) => id !== sessionId || this.calm()

    const stopApprovals = (this.options.approver ?? engine)?.onApproval((request) => {
      this.approvals.push(request)
      this.reportApproval()
      this.draw()
    })

    const ticker = setInterval(() => {
      this.frame += 1

      const changed = this.frame % BACKGROUND_EVERY_FRAMES === 0 && this.watchBackground()

      if (this.transcript.running || this.share !== undefined || changed) this.draw()
    }, 100)

    const onData = (data: Buffer): void => this.input(data.toString("utf8"))
    const onResize = (): void => this.draw()

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on("data", onData)
    process.stdout.on("resize", onResize)
    process.stdout.write(control.bracketedPasteOn + control.modifiedKeysOn)
    this.program.report("idle")
    this.draw()
    this.options.onStart?.()
    void engine?.resumeHandoff(sessionId).then((outcome) => {
      if (outcome !== undefined && !outcome.ok && !outcome.interrupted) this.say([outcome.message])

      this.draw()
    })

    const exit = await Promise.race([
      new Promise<AppExit>((resolve) => (this.finish = resolve)),
      peer?.closed.then((): AppExit => {
        this.say(["Host disconnected. Left the joined chat."])

        return { next: undefined, reload: false }
      }) ?? new Promise<AppExit>(() => undefined),
    ])

    const { next } = exit

    this.question?.answer(undefined)
    clearInterval(ticker)
    process.stdin.off("data", onData)
    process.stdout.off("resize", onResize)
    process.stdin.setRawMode(false)
    process.stdin.pause()
    this.screen.clear()
    process.stdout.write(control.modifiedKeysOff + control.bracketedPasteOff)
    this.program.clear()
    unsubscribe()
    stopApprovals?.()

    if (engine !== undefined && calm !== undefined) engine.calm = calm

    // Leaving: queued prompts stay queued for whoever serves the session next.
    engine?.interrupt(sessionId, true)
    await this.share?.server.close()
    this.share?.tunnel.stop()
    peer?.close()
    stopExport?.()
    await phoenix?.flush()

    const farewell = exit.reload
      ? `reloading oi on session ${sessionId.slice(0, 13)}`
      : next === undefined
        ? `session saved · resume with: oi -s ${sessionId.slice(0, 13)}`
        : `left session ${sessionId.slice(0, 13)} · opening ${next.slice(0, 13)}`

    process.stdout.write(`${style.gray(farewell)}\n\n`)

    if (next !== undefined) this.screen.freshViewport()

    return exit
  }
}

/** Resolves to how the app ended: the session to switch to (`/resume`, `/new`), or a reload. */
export const runApp = (options: AppOptions): Promise<AppExit> => new App(options).run()
