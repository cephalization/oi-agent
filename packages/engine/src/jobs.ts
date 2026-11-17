/**
 * Jobs: shell commands that can outlive the tool call, the turn and the
 * process that started them.
 *
 * Every `bash` call is a job. Its output goes to a log file, not a pipe, and
 * a small wrapper writes its exit code beside the log, so a command needs
 * nothing from the oi process once it has started. A call that finishes in
 * time is read back and its job discarded. One that is still running at its
 * time limit, or was started with `background: true`, is left running: a
 * later tool call, a later turn, or oi after a restart finds out how it ended
 * from the files.
 *
 *   <home>/jobs/<session-id>/<job-id>/
 *     job.json      what was started, by which TOOL span; never modified
 *     log           combined stdout and stderr, as the command wrote it
 *     exit          the exit code, written once by the wrapper
 *     background    present once the job outlived its tool call
 *     killed        present when oi stopped it
 *     reported      present once someone has told the model how it ended
 *
 * This lives outside the session tree on purpose: a log is raw command output
 * and grows, and the session tree holds only scrubbed, immutable files.
 * Whatever reaches a span from here goes through the redactor first.
 */
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { Schema } from "effect"
import { parser, printer, SpanRef } from "./format.ts"
import { isoToNs, nowNs, nsToIso } from "./ids.ts"
import type { Store } from "./store.ts"

export const JobFile = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  /** The wrapper's process id, which is also its process group. */
  pid: Schema.Int,
  started_at: Schema.String,
  /** The `TOOL` span that started it. */
  tool: SpanRef,
  /** Set when the command is a subagent's runner: the task and its session. */
  task: Schema.optionalKey(Schema.Struct({ id: Schema.String, session_id: Schema.String })),
})

export type Job = { -readonly [K in keyof typeof JobFile.Type]: (typeof JobFile.Type)[K] }

const parseJob = parser(JobFile)
const printJob = printer(JobFile)

export type JobState =
  | { readonly state: "running" }
  | { readonly state: "exited"; readonly code: number; readonly endedMs: number }
  /** Stopped by oi, or gone without an exit code (the machine restarted, say). */
  | { readonly state: "killed"; readonly endedMs: number }

/** Why a job outlived its tool call. */
export type BackgroundReason = "requested" | "timeout"

export interface JobStart {
  readonly sessionId: string
  readonly command: string
  readonly cwd: string
  readonly tool: Job["tool"]
  readonly task?: Job["task"]
}

/**
 * Runs the command, then records its exit code with a rename, so a reader
 * never sees half a number. `$0` names the job, which is how a process id is
 * told from an unrelated process that was given the same one later.
 */
const WRAPPER = 'bash -c "$1"; code=$?; printf %s "$code" > "$2.tmp" && mv "$2.tmp" "$2"'

/** How often a job this process did not start is checked on. */
const POLL_MS = 1000

const marker = (id: string): string => `oi-job-${id}`

const mtimeMs = (file: string): number | undefined => {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

/** New text appended to a log since the last read. */
export class LogReader {
  private offset = 0
  private readonly decoder = new StringDecoder("utf8")
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  read(): string {
    let fd: number

    try {
      fd = fs.openSync(this.file, "r")
    } catch {
      return ""
    }

    try {
      const size = fs.fstatSync(fd).size

      if (size <= this.offset) return ""

      const buffer = Buffer.alloc(size - this.offset)
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset)

      this.offset += read

      return this.decoder.write(buffer.subarray(0, read))
    } finally {
      fs.closeSync(fd)
    }
  }
}

export class Jobs {
  private readonly root: string
  /** Jobs this process started: each resolves when its wrapper exits. */
  private readonly children = new Map<string, Promise<void>>()
  private readonly ends = new Map<string, Promise<JobState>>()
  private readonly timers = new Set<ReturnType<typeof setInterval>>()
  /** Tool calls waiting on a job; while there are any, they report its end. */
  private readonly waiters = new Map<string, number>()
  private readonly listeners = new Set<(job: Job) => void>()

  constructor(root: string) {
    this.root = root
  }

  // --- files --------------------------------------------------------------

  dir(job: Pick<Job, "session_id" | "id">): string {
    return path.join(this.root, job.session_id, job.id)
  }

  logPath(job: Job): string {
    return path.join(this.dir(job), "log")
  }

  private has(job: Job, name: string): boolean {
    return fs.existsSync(path.join(this.dir(job), name))
  }

  read(sessionId: string, id: string): Job | undefined {
    // An id is a directory name: anything else could reach outside the session's jobs.
    if (!/^[0-9a-z]+$/.test(id)) return undefined

    try {
      return parseJob(fs.readFileSync(path.join(this.root, sessionId, id, "job.json"), "utf8"))
    } catch {
      return undefined
    }
  }

  /** A session's jobs, oldest first. */
  private all(sessionId: string): Array<Job> {
    let names: Array<string>

    try {
      names = fs.readdirSync(path.join(this.root, sessionId))
    } catch {
      return []
    }

    return names
      .flatMap((name) => this.read(sessionId, name) ?? [])
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
  }

  /** The jobs that outlived their tool call, oldest first. */
  list(sessionId: string): Array<Job> {
    return this.all(sessionId).filter((job) => this.isBackground(job))
  }

  // --- running ------------------------------------------------------------

  start(input: JobStart): Job {
    // Checked here because spawn reports a missing directory as if bash itself were missing.
    if (!fs.existsSync(input.cwd))
      throw new Error(`Failed to start command: the directory ${input.cwd} does not exist`)

    const id = randomBytes(4).toString("hex")
    const dir = path.join(this.root, input.sessionId, id)

    fs.mkdirSync(dir, { recursive: true })

    const log = fs.openSync(path.join(dir, "log"), "a")

    try {
      const child = spawn("bash", ["-c", WRAPPER, marker(id), input.command, path.join(dir, "exit")], {
        cwd: input.cwd,
        // OI_AGENT tells scripts they run under oi (`pnpm dev` refuses to relink oi from inside it).
        env: { ...process.env, OI_AGENT: "1" },
        stdio: ["ignore", log, log],
        // Its own process group, so stopping it also stops what it started.
        detached: true,
      })

      // A failed spawn still returns a ChildProcess, and emits `error` on the
      // next tick: without a listener that would crash oi after start has thrown.
      child.once("error", () => undefined)

      if (child.pid === undefined) {
        fs.rmSync(dir, { recursive: true, force: true })
        throw new Error("Failed to start command: bash could not be run")
      }

      const job: Job = {
        id,
        session_id: input.sessionId,
        command: input.command,
        cwd: input.cwd,
        pid: child.pid,
        started_at: nsToIso(nowNs()),
        tool: input.tool,
      }

      if (input.task !== undefined) job.task = input.task

      fs.writeFileSync(path.join(dir, "job.json"), printJob(job))

      this.children.set(
        id,
        new Promise((resolve) => {
          // close also fires after a spawn error, which need not emit exit.
          child.once("close", () => resolve())
        }),
      )

      // The job must not keep oi alive, or be stopped by oi exiting.
      child.unref()

      return job
    } finally {
      fs.closeSync(log)
    }
  }

  private alive(job: Job): boolean {
    const ps = spawnSync("ps", ["-o", "args=", "-p", String(job.pid)], { encoding: "utf8" })

    // The usual case: the process is the job's if its command line names the job.
    if (ps.error === undefined) return ps.stdout.includes(marker(job.id))

    // `ps` cannot be run here (a macOS sandbox forbids setuid programs). Settle
    // for whether a process group with the job's id exists and is ours.
    try {
      process.kill(-job.pid, 0)

      return true
    } catch {
      return false
    }
  }

  state(job: Job): JobState {
    // Discarded: its tool call was interrupted, or has read all it needed.
    if (!fs.existsSync(this.dir(job))) return { state: "killed", endedMs: Date.now() }

    const exit = path.join(this.dir(job), "exit")
    const killed = mtimeMs(path.join(this.dir(job), "killed"))

    if (killed !== undefined) return { state: "killed", endedMs: killed }

    try {
      const code = Number(fs.readFileSync(exit, "utf8"))

      return { state: "exited", code, endedMs: mtimeMs(exit) ?? Date.now() }
    } catch {
      // No exit code yet.
    }

    if (this.alive(job)) return { state: "running" }

    // The wrapper writes its code before it exits: read once more before deciding it never did.
    if (fs.existsSync(exit)) return this.state(job)

    fs.writeFileSync(path.join(this.dir(job), "killed"), "")

    return this.state(job)
  }

  /** How the job ended, once it has. */
  ended(job: Job): Promise<JobState> {
    const known = this.ends.get(job.id)

    if (known !== undefined) return known

    const child = this.children.get(job.id)

    const end =
      child === undefined
        ? new Promise<JobState>((resolve) => {
            const timer = setInterval(() => {
              const state = this.state(job)

              if (state.state === "running") return

              clearInterval(timer)
              this.timers.delete(timer)
              resolve(state)
            }, POLL_MS)

            this.timers.add(timer)
          })
        : child.then(() => this.state(job))

    this.ends.set(job.id, end)

    return end
  }

  /** Stop the job and everything it started. */
  kill(job: Job): void {
    if (this.state(job).state !== "running") return

    fs.writeFileSync(path.join(this.dir(job), "killed"), "")

    try {
      process.kill(-job.pid, "SIGKILL")
    } catch {
      // The process group already exited.
    }
  }

  /** Stop every job of a session that is still running. */
  killAll(sessionId: string): void {
    for (const job of this.all(sessionId)) this.kill(job)
  }

  /** Forget a job whose tool call has read everything it needs. */
  discard(job: Job): void {
    this.children.delete(job.id)
    this.ends.delete(job.id)
    fs.rmSync(this.dir(job), { recursive: true, force: true })
  }

  // --- background ---------------------------------------------------------

  isBackground(job: Job): boolean {
    return this.has(job, "background")
  }

  backgroundReason(job: Job): BackgroundReason {
    try {
      return fs.readFileSync(path.join(this.dir(job), "background"), "utf8") === "timeout"
        ? "timeout"
        : "requested"
    } catch {
      return "requested"
    }
  }

  /** Leave the job running after its tool call, and report its end to the listeners. */
  toBackground(job: Job, reason: BackgroundReason): void {
    fs.writeFileSync(path.join(this.dir(job), "background"), reason)
    this.follow(job)
  }

  isReported(job: Job): boolean {
    return this.has(job, "reported")
  }

  /**
   * Take responsibility for telling the model how the job ended. Only one
   * caller gets `true`, so the end is reported once: by a tool call that
   * was watching, or as a delivered result.
   */
  claim(job: Job): boolean {
    try {
      fs.writeFileSync(path.join(this.dir(job), "reported"), "", { flag: "wx" })

      return true
    } catch {
      return false
    }
  }

  /** Be told when a background job has ended and no tool call has reported it. */
  onEnd(listener: (job: Job) => void): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  private follow(job: Job): void {
    void this.ended(job).then(() => this.settle(job))
  }

  private settle(job: Job): void {
    if ((this.waiters.get(job.id) ?? 0) > 0 || this.isReported(job)) return

    for (const listener of this.listeners) listener(job)
  }

  /**
   * Wait up to `ms` for a background job to end. While a tool call waits, it
   * is the one to report the end (with `claim`); if it gives up first, the
   * end goes to the listeners as usual.
   */
  async wait(job: Job, ms: number): Promise<JobState> {
    this.waiters.set(job.id, (this.waiters.get(job.id) ?? 0) + 1)

    let timer: ReturnType<typeof setTimeout> | undefined

    const seen = await Promise.race([
      this.ended(job),
      new Promise<JobState>((resolve) => {
        timer = setTimeout(() => resolve({ state: "running" }), ms)
      }),
    ])

    clearTimeout(timer)
    this.waiters.set(job.id, (this.waiters.get(job.id) ?? 1) - 1)

    // It may have ended just as this gave up, when nobody was left to report it.
    if (seen.state === "running" && this.state(job).state !== "running") this.settle(job)

    return seen
  }

  /**
   * Pick up a session's jobs after a restart: follow the background ones, and
   * stop what an interrupted tool call left running.
   */
  adopt(sessionId: string): void {
    for (const job of this.all(sessionId)) {
      if (this.children.has(job.id)) continue

      if (!this.isBackground(job)) {
        this.kill(job)
        this.discard(job)
      } else if (this.state(job).state === "running") this.follow(job)
      // It ended while nobody was watching: say so now, not at the next check.
      else this.settle(job)
    }
  }

  /** The background jobs of a session that are still running. */
  running(sessionId: string): Array<Job> {
    return this.list(sessionId).filter((job) => this.state(job).state === "running")
  }

  /** Stop checking on jobs. The jobs themselves keep running. */
  close(): void {
    for (const timer of this.timers) clearInterval(timer)

    this.timers.clear()
  }
}

/** The jobs of the sessions in a store. */
export const jobsOf = (store: Store): Jobs => new Jobs(path.join(store.home, "jobs"))

// --- describing a job to the model ------------------------------------------

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)

  return minutes < 60
    ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

const startedMs = (job: Job): number => Number(isoToNs(job.started_at) / 1_000_000n)

/** `running for 2m10s`, `exited with code 0 after 5m12s`, `killed after 40s`. */
export const describeState = (job: Job, state: JobState, nowMs: number = Date.now()): string => {
  if (state.state === "running") return `running for ${formatDuration(nowMs - startedMs(job))}`

  const took = formatDuration(state.endedMs - startedMs(job))

  return state.state === "exited" ? `exited with code ${state.code} after ${took}` : `killed after ${took}`
}

/** How much of a log a report quotes. The whole log is a file the model can read. */
const TAIL_CHARS = 4000

/** A job's state, command and latest output, as the model is told about it. */
export const jobReport = (jobs: Jobs, job: Job, state: JobState): string => {
  const log = jobs.logPath(job)
  const tail = logTail(log, TAIL_CHARS)

  return [
    `job ${job.id}: ${describeState(job, state)}`,
    `command: ${job.command}`,
    `full output: ${log}`,
    tail === "" ? "(no output)" : `--- end of output ---\n${tail}`,
  ].join("\n")
}

/** The end of a log, starting on a line boundary. */
export const logTail = (file: string, limit: number): string => {
  let fd: number

  try {
    fd = fs.openSync(file, "r")
  } catch {
    return ""
  }

  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - limit)
    const buffer = Buffer.alloc(size - start)

    fs.readSync(fd, buffer, 0, buffer.length, start)

    const text = buffer.toString("utf8")

    return start === 0 ? text : text.slice(text.indexOf("\n") + 1)
  } finally {
    fs.closeSync(fd)
  }
}
