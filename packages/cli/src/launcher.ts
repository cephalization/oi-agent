#!/usr/bin/env node
/**
 * The launcher: what the `oi` command runs. It starts the real CLI as a
 * child process and starts it again when the CLI asks to reload, so code
 * changes take effect without leaving the session. Nothing is lost by
 * restarting: the session is span files, and the new process folds them
 * exactly as the old one would have.
 *
 * Which code runs: `OI_AGENT_ENTRY` when set (a checkout's
 * `packages/cli/src/main.ts`, say), else the bundled build beside this file.
 * A reload re-reads that choice, so it picks up edited sources, or a build
 * that `pnpm dev` or an upgrade installed since.
 *
 * If code started by a reload exits before its terminal is up, or crashes
 * later, the launcher starts the bundled build on the same session instead,
 * with a note saying why. That fallback cannot be turned off: it is what
 * lets the agent fix a patch that broke the agent. A child that was killed
 * by a signal is not restarted: someone meant it to stop.
 *
 * This file must stay small and import only Node built-ins. It is the one
 * part a patch cannot break, because it is never reloaded.
 *
 * The child learns of the launcher from two variables, which it removes from
 * its environment so that nothing it spawns inherits them:
 * `OI_AGENT_RELOAD_ENTRY`, the code a reload would start (for its preflight),
 * and `OI_AGENT_LAUNCHER_FD`, a pipe on which it writes one line per message:
 * - `ready`: the terminal is up; a failure from now on is not a failed start.
 * - `reload`, then NUL-separated arguments: start again with these (the CLI
 *   then exits with `RELOAD_EXIT`).
 */
import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import { constants } from "node:os"
import * as path from "node:path"
import { isatty } from "node:tty"
import { fileURLToPath } from "node:url"

/** `EX_TEMPFAIL`: the CLI exits with this after asking to reload. */
const RELOAD_EXIT = 75

/** The child's file descriptor for the pipe to the launcher. */
const CHANNEL_FD = 3

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

/** End synchronized output and bracketed paste, show the cursor: what the CLI turns back on as it exits. */
const RESET_TERMINAL = "\u001B[?2026l\u001B[?2004l\u001B[?25h"

// The terminal's settings as oi found them, to put back if a child dies without restoring them.
const savedTty = isatty(0)
  ? (spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).stdout?.trim() ??
    "")
  : ""

const restoreTerminal = (): void => {
  if (isatty(1)) process.stdout.write(RESET_TERMINAL)

  if (savedTty !== "") spawnSync("stty", [savedTty], { stdio: ["inherit", "ignore", "ignore"] })
}

// Through the `oi` link to where this file really is, so a reinstalled link is followed on reload.
const here = (): string => path.dirname(fs.realpathSync(process.argv[1] ?? fileURLToPath(import.meta.url)))

/** The bundled CLI: beside the launcher once packed, in `dist/` when the launcher runs from source. */
const bundled = (): string | undefined =>
  [path.join(here(), "oi.mjs"), path.join(here(), "..", "dist", "oi.mjs")].find((file) => fs.existsSync(file))

const chosen = (): string | undefined => {
  const entry = process.env["OI_AGENT_ENTRY"]

  return entry === undefined || entry === "" ? bundled() : path.resolve(entry)
}

interface Outcome {
  readonly code: number
  /** The signal that killed the child, if one did. */
  readonly signal: NodeJS.Signals | null
  /** The child said its terminal was up. */
  readonly ready: boolean
  /** Arguments to start again with, when the child asked to reload. */
  readonly reload: ReadonlyArray<string> | undefined
}

const signalCode = (signal: NodeJS.Signals | null): number =>
  signal === null ? 1 : 128 + (constants.signals[signal] ?? 0)

const start = (
  entry: string,
  args: ReadonlyArray<string>,
  env: ReadonlyMap<string, string>,
): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      env: {
        ...process.env,
        ...Object.fromEntries(env),
        OI_AGENT_RELOAD_ENTRY: chosen() ?? entry,
        OI_AGENT_LAUNCHER_FD: String(CHANNEL_FD),
      },
    })

    let ready = false
    let reload: ReadonlyArray<string> | undefined
    let pending = ""

    const onLine = (line: string): void => {
      const [kind, ...fields] = line.split("\0")

      if (kind === "ready") ready = true

      if (kind === "reload") reload = fields
    }

    child.stdio[CHANNEL_FD]?.on("data", (chunk: Buffer) => {
      const lines = `${pending}${chunk.toString("utf8")}`.split("\n")

      pending = lines.pop() ?? ""

      for (const line of lines) onLine(line)
    })

    // Ctrl+C reaches the child from the terminal; the launcher only passes on what is sent to it.
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal)
    }

    for (const signal of SIGNALS) process.on(signal, forward)

    child.on("error", (error) => {
      process.stderr.write(`oi: could not start ${entry}: ${error.message}\n`)
    })

    child.on("close", (code, signal) => {
      for (const name of SIGNALS) process.off(name, forward)

      resolve({
        code: code ?? signalCode(signal),
        signal,
        ready,
        reload: code === RELOAD_EXIT ? reload : undefined,
      })
    })
  })

const run = async (): Promise<number> => {
  let args: ReadonlyArray<string> = process.argv.slice(2)
  // Set on top of the launcher's own environment for the next child.
  const env = new Map<string, string>()
  let entry = chosen()
  let reloaded = false

  for (;;) {
    if (entry === undefined) {
      process.stderr.write("oi: no CLI to run. Set OI_AGENT_ENTRY, or build it with `pnpm build`.\n")

      return 1
    }

    const outcome = await start(entry, args, env)

    if (outcome.reload !== undefined) {
      args = outcome.reload
      env.delete("OI_AGENT_FALLBACK")
      entry = chosen()
      reloaded = true

      continue
    }

    const clean = outcome.code === 0 && outcome.signal === null

    if (!clean) restoreTerminal()

    const fallback = bundled()
    const failedStart = !outcome.ready
    const crashed = outcome.code !== 0 && outcome.signal === null

    if (reloaded && (failedStart || crashed) && fallback !== undefined && entry !== fallback) {
      const what = failedStart
        ? `exited with code ${outcome.code} before it started`
        : `crashed with exit code ${outcome.code}`

      env.set(
        "OI_AGENT_FALLBACK",
        `The reloaded code (${entry}) ${what}, so this is the bundled build. Fix it and /reload to try again.`,
      )
      entry = fallback
      reloaded = false

      continue
    }

    return outcome.code
  }
}

process.exitCode = await run()
