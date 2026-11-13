/**
 * Drive a program in a real terminal. Scenarios use the `Terminal`
 * interface; `RexTerminal` implements it with the Rex CLI (a headless Rex
 * session per scenario, 80×24, closed afterwards). A second implementation
 * (node-pty plus a headless xterm) would let the same scenarios run where
 * Rex is not installed, such as GitHub Actions.
 */
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Option, Schema } from "effect"

export interface Terminal {
  /** Type text exactly as given. */
  send(text: string): Promise<void>
  /** Press keys, in Rex key syntax: `enter`, `ctrl+c`, `down`, `escape`. */
  key(...keys: ReadonlyArray<string>): Promise<void>
  /** Type a line and press enter. */
  line(text: string): Promise<void>
  /** The screen and scrollback as plain text. */
  screen(): Promise<string>
  /** Resolve with the screen once it matches, or fail with the last screen after `timeoutMs`. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>
  /** The program's exit status once it has exited, else `undefined` after `timeoutMs`. */
  exited(timeoutMs?: number): Promise<number | undefined>
  close(): Promise<void>
}

const REX_CANDIDATES = [
  process.env["OI_E2E_REX"],
  "rex",
  "/Applications/Rex Beta.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
  "/Applications/Rex.app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex",
]

const exec = (file: string, args: ReadonlyArray<string>, timeoutMs = 15_000): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout)
        else reject(new Error(`${[file, ...args].slice(0, 4).join(" ")}: ${stderr.trim() || error.message}`))
      },
    )
  })

/** Like `exec`, but resolves with stdout whatever the exit status (for `rex wait`). */
const execOutput = (file: string, args: ReadonlyArray<string>, timeoutMs: number): Promise<string> =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs }, (_error, stdout) => resolve(stdout))
  })

let rexBinary: string | undefined | null = null

/** The Rex CLI, or `undefined` when it is not installed. */
export const findRex = async (): Promise<string | undefined> => {
  if (rexBinary !== null) return rexBinary

  // `OI_E2E_REX=none` runs as if Rex were not installed (terminal scenarios skip).
  if (process.env["OI_E2E_REX"] === "none") {
    rexBinary = undefined

    return undefined
  }

  for (const candidate of REX_CANDIDATES) {
    if (candidate === undefined) continue

    if (candidate.includes("/") && !fs.existsSync(candidate)) continue

    try {
      await exec(candidate, ["version"], 5000)
      rexBinary = candidate

      return candidate
    } catch {
      // Try the next one.
    }
  }

  rexBinary = undefined

  return undefined
}

const Created = Schema.fromJsonString(
  Schema.Struct({
    session_id: Schema.String,
    initial_windows: Schema.Array(Schema.Struct({ block_ids: Schema.Array(Schema.String) })),
  }),
)

const decodeCreated = Schema.decodeUnknownSync(Created)

const ExitPayload = Schema.fromJsonString(Schema.Struct({ exit_code: Schema.optionalKey(Schema.Int) }))
const decodeExit = Schema.decodeUnknownOption(ExitPayload)

export class RexTerminal implements Terminal {
  private readonly rex: string
  readonly session: string
  readonly block: string
  private closed = false

  private constructor(rex: string, session: string, block: string) {
    this.rex = rex
    this.session = session
    this.block = block
  }

  /** Start `argv` in a new headless Rex session labelled `label`, in `cwd`. */
  static async start(label: string, cwd: string, argv: ReadonlyArray<string>): Promise<RexTerminal> {
    const rex = await findRex()

    if (rex === undefined) throw new Error("Rex is not installed; terminal scenarios need it.")

    const created = decodeCreated(
      await exec(rex, ["new", label, "--keep-open", "--shell", "none", "-c", cwd, "--json", "--", ...argv]),
    )

    const block = created.initial_windows[0]?.block_ids[0]

    if (block === undefined) throw new Error(`Rex created session ${created.session_id} without a terminal.`)

    return new RexTerminal(rex, created.session_id, block)
  }

  private target(): Array<string> {
    return ["-s", this.session, "-b", this.block]
  }

  async send(text: string): Promise<void> {
    await exec(this.rex, ["send", ...this.target(), text])
  }

  async key(...keys: ReadonlyArray<string>): Promise<void> {
    await exec(this.rex, ["send-key", ...this.target(), ...keys])
  }

  async line(text: string): Promise<void> {
    await this.send(text)
    // Let the editor take the text before enter, as a person typing would.
    await sleep(150)
    await this.key("enter")
  }

  async screen(): Promise<string> {
    return exec(this.rex, ["capture", ...this.target(), "--trim"])
  }

  async waitFor(pattern: RegExp, timeoutMs = 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let last = ""

    while (Date.now() < deadline) {
      last = await this.screen()

      if (pattern.test(last)) return last

      await sleep(250)
    }

    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${pattern}. Screen:\n${tail(last)}`)
  }

  async exited(timeoutMs = 10_000): Promise<number | undefined> {
    const out = await execOutput(
      this.rex,
      ["wait", this.block, "-s", this.session, "--for", `${Math.ceil(timeoutMs / 1000)}s`, "--json"],
      timeoutMs + 5000,
    )

    return exitCode(out)
  }

  async close(): Promise<void> {
    if (this.closed) return

    this.closed = true
    await exec(this.rex, ["kill", this.session]).catch(() => undefined)
  }
}

const exitCode = (out: string): number | undefined =>
  Option.match(decodeExit(out.trim().split("\n").at(-1) ?? ""), {
    onNone: () => undefined,
    onSome: (payload) => payload.exit_code,
  })

/** The last lines of a screen, for error messages. */
export const tail = (screen: string, lines = 30): string => screen.split("\n").slice(-lines).join("\n")
