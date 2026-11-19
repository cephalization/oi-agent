/**
 * The engine: the host side of a set of sessions.
 *
 * It owns the store, runs turns one at a time per session, and brokers tool
 * approvals. Every interface (terminal, share peer, viewer) talks to this and
 * to the store's event stream; none of them holds session state of its own.
 */
import { Effect, Exit, Fiber, Layer, Option, type Schema } from "effect"
import { attachmentsFrom, isProblem, type NewImage } from "./attachments.ts"
import {
  type Approval,
  type ApprovalDecision,
  type ApprovalRequest,
  Approver,
  runTurn,
  type TurnEnv,
  type TurnResult,
} from "./agent.ts"
import type { Config } from "./config.ts"
import {
  correctionAfter,
  correctionEvidence,
  recordCorrection,
  type CorrectionCheckpoint,
  type CorrectionStop,
} from "./correction.ts"
import {
  askDecision,
  APPROVAL_QUESTIONS,
  approvalConcerns,
  clearsThresholds,
  decisionSpan,
  type DecisionSettings,
  mustAsk,
} from "./decision.ts"
import { completeHandoff, recoverHandoff } from "./handoff.ts"
import { handoffSeedFor, loadSession, pendingInbox } from "./fold.ts"
import {
  type AnnotationFile,
  type AttachmentRef,
  type EngineMetadata,
  type InboxFile,
  OI,
  readMetadata,
  writeMetadata,
  type SessionHeader,
  stringAttr,
} from "./format.ts"
import { newSpanId, newTraceId, nowNs, nsToIso } from "./ids.ts"
import { describeState, type Job, jobReport, type Jobs, jobsOf } from "./jobs.ts"
import { type Task, Tasks } from "./tasks.ts"
import { type Model, ModelError } from "./model.ts"
import { Redactor } from "./redact.ts"
import { readRules } from "./rules.ts"
import type { Store } from "./store.ts"
import { builtinTools, type ToolSpec } from "./tools.ts"

/**
 * `ask` waits for a human, `allow` and `deny` answer every call alike, and
 * `auto` lets a decision model allow calls it is confident are safe and asks
 * a human about the rest. Auto mode never denies on its own.
 */
export type ApprovalMode = "ask" | "allow" | "deny" | "auto"

/** A decision model and the key to call it with. */
export interface Decider {
  readonly settings: DecisionSettings
  readonly apiKey: string
}

export interface Prompt {
  readonly text: string
  readonly userId: string
  /** Trace to continue from. Omitted means the session head; `null` starts over. */
  readonly previous?: string | null
  readonly operation?: EngineMetadata["operation"] | undefined
  readonly handoffSeed?: EngineMetadata["handoff_seed"] | undefined
  readonly inboxId?: string | undefined
  /** Images sent with the prompt: references `attach` returned for this session. */
  readonly attachments?: ReadonlyArray<AttachmentRef> | undefined
  readonly delivers?: EngineMetadata["delivers"]
  readonly origin?: EngineMetadata["origin"]
}

/** What a person says to a session that is already busy: to its running turn, or after it. */
export type Said = Pick<Prompt, "text" | "userId" | "attachments">

const inboxEntry = (prompt: Said): Pick<InboxFile, "user_id" | "text" | "attachments"> => {
  const entry = { user_id: prompt.userId, text: prompt.text }

  return prompt.attachments === undefined || prompt.attachments.length === 0
    ? entry
    : { ...entry, attachments: prompt.attachments }
}

/** A command or task running in the background of a session. */
export interface BackgroundWork {
  readonly kind: "job" | "task"
  readonly id: string
  /** The command, or the task's title. */
  readonly title: string
  /** `running for 2m14s: bash pnpm e2e`. */
  readonly status: string
  /** It cannot go on until a person answers. */
  readonly waiting?: boolean
}

/** How often an attended session looks for approval requests from its tasks. */
const APPROVALS_EVERY_MS = 500

/** `user.id` of a turn oi started itself, to deliver results; nobody typed its text. */
export const SYSTEM_USER = "oi"

/** The text of a turn that hands the model the results of its background work. */
const deliveryText = (results: ReadonlyArray<InboxFile>): string =>
  [
    "<background-results>",
    "oi is delivering the results of background work you started. This is not a message from the user.",
    "",
    results.map((entry) => entry.text).join("\n\n"),
    "</background-results>",
    "",
    results.length === 1
      ? "Carry on with the work this result was for. If nothing is left to do, tell the user the outcome in a sentence or two."
      : "Carry on with the work these results were for, and give the user one short digest of them: what needs their decision first, then what failed, then what is done.",
  ].join("\n")

export type TurnOutcome =
  | { readonly ok: true; readonly result: TurnResult }
  | { readonly ok: false; readonly interrupted: boolean; readonly message: string }

export interface EngineOptions {
  readonly store: Store
  readonly config: Config
  readonly model: Layer.Layer<Model>
  /** Builds a model for new settings, so `configure` can switch model or effort between turns. */
  readonly modelFor?: ((config: Config) => Layer.Layer<Model>) | undefined
  readonly approvals: ApprovalMode
  readonly tools?: ReadonlyArray<ToolSpec>
  readonly redactor?: Redactor
  /** Directory with the agent's shipped source and docs. */
  readonly selfDir?: string | undefined
  /** The decision model for `auto` approvals; without one, auto mode asks a human every time. */
  readonly decider?: Decider | undefined
  /** How to start a subagent's runner (see `TaskOptions.runner`). Absent: this engine cannot delegate. */
  readonly runner?: ((sessionId: string, model: string) => string) | undefined
  /**
   * This engine serves a subagent's session with nobody at it: a tool call
   * that needs a person waits for the delegating session to answer.
   */
  readonly served?: boolean | undefined
}

/** Hooks that run around a turn: evals and feedback plug in here. */
export interface TurnHooks {
  /** Feedback to inject into the next turn of a session. */
  readonly pendingFeedback: (sessionId: string) => ReadonlyArray<AnnotationFile>
  readonly afterTurn: (
    sessionId: string,
    traceId: string,
    obligations?: CorrectionCheckpoint["obligations"],
  ) => Promise<EvaluationResults | void>
}

interface EvaluationResults {
  readonly annotations: ReadonlyArray<AnnotationFile>
  readonly corrections: ReadonlyMap<string, Schema.Json>
}

const NO_HOOKS: TurnHooks = { pendingFeedback: () => [], afterTurn: () => Promise.resolve(undefined) }

interface Running {
  readonly fiber: Fiber.Fiber<TurnResult, ModelError>
  /** A `/compact` or `/handoff`: it makes one model call and reads nothing said to it. */
  readonly operation: boolean
}

/** What a turn that waited in the queue comes to when its session was left before its place came. */
const LEFT: TurnOutcome = { ok: false, interrupted: true, message: "interrupted" }

/** Settings that can change while the engine runs. */
export interface ModelChoice {
  readonly provider?: string
  readonly model?: string
  readonly effort?: Config["effort"]
}

export class Engine {
  readonly store: Store
  readonly redactor: Redactor
  readonly tools: ReadonlyArray<ToolSpec>
  readonly selfDir: string | undefined
  readonly decider: Decider | undefined
  readonly jobs: Jobs
  readonly tasks: Tasks
  hooks: TurnHooks = NO_HOOKS
  /**
   * Asked before results are delivered to a session: an interface answers
   * `false` while the person is in the middle of something (typing, say),
   * and calls `drainInbox` when they are not. Results wait in the inbox.
   */
  calm: (sessionId: string) => boolean = () => true
  private settings: Config
  private model: Layer.Layer<Model>
  private readonly modelFor: ((config: Config) => Layer.Layer<Model>) | undefined
  private approvalMode: ApprovalMode
  private readonly queues = new Map<string, Promise<void>>()
  private readonly queuedInputs = new Map<string, number>()
  private readonly interruptions = new Map<string, number>()
  private readonly running = new Map<string, Running>()
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>()
  private readonly approvalListeners = new Set<(request: ApprovalRequest) => void>()
  /** Sessions someone is here for: their inbox runs as it fills. */
  private readonly attended = new Set<string>()
  /** Sessions their person has left: nothing waiting in them starts until someone is back. */
  private readonly away = new Set<string>()
  private readonly cancellations = new Map<string, number>()
  /** Inbox prompts already in a session's queue. */
  private readonly queuedPrompts = new Set<string>()
  /** Sessions with a delivery turn already in the queue. */
  private readonly queuedDeliveries = new Set<string>()
  private readonly served: boolean
  /** Per attended session: the check for its tasks' approval requests. */
  private readonly watches = new Map<string, ReturnType<typeof setInterval>>()
  /** Requests from tasks that nobody has answered yet, by span. */
  private readonly relayed = new Map<string, ApprovalRequest>()

  constructor(options: EngineOptions) {
    this.store = options.store
    this.settings = options.config
    this.model = options.model
    this.modelFor = options.modelFor
    this.approvalMode = options.approvals
    this.tools = options.tools ?? builtinTools
    this.redactor = options.redactor ?? new Redactor()
    this.selfDir = options.selfDir
    this.decider = options.decider
    this.served = options.served === true
    this.jobs = jobsOf(this.store)
    this.tasks = new Tasks(this.store, this.jobs, { runner: options.runner, limit: options.config.max_tasks })
    this.jobs.onEnd((job) => this.jobEnded(job))
  }

  /** Stop watching background work. It keeps running, and reports when a session is next opened. */
  close(): void {
    for (const sessionId of this.watches.keys()) this.leave(sessionId)

    this.jobs.close()
  }

  // --- sessions -----------------------------------------------------------

  createSession(cwd: string): SessionHeader {
    return this.store.createSession(cwd)
  }

  /** The settings in effect. `configure` can change model and effort. */
  get config(): Config {
    return this.settings
  }

  /**
   * Switch provider, model or effort. A turn already running keeps what it
   * started with; the next turn uses the new settings. Returns false when
   * this engine was built with a fixed model. Throws, changing nothing, when
   * the new model cannot be built (a provider without credentials, say).
   */
  configure(choice: ModelChoice): boolean {
    if (this.modelFor === undefined) return false

    const next = { ...this.settings }

    if (choice.provider !== undefined) next.provider = choice.provider

    if (choice.model !== undefined) next.model = choice.model

    if (choice.effort !== undefined) next.effort = choice.effort

    this.model = this.modelFor(next)
    this.settings = next

    return true
  }

  // --- approvals ----------------------------------------------------------

  get approvals(): ApprovalMode {
    return this.approvalMode
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.approvalMode = mode
  }

  /**
   * Be told when a tool call is waiting for a decision. A task's request
   * that is still unanswered is told again to each new listener: the
   * interface that first showed it may be gone (the terminal moved to
   * another session), and the task is still waiting.
   */
  onApproval(listener: (request: ApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener)

    for (const request of this.relayed.values()) listener(request)

    return () => {
      this.approvalListeners.delete(listener)
    }
  }

  /** Answer a waiting tool call. Returns false if nothing was waiting. */
  resolveApproval(spanId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pending.get(spanId)

    if (resolve === undefined) return false

    this.pending.delete(spanId)
    resolve(decision)

    return true
  }

  /** Wait for a human to answer: here, or at the session that delegated this one. */
  private askHuman(sessionId: string, request: ApprovalRequest): Effect.Effect<ApprovalDecision> {
    if (this.served)
      return Effect.callback<ApprovalDecision>((resume) => {
        const abort = new AbortController()

        void this.tasks.approvals
          .ask(sessionId, request, abort.signal)
          .then((decision) => resume(Effect.succeed(decision)))

        return Effect.sync(() => abort.abort())
      })

    return Effect.callback<ApprovalDecision>((resume) => {
      this.pending.set(request.span_id, (decision) => resume(Effect.succeed(decision)))

      for (const listener of this.approvalListeners) listener(request)

      return Effect.sync(() => {
        this.pending.delete(request.span_id)
      })
    })
  }

  /**
   * Auto mode: hard rules first, then one question to the decision model,
   * recorded as a `DECISION` span under the `TOOL` span it decides. Only a
   * confident answer on every question allows the call; anything else, a
   * failed call included, goes to a human, as in `ask` mode.
   */
  private autoApprove(sessionId: string, request: ApprovalRequest): Effect.Effect<Approval> {
    const human = (asked_because: string, answers?: Record<string, number>) =>
      Effect.map(this.askHuman(sessionId, { ...request, reason: asked_because }), (decision): Approval => ({
        decision,
        asked_because,
        answers,
      }))

    const rule = mustAsk(request.tool, request.input, request.cwd)

    if (rule !== undefined) return human(`always asked: ${rule}`)

    const decider = this.decider

    if (decider === undefined) return human("no decision model is set up")

    const state = {
      tool: request.tool,
      input: this.redactor.scrub(JSON.stringify(request.input)),
      working_directory: request.cwd,
      user_prompt: this.redactor.scrub(request.prompt),
      project_rules: readRules(request.cwd),
    }

    const store = this.store
    const redactor = this.redactor

    return Effect.gen(function* () {
      const span = yield* Effect.orDie(Effect.currentSpan)

      const call = yield* Effect.promise(() =>
        askDecision(decider.settings, decider.apiKey, "approval", state, APPROVAL_QUESTIONS, redactor),
      )

      store.endSpan(sessionId, decisionSpan(sessionId, span, call))

      if (call.error !== undefined) return yield* human(`the decision model failed: ${call.error}`)

      const answers = Object.fromEntries(call.nouls)

      if (clearsThresholds(call.nouls))
        return { decision: "allow", by: `auto:${call.model ?? decider.settings.model}`, answers }

      return yield* human(
        `the decision model was not confident it is safe: ${approvalConcerns(call.nouls).join("; ")}`,
        answers,
      )
    })
  }

  private approver(sessionId: string): Layer.Layer<Approver> {
    return Layer.succeed(Approver, {
      decide: (request) => {
        const mode = this.approvalMode

        if (mode === "allow" || mode === "deny") return Effect.succeed({ decision: mode })

        if (mode === "auto") return this.autoApprove(sessionId, request)

        return Effect.map(this.askHuman(sessionId, request), (decision): Approval => ({ decision }))
      },
    })
  }

  // --- turns --------------------------------------------------------------

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Stop the turn a session is running. The spans it wrote stay on disk. */
  /**
   * Stop the running turn. `leaving`: whoever was at the session is going
   * (quitting, switching, reloading), so what waits in its inbox is not
   * started as the turn ends. It runs when the session is next served.
   */
  interrupt(sessionId: string, leaving: boolean = false): void {
    this.interruptions.set(sessionId, (this.interruptions.get(sessionId) ?? 0) + 1)

    // Before the check below: with no turn running, one may still be waiting behind evaluators.
    if (leaving) this.away.add(sessionId)

    const running = this.running.get(sessionId)

    if (running === undefined) return

    Effect.runFork(Fiber.interrupt(running.fiber))
  }

  /** Escape: stop all work and withdraw unread prompts, returning them for editing. */
  cancel(sessionId: string): Array<InboxFile> {
    this.cancellations.set(sessionId, (this.cancellations.get(sessionId) ?? 0) + 1)
    this.interrupt(sessionId, true)

    const entries = pendingInbox(this.store, sessionId)
    const time = nsToIso(nowNs())

    this.store.endSpan(sessionId, {
      name: "session.cancel",
      context: { trace_id: newTraceId(), span_id: newSpanId() },
      span_kind: "SPAN_KIND_INTERNAL",
      parent_id: null,
      start_time: time,
      end_time: time,
      status_code: "OK",
      status_message: "",
      attributes: {
        [OI.SESSION_ID]: sessionId,
        [OI.SPAN_KIND]: "CHAIN",
        [OI.METADATA]: writeMetadata(undefined, {
          cancelled_inbox: [
            ...entries.map((entry) => entry.id),
            ...this.jobs.running(sessionId).map((job) => `job-${job.id}`),
          ],
        }),
      },
      events: [],
    })

    for (const task of this.tasks.list(sessionId)) {
      this.cancel(task.header.id)
      this.tasks.cancel(task)

      // A killed runner cannot remove its approval request. Do not let the
      // watcher put that dead task's dialog back in front of the user.
      for (const request of this.tasks.approvals.waiting(task.header.id)) {
        if (!this.resolveApproval(request.span_id, "deny"))
          this.tasks.approvals.answer(task.header.id, request.span_id, "deny")
      }
    }

    this.jobs.killAll(sessionId)

    return entries.filter((entry) => entry.delivers === undefined)
  }

  /**
   * Run `task` after everything already queued for the session, and `after`
   * before anything queued later. A session has a single writer.
   */
  private enqueue<A>(
    sessionId: string,
    task: () => Promise<A>,
    after: (result: A) => Promise<void>,
  ): Promise<A> {
    const result = (this.queues.get(sessionId) ?? Promise.resolve()).then(task)

    this.queues.set(
      sessionId,
      result.then(after).catch(() => undefined),
    )

    return result
  }

  /** Evaluators run after the answer is delivered but before the next turn starts. */
  private async afterTurn(sessionId: string, outcome: TurnOutcome | undefined): Promise<void> {
    if (outcome?.ok !== true) return

    const interruption = this.interruptions.get(sessionId)
    const traceId = outcome.result.traceId

    // Repeated delivery of the same evaluation cycle cannot reopen a chain.
    if (this.settings.auto_correction && correctionAfter(this.store, sessionId, traceId) !== undefined) return

    const results = await this.hooks.afterTurn(sessionId, traceId).catch(() => undefined)

    if (!this.settings.auto_correction || this.served || results === undefined) return

    const root = this.store.readTraceRoots(sessionId, traceId).ended[0]
    const failures = results.annotations.filter((entry) => entry.annotation.metadata?.["feedback"] === true)

    if (root === undefined || failures.length === 0) return

    const state: CorrectionCheckpoint = {
      origin: root.context,
      after: root.context,
      attempts: 0,
      budget: this.settings.max_correction_turns,
      triggers: failures.map((entry) => entry.id),
      obligations: failures.flatMap((entry) => {
        const definition = results.corrections.get(entry.id)

        return definition === undefined ? [] : [{ original: entry.id, latest: entry.id, definition }]
      }),
      fingerprint: "",
    }

    const { fingerprint } = correctionEvidence(this.store, sessionId, state)

    const stop =
      this.correctionGuard(sessionId, interruption) ??
      (state.obligations.length === 0 ? "unrepairable" : undefined)

    const next = { ...state, fingerprint }

    if (stop !== undefined) await recordCorrection(this.store, sessionId, { ...next, stop })
    else await this.continueCorrection(sessionId, next, interruption)
  }

  private correctionGuard(sessionId: string, interruption: number | undefined): CorrectionStop | undefined {
    if (this.away.has(sessionId) || interruption !== this.interruptions.get(sessionId)) return "interrupted"

    if (!this.settings.auto_correction) return "disabled"

    if (
      (this.queuedInputs.get(sessionId) ?? 0) > 0 ||
      pendingInbox(this.store, sessionId).some((entry) => entry.delivers === undefined)
    )
      return "superseded"

    return undefined
  }

  private async continueCorrection(
    sessionId: string,
    state: CorrectionCheckpoint,
    interruption: number | undefined,
  ) {
    const ref = await recordCorrection(this.store, sessionId, state)

    this.queueCorrection(sessionId, state, ref, interruption)
  }

  private queueCorrection(
    sessionId: string,
    state: CorrectionCheckpoint,
    ref: CorrectionCheckpoint["after"],
    interruption: number | undefined,
  ): void {
    void this.enqueue(
      sessionId,
      async () => {
        const latest = correctionAfter(this.store, sessionId, state.after.trace_id)

        if (latest?.ref.span_id !== ref.span_id || latest.state.stop !== undefined) return

        const view = loadSession(this.store, sessionId)

        const started = view.turns.some(
          (turn) => readMetadata(turn.root).correction?.checkpoint.span_id === ref.span_id,
        )

        if (started) return

        const stop =
          this.correctionGuard(sessionId, interruption) ??
          (view.head?.trace_id !== state.after.trace_id ? "superseded" : undefined)

        const latestIds = new Set(
          state.obligations.flatMap((entry) => (entry.latest === undefined ? [] : [entry.latest])),
        )

        const feedback = this.hooks.pendingFeedback(sessionId).filter((entry) => latestIds.has(entry.id))

        if (stop !== undefined || feedback.length !== latestIds.size) {
          await recordCorrection(this.store, sessionId, { ...state, stop: stop ?? "unrepairable" })

          return
        }

        const attempt = state.attempts + 1

        const outcome = await this.execute(
          sessionId,
          {
            text: `Automatic evaluator correction attempt ${attempt} of ${state.budget} (not a user message). Inspect the recorded failures above, correct the original work where possible, and verify the correction. Follow the original user instructions, including any verification steps, and report anything you cannot fix.`,
            userId: SYSTEM_USER,
            previous: state.after.trace_id,
          },
          {
            origin: state.origin,
            checkpoint: ref,
            attempt,
            budget: state.budget,
            triggers: feedback.map((entry) => entry.id),
          },
          feedback,
        )

        const root = loadSession(this.store, sessionId).head?.root
        const updated = { ...state, attempts: attempt, after: root?.context ?? state.after }

        if (!outcome.ok) {
          await recordCorrection(this.store, sessionId, {
            ...updated,
            stop: outcome.interrupted ? "interrupted" : "unrepairable",
          })

          return
        }

        await this.recheckCorrection(sessionId, updated, interruption)
      },
      () => Promise.resolve(),
    )
  }

  private async recheckCorrection(
    sessionId: string,
    state: CorrectionCheckpoint,
    interruption: number | undefined,
  ) {
    const results = await this.hooks
      .afterTurn(sessionId, state.after.trace_id, state.obligations)
      .catch(() => undefined)

    const verdicts = state.obligations.map((entry) =>
      results?.annotations.find(
        (annotation) =>
          annotation.target.trace_id === state.after.trace_id &&
          annotation.annotation.metadata?.["rechecks"] === entry.original &&
          annotation.annotation.label !== "skipped" &&
          annotation.annotation.label !== "pending",
      ),
    )

    const obligations = state.obligations.map((entry, index) => {
      const verdict = verdicts[index]

      if (verdict === undefined) return entry

      if (verdict.annotation.metadata?.["failed"] === true) return { ...entry, latest: verdict.id }

      return { original: entry.original, definition: entry.definition }
    })

    const next = { ...state, obligations }
    const { denied, fingerprint } = correctionEvidence(this.store, sessionId, next)
    const guard = this.correctionGuard(sessionId, interruption)
    let stop: CorrectionStop | undefined = guard

    if (stop === undefined) {
      if (verdicts.some((entry) => entry === undefined)) stop = "unrepairable"
      else if (obligations.every((entry) => entry.latest === undefined)) stop = "passed"
      else if (denied) stop = "unrepairable"
      else if (state.attempts >= state.budget) stop = "budget exhausted"
      else if (state.fingerprint === fingerprint) stop = "stalled"
    }

    const updated = { ...next, fingerprint }

    if (stop !== undefined) await recordCorrection(this.store, sessionId, { ...updated, stop })
    else await this.continueCorrection(sessionId, updated, interruption)
  }

  /** A started attempt without a completed decision is never replayed. */
  private async resumeCorrection(sessionId: string, supersede: boolean = false): Promise<void> {
    const root = loadSession(this.store, sessionId).head?.root

    if (root === undefined) return

    const checkpoint = correctionAfter(this.store, sessionId, root.context.trace_id)

    if (checkpoint !== undefined) {
      if (checkpoint.state.stop !== undefined) return

      if (supersede)
        await recordCorrection(this.store, sessionId, { ...checkpoint.state, stop: "superseded" })
      else
        this.queueCorrection(sessionId, checkpoint.state, checkpoint.ref, this.interruptions.get(sessionId))

      return
    }

    const attempt = readMetadata(root).correction
    const previous = readMetadata(root).previous

    if (attempt === undefined || previous === undefined || previous === null) return

    const prior = correctionAfter(this.store, sessionId, previous.trace_id)

    if (prior?.ref.span_id === attempt.checkpoint.span_id)
      await recordCorrection(this.store, sessionId, {
        ...prior.state,
        after: root.context,
        attempts: attempt.attempt,
        stop: "interrupted",
      })
  }

  /**
   * Run a prompt as a turn. Turns in one session run one after another, in
   * the order they were submitted.
   */
  submit(sessionId: string, prompt: Prompt): Promise<TurnOutcome> {
    const cancellation = this.cancellations.get(sessionId)

    if (prompt.inboxId === undefined) {
      this.away.delete(sessionId)
      this.queuedInputs.set(sessionId, (this.queuedInputs.get(sessionId) ?? 0) + 1)
    }

    return this.enqueue(
      sessionId,
      async () => {
        if (prompt.inboxId === undefined)
          this.queuedInputs.set(sessionId, (this.queuedInputs.get(sessionId) ?? 1) - 1)

        // Read from the inbox before the session was left: it stays there for whoever serves it next.
        if (
          cancellation !== this.cancellations.get(sessionId) ||
          (prompt.inboxId !== undefined && this.away.has(sessionId))
        ) {
          if (prompt.inboxId !== undefined) this.queuedPrompts.delete(prompt.inboxId)

          return LEFT
        }

        // Seed pickup belongs to the engine queue, not to a UI's startup order.
        const handoff = await this.pickupHandoff(sessionId)

        if (handoff !== undefined && !handoff.ok) return handoff

        if (cancellation !== this.cancellations.get(sessionId)) return LEFT

        await this.resumeCorrection(sessionId, true)

        if (cancellation !== this.cancellations.get(sessionId)) return LEFT

        return this.execute(sessionId, prompt)
      },
      (outcome) => (prompt.operation === undefined ? this.afterTurn(sessionId, outcome) : Promise.resolve()),
    )
  }

  /** Consume a durable destination seed once, serialized with all other turns.
   * An interrupted first turn is not retried automatically: tools may have run.
   */
  resumeHandoff(sessionId: string, resumeAutoCorrection: boolean = true): Promise<TurnOutcome | undefined> {
    return this.enqueue(
      sessionId,
      () => {
        for (const turn of loadSession(this.store, sessionId).turns)
          completeHandoff(this.store, sessionId, turn.root)

        return this.pickupHandoff(sessionId)
      },
      (outcome) =>
        outcome === undefined ? this.resumeCorrection(sessionId, !resumeAutoCorrection) : Promise.resolve(),
    )
  }

  /** Whether a turn of this session is running in this process right now. */
  busy(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Whether the turn running here reads what is said to it: slash-command operations do not. */
  steerable(sessionId: string): boolean {
    return !this.away.has(sessionId) && this.running.get(sessionId)?.operation === false
  }

  /**
   * Say something to the turn that is running: it reads it before its next
   * model call, after the tool calls in flight. Returns false, having done
   * nothing, when no turn is running. If the turn ends before it reads the
   * message, the message runs as the next turn instead.
   */
  steer(sessionId: string, prompt: Said): InboxFile | undefined {
    if (!this.steerable(sessionId)) return undefined

    return this.store.writeInbox(sessionId, { ...inboxEntry(prompt), steers: true })
  }

  /**
   * Keep images in a session so a prompt can carry them: the references to
   * pass as a prompt's `attachments`, or why they cannot be attached. The
   * bytes are checked here, for a person at this terminal and for a peer's
   * upload alike, and whether the model can read them is left to its provider.
   */
  attach(sessionId: string, images: ReadonlyArray<NewImage>): Array<AttachmentRef> | string {
    const files = attachmentsFrom(images)

    return isProblem(files) ? files : files.map((file) => this.store.writeAttachment(sessionId, file))
  }

  /**
   * Leave a prompt for after the running turn. It is on disk from here on, so
   * it is not lost with this process: whoever serves the session next runs it.
   */
  queue(sessionId: string, prompt: Said): InboxFile {
    this.away.delete(sessionId)

    const entry = this.store.writeInbox(sessionId, inboxEntry(prompt))

    // A running turn drains the inbox when it ends, which keeps prompts in the order they were sent.
    if (!this.running.has(sessionId)) this.drainInbox(sessionId)

    return entry
  }

  // --- inbox and background work ------------------------------------------

  /**
   * Start serving a session: follow the background jobs it left running, and
   * run what is waiting in its inbox. Results of work that ends while nobody
   * attends a session wait in its inbox until someone does.
   */
  attend(sessionId: string): void {
    this.away.delete(sessionId)
    this.attended.add(sessionId)
    this.jobs.adopt(sessionId)
    this.drainInbox(sessionId)
    this.watch(sessionId)
  }

  /**
   * Answer for a session's tasks without serving the session: the tool calls
   * they need a person for are asked here, and nothing in its inbox is run.
   * For a terminal that opened a task directly, whose delegator may be open,
   * mid-turn, somewhere else.
   */
  watch(sessionId: string): void {
    if (this.watches.has(sessionId)) return

    this.watches.set(
      sessionId,
      setInterval(() => this.relayApprovals(sessionId), APPROVALS_EVERY_MS),
    )
  }

  leave(sessionId: string): void {
    this.attended.delete(sessionId)
    clearInterval(this.watches.get(sessionId))
    this.watches.delete(sessionId)
  }

  /**
   * Put the tool calls that a session's tasks need a person for in front of
   * whoever answers this session's own: same listeners, same `resolveApproval`.
   */
  private relayApprovals(sessionId: string): void {
    for (const task of this.tasks.list(sessionId)) {
      for (const request of this.tasks.approvals.waiting(task.header.id)) {
        if (this.pending.has(request.span_id)) continue

        const label = `task ${task.id} "${task.task.title}"`

        const relayed = {
          ...request,
          reason: request.reason === undefined ? label : `${label}: ${request.reason}`,
        }

        this.relayed.set(request.span_id, relayed)
        this.pending.set(request.span_id, (decision) => {
          this.relayed.delete(request.span_id)
          this.tasks.approvals.answer(task.header.id, request.span_id, decision)
        })

        for (const listener of this.approvalListeners) listener(relayed)
      }
    }
  }

  /** Back at a session this process still serves: what waited while it was left runs now. */
  rejoin(sessionId: string): void {
    this.away.delete(sessionId)
    this.drainInbox(sessionId)
  }

  /**
   * Queue what is waiting in a session's inbox: each prompt from a peer as a
   * turn of its own, and every result of background work together in one.
   * Safe to call at any time, and again after a crash.
   */
  drainInbox(sessionId: string, now: boolean = false): void {
    // Left with `interrupt(sessionId, true)`: nothing starts here until someone is back.
    if (this.away.has(sessionId)) return

    for (const entry of pendingInbox(this.store, sessionId)) {
      if (entry.delivers !== undefined) {
        // `now`: the person asked for their results, whatever they are in the middle of.
        if (now || this.calm(sessionId)) this.queueDelivery(sessionId)

        continue
      }

      // The running turn may still take it; when that turn ends, this runs again.
      if (entry.steers === true && this.running.has(sessionId)) continue

      if (this.queuedPrompts.has(entry.id)) continue

      this.queuedPrompts.add(entry.id)
      void this.submit(sessionId, {
        text: entry.text,
        userId: entry.user_id,
        inboxId: entry.id,
        attachments: entry.attachments,
        origin: entry.origin,
      })
    }
  }

  /**
   * One turn for all the results waiting when its place in the queue comes,
   * so work that finished during a long turn arrives as a single message.
   */
  private queueDelivery(sessionId: string): void {
    if (this.queuedDeliveries.has(sessionId)) return

    this.queuedDeliveries.add(sessionId)
    const cancellation = this.cancellations.get(sessionId)

    void this.enqueue(
      sessionId,
      async () => {
        this.queuedDeliveries.delete(sessionId)

        if (this.away.has(sessionId) || cancellation !== this.cancellations.get(sessionId)) return undefined

        const results = pendingInbox(this.store, sessionId).filter((entry) => entry.delivers !== undefined)

        if (results.length === 0) return undefined

        return this.execute(sessionId, {
          text: deliveryText(results),
          userId: SYSTEM_USER,
          delivers: results.flatMap((entry) =>
            entry.delivers === undefined ? [] : { ...entry.delivers, inbox_id: entry.id },
          ),
        })
      },
      (outcome) => this.afterTurn(sessionId, outcome),
    )
  }

  /** What a finished job has to tell the session that started it: a command's output, or a task's report. */
  private resultOf(job: Job): Pick<InboxFile, "text" | "delivers"> {
    const task = this.tasks.of(job)

    if (task === undefined)
      return {
        text: jobReport(this.jobs, job, this.jobs.state(job)),
        delivers: { kind: "job", id: job.id, ...job.tool },
      }

    const status = this.tasks.status(task)

    this.tasks.tidy(task)

    return { text: this.tasks.report(task, status), delivers: this.tasks.delivery(task, status) }
  }

  /** Results waiting in a session's inbox for a calm moment. */
  waitingResults(sessionId: string): Array<InboxFile> {
    return pendingInbox(this.store, sessionId).filter((entry) => entry.delivers !== undefined)
  }

  /** A session's commands and tasks that are still running, oldest first, each as one line of status. */
  background(sessionId: string): Array<BackgroundWork> {
    const tasks = new Map(this.tasks.list(sessionId).map((task) => [task.job.id, task]))

    return this.jobs.running(sessionId).map((job) => {
      const task = tasks.get(job.id)

      if (task === undefined)
        return {
          kind: "job",
          id: job.id,
          title: job.command,
          status: describeState(job, { state: "running" }),
        }

      const status = this.tasks.status(task)

      return {
        kind: "task",
        id: task.id,
        title: task.task.title,
        status: this.tasks.describe(status),
        waiting: status.state === "waiting for approval",
      }
    })
  }

  /** Whether a task with unread prompts got a new runner. One that cannot start reports as ended instead. */
  private woke(task: Task): boolean {
    try {
      return this.tasks.wake(task)
    } catch {
      return false
    }
  }

  /** A background job ended and no tool call was watching: its result goes to the session's inbox. */
  private jobEnded(job: Job): void {
    const id = `job-${job.id}`
    const task = this.tasks.of(job)

    // A prompt reached the task as its runner was leaving: it is not finished, it needs a new runner.
    if (task !== undefined && this.jobs.state(job).state === "exited" && this.woke(task)) {
      this.jobs.claim(job)

      return
    }

    // The entry is written before the claim: a crash between the two repeats neither.
    if (!this.store.listInbox(job.session_id).some((entry) => entry.id === id)) {
      const result = this.resultOf(job)

      this.store.writeInbox(
        job.session_id,
        { user_id: SYSTEM_USER, text: this.redactor.scrub(result.text), delivers: result.delivers },
        id,
      )
    }

    this.jobs.claim(job)

    if (this.attended.has(job.session_id)) this.drainInbox(job.session_id)
  }

  /**
   * Resolves when a session has nothing left to do: no turn or evaluator
   * running, no background job, and no result waiting to be delivered.
   */
  async settled(sessionId: string): Promise<void> {
    // A job does not keep the process that started it alive; waiting for one has to.
    const awake = setInterval(() => undefined, 1000)

    try {
      for (;;) {
        const queue = this.queues.get(sessionId)

        await queue

        const running = this.jobs.running(sessionId)

        if (running.length > 0) {
          await Promise.race(running.map((job) => this.jobs.ended(job)))
          continue
        }

        // A result may have been recorded by another process that was watching the same job.
        this.drainInbox(sessionId)

        if (this.queues.get(sessionId) === queue) return
      }
    } finally {
      clearInterval(awake)
    }
  }

  private async pickupHandoff(sessionId: string): Promise<TurnOutcome | undefined> {
    if (loadSession(this.store, sessionId).turns.length > 0) return undefined

    if (handoffSeedFor(this.store, sessionId) === undefined) recoverHandoff(this.store, sessionId)

    const seed = handoffSeedFor(this.store, sessionId)

    if (seed === undefined) return undefined

    const outcome = await this.execute(sessionId, {
      text: stringAttr(seed, OI.INPUT_VALUE) ?? "",
      userId: stringAttr(seed, OI.USER_ID) ?? this.settings.user,
      previous: null,
      handoffSeed: seed.context,
    })

    await this.afterTurn(sessionId, outcome)

    return outcome
  }

  /** Resolves when a session has no turn or evaluator still running. */
  async idle(sessionId: string): Promise<void> {
    for (;;) {
      const queue = this.queues.get(sessionId)

      await queue

      if (queue === this.queues.get(sessionId)) return
    }
  }

  private resolvePrevious(sessionId: string, prompt: Prompt): { trace_id: string; span_id: string } | null {
    if (prompt.previous === null) return null

    const view = loadSession(this.store, sessionId)

    const turn =
      prompt.previous === undefined
        ? view.head
        : view.turns.find((entry) => entry.trace_id === prompt.previous)

    return turn === undefined ? null : { trace_id: turn.trace_id, span_id: turn.root.context.span_id }
  }

  private async execute(
    sessionId: string,
    prompt: Prompt,
    correction?: EngineMetadata["correction"],
    feedback?: ReadonlyArray<AnnotationFile>,
  ): Promise<TurnOutcome> {
    const header = this.store.readHeader(sessionId)

    if (header === undefined)
      return { ok: false, interrupted: false, message: `No such session: ${sessionId}` }

    const env: TurnEnv = {
      store: this.store,
      sessionId,
      cwd: header.cwd,
      tools: this.tools,
      jobs: this.jobs,
      tasks: this.tasks,
      models: () => ({
        default: `${this.settings.provider}/${this.settings.model}`,
        cheap: this.settings.cheap_model,
      }),
      task: header.task,
      redactor: this.redactor,
      selfDir: this.selfDir,
    }

    const turn = runTurn(env, {
      text: prompt.text,
      userId: prompt.userId,
      previous: this.resolvePrevious(sessionId, prompt),
      correction,
      injected: feedback ?? (prompt.operation !== undefined ? [] : this.hooks.pendingFeedback(sessionId)),
      inboxId: prompt.inboxId,
      attachments: prompt.attachments,
      delivers: prompt.delivers,
      origin: prompt.origin,
      operation: prompt.operation,
      handoffSeed: prompt.handoffSeed,
    }).pipe(Effect.provide(Layer.mergeAll(this.model, this.approver(sessionId))))

    const fiber = Effect.runFork(turn)

    this.running.set(sessionId, { fiber, operation: prompt.operation !== undefined })

    const exit = await Effect.runPromise(Fiber.await(fiber))

    this.running.delete(sessionId)

    // What was queued behind this turn, and anything meant for it that it did not get to read.
    if (this.attended.has(sessionId)) this.drainInbox(sessionId)

    if (Exit.isSuccess(exit)) return { ok: true, result: exit.value }

    const interrupted = Exit.hasInterrupts(exit)

    const message = Option.match(Exit.findErrorOption(exit), {
      onNone: () => "the turn failed",
      onSome: (error) => error.message,
    })

    return { ok: false, interrupted, message: interrupted ? "interrupted" : message }
  }
}

export { ModelError }
