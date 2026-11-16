/**
 * Tasks: work one session delegates to a subagent.
 *
 * A task is a session of its own. Its header names the `TOOL` span that
 * delegated it, so the two sessions are linked from the files alone, and its
 * first prompt is the brief, left in its inbox like any prompt from outside.
 * What runs it is a *runner*: a background job of the delegating session
 * whose command serves the task's session headlessly (`oi serve`) until it
 * has nothing left to do. So a task gets everything a job has (it outlives
 * the turn and the process that started it, and its end is delivered as a
 * result) and everything a session has (resume, compaction, its own jobs).
 *
 * Talking to a task is writing to its inbox and making sure a runner is
 * there to read it. A tool call the task needs a person to approve waits as
 * a pair of files under `<home>/approvals/<session>/`, which the delegating
 * session's interface answers.
 */
import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import { loadSession, pendingInbox } from "./fold.ts"
import {
  type Delivery,
  kindOf,
  OI,
  parser,
  printer,
  readMetadata,
  type SessionHeader,
  type SessionSpanRef,
  stringAttr,
  type TaskHeader,
} from "./format.ts"
import { isoToNs, newSessionId } from "./ids.ts"
import { formatDuration, type Job, type Jobs, type JobState } from "./jobs.ts"
import type { Store } from "./store.ts"
import { git } from "./workspace.ts"

/** Creating a worktree checks out every file: allow for a large repository. */
const WORKTREE_TIMEOUT_MS = 120_000

export interface TaskOptions {
  /**
   * The shell command that serves a session headlessly on `model`
   * (`provider/model`) until it has nothing left to do. Absent when this
   * process cannot start subagents.
   */
  readonly runner?: ((sessionId: string, model: string) => string) | undefined
  /** How many tasks one session may have running at once. */
  readonly limit?: number | undefined
}

const DEFAULT_LIMIT = 4

/** The session and `TOOL` span a task is delegated or spoken to from. */
export interface Delegator {
  readonly sessionId: string
  readonly cwd: string
  readonly userId: string
  readonly span: { readonly trace_id: string; readonly span_id: string }
}

export interface Brief {
  readonly title: string
  /** Everything the subagent needs: it sees none of the delegating conversation. */
  readonly prompt: string
  readonly isolation: TaskHeader["isolation"]
  /** `provider/model`. */
  readonly model: string
}

export type TaskState = "running" | "waiting for approval" | "finished" | "failed" | "cancelled"

export interface Task {
  readonly id: string
  /** The delegating session. */
  readonly parentId: string
  readonly header: SessionHeader
  readonly task: TaskHeader
  /** Its current runner, or the last one. */
  readonly job: Job
  /** Every runner it has had, oldest first: a task spoken to after it finished gets a new one. */
  readonly runners: ReadonlyArray<Job>
}

/** A task as it stands, for a status line or a report. */
export interface TaskStatus {
  readonly state: TaskState
  readonly startedMs: number
  readonly endedMs: number | undefined
  /** What it is doing: the tool call in flight, or `thinking`. */
  readonly step: string | undefined
  readonly turns: number
  /** The output of its last finished turn. */
  readonly output: string | undefined
  /** The root span of that turn. */
  readonly result: SessionSpanRef | undefined
}

// --- approvals across processes ---------------------------------------------

/** A tool call in a served session that is waiting for a person. */
export const ApprovalFile = Schema.Struct({
  tool: Schema.String,
  input: Schema.Json,
  trace_id: Schema.String,
  span_id: Schema.String,
  user_id: Schema.String,
  prompt: Schema.String,
  cwd: Schema.String,
  reason: Schema.optionalKey(Schema.String),
})

export type ApprovalFile = typeof ApprovalFile.Type

const DecisionFile = Schema.Struct({ decision: Schema.Literals(["allow", "deny"]) })
const parseApproval = parser(ApprovalFile)
const printApproval = printer(ApprovalFile)
const parseDecision = parser(DecisionFile)
const printDecision = printer(DecisionFile)

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Requests and decisions travel as files outside the session tree: the
 * decision itself is recorded on the `TOOL` span, as always, by the process
 * that asked.
 */
export class ApprovalDesk {
  private readonly root: string

  constructor(store: Store) {
    this.root = path.join(store.home, "approvals")
  }

  private file(sessionId: string, spanId: string, kind: "request" | "decision"): string {
    return path.join(this.root, sessionId, `${spanId}.${kind}.json`)
  }

  /** Ask whoever is watching the session, and wait for an answer. */
  ask(sessionId: string, request: ApprovalFile, signal: AbortSignal): Promise<"allow" | "deny"> {
    const decision = this.file(sessionId, request.span_id, "decision")
    const asked = this.file(sessionId, request.span_id, "request")

    fs.mkdirSync(path.dirname(asked), { recursive: true })
    fs.writeFileSync(asked, printApproval(request))

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const answer = parseDecision(readText(decision) ?? "")

        if (answer === undefined && !signal.aborted) return

        clearInterval(timer)
        fs.rmSync(asked, { force: true })
        fs.rmSync(decision, { force: true })
        resolve(answer?.decision ?? "deny")
      }, 250)
    })
  }

  /** The requests of a session nobody has answered yet. */
  waiting(sessionId: string): Array<ApprovalFile> {
    let names: Array<string>

    try {
      names = fs.readdirSync(path.join(this.root, sessionId))
    } catch {
      return []
    }

    return names
      .filter((name) => name.endsWith(".request.json"))
      .flatMap((name) => parseApproval(readText(path.join(this.root, sessionId, name)) ?? "") ?? [])
      .filter((request) => !fs.existsSync(this.file(sessionId, request.span_id, "decision")))
  }

  answer(sessionId: string, spanId: string, decision: "allow" | "deny"): void {
    fs.writeFileSync(this.file(sessionId, spanId, "decision"), printDecision({ decision }))
  }
}

// --- tasks -------------------------------------------------------------------

type Mutable<A> = { -readonly [K in keyof A]: A[K] }

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40) || "task"

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

const msOf = (iso: string): number => Number(isoToNs(iso) / 1_000_000n)

export class Tasks {
  readonly approvals: ApprovalDesk
  private readonly store: Store
  private readonly jobs: Jobs
  private readonly options: TaskOptions

  constructor(store: Store, jobs: Jobs, options: TaskOptions) {
    this.store = store
    this.jobs = jobs
    this.options = options
    this.approvals = new ApprovalDesk(store)
  }

  /** Whether this process can start subagents at all. */
  get available(): boolean {
    return this.options.runner !== undefined
  }

  // --- finding ------------------------------------------------------------

  /** The tasks a session has delegated, oldest first. */
  list(parentId: string): Array<Task> {
    const runners = new Map<string, Array<Job>>()

    for (const job of this.jobs.list(parentId)) {
      if (job.task === undefined) continue

      runners.set(job.task.id, [...(runners.get(job.task.id) ?? []), job])
    }

    return [...runners.values()].flatMap((jobs) => {
      const job = jobs.at(-1)
      const header = job?.task === undefined ? undefined : this.store.readHeader(job.task.session_id)

      return job === undefined || header?.task === undefined
        ? []
        : { id: header.task.id, parentId, header, task: header.task, job, runners: jobs }
    })
  }

  find(parentId: string, id: string): Task | undefined {
    return this.list(parentId).find((task) => task.id === id)
  }

  /** The task whose runner this job is. */
  of(job: Job): Task | undefined {
    return job.task === undefined ? undefined : this.find(job.session_id, job.task.id)
  }

  // --- starting and steering ----------------------------------------------

  private run(parentId: string, header: SessionHeader, task: TaskHeader, tool: Delegator["span"]): Job {
    const runner = this.options.runner

    if (runner === undefined) throw new Error("This oi cannot start subagents.")

    const job = this.jobs.start({
      sessionId: parentId,
      command: runner(header.id, task.model),
      cwd: header.cwd,
      tool,
      task: { id: task.id, session_id: header.id },
    })

    this.jobs.toBackground(job, "requested")

    return job
  }

  /** A git worktree and branch for the task, starting from the delegator's current commit. */
  private worktree(
    cwd: string,
    id: string,
    title: string,
  ): NonNullable<TaskHeader["worktree"]> & { cwd: string } {
    const top = git(cwd, ["rev-parse", "--show-toplevel"])
    const base = git(cwd, ["rev-parse", "HEAD"])

    if (top === undefined || base === undefined)
      throw new Error(
        `${cwd} is not a git checkout with a commit, so it cannot have a worktree. Use isolation "shared".`,
      )

    const branch = `oi/${slug(title)}-${id}`
    const dir = path.join(this.store.home, "worktrees", id)

    fs.mkdirSync(path.dirname(dir), { recursive: true })

    if (git(top, ["worktree", "add", "-b", branch, dir, base], WORKTREE_TIMEOUT_MS) === undefined)
      throw new Error(`git could not create a worktree at ${dir} on a new branch ${branch}.`)

    // The same place inside the new checkout as the delegator is in its own.
    const inside = path.relative(fs.realpathSync(top), fs.realpathSync(cwd))

    return { path: dir, branch, base, cwd: path.join(dir, inside) }
  }

  /** Start a subagent on a brief. Throws with a message for the model when it cannot. */
  delegate(from: Delegator, brief: Brief): Task {
    if (!this.available) throw new Error("This oi cannot start subagents.")

    const limit = this.options.limit ?? DEFAULT_LIMIT
    const running = this.list(from.sessionId).filter((task) => this.jobs.state(task.job).state === "running")

    if (running.length >= limit)
      throw new Error(
        `${running.length} tasks are already running, which is the limit (max_tasks). Delegate this one when a result is delivered, or do it here.`,
      )

    const id = randomBytes(4).toString("hex")
    const worktree = brief.isolation === "worktree" ? this.worktree(from.cwd, id, brief.title) : undefined

    const task: Mutable<TaskHeader> = {
      id,
      title: brief.title,
      isolation: brief.isolation,
      model: brief.model,
    }

    if (worktree !== undefined)
      task.worktree = { path: worktree.path, branch: worktree.branch, base: worktree.base }

    const origin = { session_id: from.sessionId, ...from.span }

    const header = this.store.createSession(worktree?.cwd ?? from.cwd, newSessionId(), {
      parent: origin,
      task,
    })

    // The brief is the session's first prompt, on disk before anything reads it.
    this.store.writeInbox(header.id, { user_id: from.userId, text: brief.prompt, origin })

    const job = this.run(from.sessionId, header, task, from.span)

    return { id, parentId: from.sessionId, header, task, job, runners: [job] }
  }

  /** Send a task a follow-up. It reads it after its current turn, or wakes up to. */
  message(from: Delegator, task: Task, text: string): void {
    this.store.writeInbox(task.header.id, {
      user_id: from.userId,
      text,
      origin: { session_id: from.sessionId, ...from.span },
    })

    this.wake(task, from.span)
  }

  /** A prompt typed to the task by a person looking at it, not sent by a tool call. */
  say(task: Task, userId: string, text: string): void {
    this.store.writeInbox(task.header.id, { user_id: userId, text })
    this.wake(task)
  }

  /** Give a task with unread prompts a runner, if it has none. Returns whether one was started. */
  wake(task: Task, tool: Delegator["span"] = task.job.tool): boolean {
    if (this.jobs.state(task.job).state === "running") return false

    if (pendingInbox(this.store, task.header.id).length === 0) return false

    this.run(task.parentId, task.header, task.task, tool)

    return true
  }

  /** Stop a task, and the commands it left running. Its session and worktree stay. */
  cancel(task: Task): void {
    this.jobs.kill(task.job)
    this.jobs.killAll(task.header.id)
  }

  // --- describing ---------------------------------------------------------

  status(task: Task): TaskStatus {
    const job = this.jobs.state(task.job)
    const sessionId = task.header.id
    const view = loadSession(this.store, sessionId)
    const last = view.turns.findLast((turn) => turn.state !== "running")

    const open = this.store
      .listTraceIds(sessionId)
      .slice(-1)
      .flatMap((traceId) => this.store.readTrace(sessionId, traceId).open)
      .map((entry) => entry.span)

    const tool = open.findLast((span) => kindOf(span) === "TOOL")

    const step =
      tool !== undefined
        ? clip(`${tool.name} ${stringAttr(tool, OI.INPUT_VALUE) ?? ""}`.replaceAll(/\s+/g, " "), 80)
        : open.some((span) => kindOf(span) === "LLM")
          ? "thinking"
          : undefined

    return {
      state: this.stateOf(
        job,
        last?.state,
        tool !== undefined && readMetadata(tool).awaiting_approval === true,
      ),
      startedMs: msOf(task.runners[0]?.started_at ?? task.job.started_at),
      endedMs: job.state === "running" ? undefined : job.endedMs,
      step: job.state === "running" ? step : undefined,
      turns: view.turns.length,
      output: last?.output,
      result:
        last === undefined
          ? undefined
          : { session_id: sessionId, trace_id: last.trace_id, span_id: last.root.context.span_id },
    }
  }

  private stateOf(job: JobState, lastTurn: string | undefined, awaiting: boolean): TaskState {
    if (job.state === "running") return awaiting ? "waiting for approval" : "running"

    if (job.state === "killed") return "cancelled"

    return job.code === 0 && lastTurn === "complete" ? "finished" : "failed"
  }

  /** `finished after 12m03s`, `running for 40s: bash pnpm e2e`. */
  describe(status: TaskStatus, nowMs: number = Date.now()): string {
    if (status.endedMs === undefined) {
      const running = `${status.state} for ${formatDuration(nowMs - status.startedMs)}`

      return status.step === undefined ? running : `${running}: ${status.step}`
    }

    return `${status.state} after ${formatDuration(status.endedMs - status.startedMs)}`
  }

  /** What a task's worktree holds beyond the commit it started from. */
  private changes(worktree: NonNullable<TaskHeader["worktree"]>) {
    return {
      commits: Number(git(worktree.path, ["rev-list", "--count", `${worktree.base}..HEAD`]) ?? "0"),
      dirty: (git(worktree.path, ["status", "--porcelain"]) ?? "") !== "",
    }
  }

  /** Completion must not remove the cwd needed by a later task_message or resume. */
  tidy(_task: Task): void {
    // Kept as a lifecycle hook for callers; worktrees and branches need explicit cleanup.
  }

  /** Where a task's work is, for the delegating agent. */
  private checkout(task: Task): string | undefined {
    const worktree = task.task.worktree

    if (worktree === undefined) return undefined

    if (!fs.existsSync(worktree.path)) return `worktree: missing at ${worktree.path}`

    const { commits, dirty } = this.changes(worktree)

    return [
      `worktree: ${worktree.path}`,
      `branch: ${worktree.branch} (${commits} commit${commits === 1 ? "" : "s"} since ${worktree.base.slice(0, 7)}${dirty ? ", plus uncommitted changes" : ""})`,
    ].join("\n")
  }

  /** A finished task's result, as the delegating agent is told about it. */
  report(task: Task, status: TaskStatus): string {
    const exit = this.jobs.state(task.job)

    const outcome =
      status.output !== undefined && status.output !== ""
        ? `--- its report ---\n${status.output}`
        : `It left no report. Its runner ${exit.state === "exited" ? `exited with code ${exit.code}` : "was stopped"}; the runner's output is at ${this.jobs.logPath(task.job)}`

    return [
      `task ${task.id} "${task.task.title}": ${this.describe(status)}, in ${status.turns} turn${status.turns === 1 ? "" : "s"}`,
      `session: ${task.header.id}`,
      this.checkout(task),
      outcome,
    ]
      .filter((line) => line !== undefined)
      .join("\n")
  }

  /** What a delivery of this task's result points at. */
  delivery(task: Task, status: TaskStatus): Delivery {
    const delivery: Delivery = { kind: "task", id: task.id, ...task.job.tool }

    return status.result === undefined ? delivery : { ...delivery, result: status.result }
  }
}
