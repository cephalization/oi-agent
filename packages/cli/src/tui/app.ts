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
import { clip, control, style, width } from "./ansi.ts"
import { Editor } from "./editor.ts"
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
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const HELP = [
  "/share          share this session over tailcat (drive + view links)",
  "/share local    share on this machine only, without a tunnel",
  "/unshare        stop sharing",
  "/evals          list the evaluators that review each turn",
  "/rules          show rules learned from evaluator failures",
  "/revert         undo the most recent learned rule",
  "/export         send this session to Phoenix now",
  "/yolo           stop asking before running tools",
  "/quit           exit (the session stays on disk)",
  "",
  "enter send · alt+enter newline · esc interrupt · ctrl+c clear or exit",
]

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
  private done: () => void = () => undefined

  constructor(options: AppOptions) {
    this.options = options
    this.transcript = new Transcript(this.screen, options.user)
  }

  // --- drawing ------------------------------------------------------------

  private status(): string {
    const { transcript, options } = this
    const parts = [style.gray(options.label)]

    if (transcript.totalTokens > 0) parts.push(style.gray(`${compact(transcript.totalTokens)} tokens`))

    if (options.phoenix !== undefined) parts.push(style.gray("→ phoenix"))

    if (this.share !== undefined) {
      const peers = this.share.server.peers()

      parts.push(style.green(`● shared${peers.length === 0 ? "" : ` with ${peers.join(", ")}`}`))
    }

    if (transcript.running) {
      const spinner = SPINNER[this.frame % SPINNER.length] ?? ""

      parts.unshift(style.cyan(`${spinner} working ${transcript.elapsedSeconds}s`))
      parts.push(style.gray("esc to interrupt"))
    }

    return parts.join(style.gray(" · "))
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

    for (const [index, line] of input.entries()) {
      lines.push(`${index === 0 ? style.cyan(canPrompt ? "›" : "◦") : " "} ${line}`)
    }

    if (!canPrompt && this.editor.text === "") lines[first] = `${style.gray("◦ view only")} `

    this.screen.render({
      lines,
      cursor: { line: first + before.length - 1, column: 3 + width(before.at(-1) ?? "") },
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

  private async command(text: string): Promise<void> {
    const [name] = text.split(/\s+/)

    if (name === "/help") return this.say(HELP)

    if (name === "/quit" || name === "/exit") return this.done()

    if (name === "/share") return this.startShare(text.includes("local"))

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

      return this.say(["Tools now run without asking."])
    }

    this.say([`Unknown command ${name ?? ""}. Try /help.`])
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

    const action = this.editor.feed(data)

    if (action.type === "submit") this.submit(action.text)

    if (action.type === "interrupt") this.options.engine?.interrupt(this.options.sessionId)

    if (action.type === "exit") {
      if (!this.transcript.running) return this.done()

      this.options.engine?.interrupt(this.options.sessionId)
    }

    this.draw()
  }

  // --- lifecycle ----------------------------------------------------------

  async run(): Promise<void> {
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

    await Promise.race([
      new Promise<void>((resolve) => (this.done = resolve)),
      peer?.closed.then(() => this.say(["The host ended the session."])) ??
        new Promise<void>(() => undefined),
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
    process.stdout.write(`${style.gray(`session saved · resume with: oi -s ${sessionId.slice(0, 13)}`)}\n`)
  }
}

export const runApp = (options: AppOptions): Promise<void> => new App(options).run()
