/**
 * The engine: the host side of a set of sessions.
 *
 * It owns the store, runs turns one at a time per session, and brokers tool
 * approvals. Every interface (terminal, share peer, viewer) talks to this and
 * to the store's event stream; none of them holds session state of its own.
 */
import { Effect, Exit, Fiber, Layer, Option } from "effect"
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
  type EngineMetadata,
  type InboxFile,
  OI,
  type SessionHeader,
  stringAttr,
} from "./format.ts"
import { type Job, jobReport, type Jobs, jobsOf } from "./jobs.ts"
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
  readonly operation?: "compact" | "handoff" | undefined
  readonly handoffSeed?: EngineMetadata["handoff_seed"] | undefined
  readonly inboxId?: string | undefined
  readonly delivers?: EngineMetadata["delivers"]
}

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
    "Carry on with the work these results were for. If nothing is left to do, tell the user the outcome in a sentence or two.",
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
}

/** Hooks that run around a turn: evals and feedback plug in here. */
export interface TurnHooks {
  /** Feedback to inject into the next turn of a session. */
  readonly pendingFeedback: (sessionId: string) => ReadonlyArray<AnnotationFile>
  readonly afterTurn: (sessionId: string, traceId: string) => Promise<void>
}

const NO_HOOKS: TurnHooks = { pendingFeedback: () => [], afterTurn: () => Promise.resolve() }

interface Running {
  readonly fiber: Fiber.Fiber<TurnResult, ModelError>
}

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
  hooks: TurnHooks = NO_HOOKS
  private settings: Config
  private model: Layer.Layer<Model>
  private readonly modelFor: ((config: Config) => Layer.Layer<Model>) | undefined
  private approvalMode: ApprovalMode
  private readonly queues = new Map<string, Promise<void>>()
  private readonly running = new Map<string, Running>()
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>()
  private readonly approvalListeners = new Set<(request: ApprovalRequest) => void>()
  /** Sessions someone is here for: their inbox runs as it fills. */
  private readonly attended = new Set<string>()
  /** Inbox prompts already in a session's queue. */
  private readonly queuedPrompts = new Set<string>()
  /** Sessions with a delivery turn already in the queue. */
  private readonly queuedDeliveries = new Set<string>()

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
    this.jobs = jobsOf(this.store)
    this.jobs.onEnd((job) => this.jobEnded(job))
  }

  /** Stop watching background jobs. The jobs keep running, and report when a session is next opened. */
  close(): void {
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

  /** Be told when a tool call is waiting for a decision. */
  onApproval(listener: (request: ApprovalRequest) => void): () => void {
    this.approvalListeners.add(listener)

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

  /** Wait for a human to answer. */
  private askHuman(request: ApprovalRequest): Effect.Effect<ApprovalDecision> {
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
      Effect.map(this.askHuman({ ...request, reason: asked_because }), (decision): Approval => ({
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

        return Effect.map(this.askHuman(request), (decision): Approval => ({ decision }))
      },
    })
  }

  // --- turns --------------------------------------------------------------

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId)
  }

  /** Stop the turn a session is running. The spans it wrote stay on disk. */
  interrupt(sessionId: string): void {
    const running = this.running.get(sessionId)

    if (running !== undefined) Effect.runFork(Fiber.interrupt(running.fiber))
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
  private afterTurn(sessionId: string, outcome: TurnOutcome | undefined): Promise<void> {
    return outcome?.ok === true
      ? this.hooks.afterTurn(sessionId, outcome.result.traceId).catch(() => undefined)
      : Promise.resolve()
  }

  /**
   * Run a prompt as a turn. Turns in one session run one after another, in
   * the order they were submitted.
   */
  submit(sessionId: string, prompt: Prompt): Promise<TurnOutcome> {
    return this.enqueue(
      sessionId,
      async () => {
        // Seed pickup belongs to the engine queue, not to a UI's startup order.
        const handoff = await this.pickupHandoff(sessionId)

        if (handoff !== undefined && !handoff.ok) return handoff

        return this.execute(sessionId, prompt)
      },
      (outcome) => (prompt.operation === undefined ? this.afterTurn(sessionId, outcome) : Promise.resolve()),
    )
  }

  /** Consume a durable destination seed once, serialized with all other turns.
   * An interrupted first turn is not retried automatically: tools may have run.
   */
  resumeHandoff(sessionId: string): Promise<TurnOutcome | undefined> {
    return this.enqueue(
      sessionId,
      () => {
        for (const turn of loadSession(this.store, sessionId).turns)
          completeHandoff(this.store, sessionId, turn.root)

        return this.pickupHandoff(sessionId)
      },
      () => Promise.resolve(),
    )
  }

  // --- inbox and background work ------------------------------------------

  /**
   * Start serving a session: follow the background jobs it left running, and
   * run what is waiting in its inbox. Results of work that ends while nobody
   * attends a session wait in its inbox until someone does.
   */
  attend(sessionId: string): void {
    this.attended.add(sessionId)
    this.jobs.adopt(sessionId)
    this.drainInbox(sessionId)
  }

  leave(sessionId: string): void {
    this.attended.delete(sessionId)
  }

  /**
   * Queue what is waiting in a session's inbox: each prompt from a peer as a
   * turn of its own, and every result of background work together in one.
   * Safe to call at any time, and again after a crash.
   */
  drainInbox(sessionId: string): void {
    for (const entry of pendingInbox(this.store, sessionId)) {
      if (entry.delivers !== undefined) {
        this.queueDelivery(sessionId)
        continue
      }

      if (this.queuedPrompts.has(entry.id)) continue

      this.queuedPrompts.add(entry.id)
      void this.submit(sessionId, { text: entry.text, userId: entry.user_id, inboxId: entry.id })
    }
  }

  /**
   * One turn for all the results waiting when its place in the queue comes,
   * so work that finished during a long turn arrives as a single message.
   */
  private queueDelivery(sessionId: string): void {
    if (this.queuedDeliveries.has(sessionId)) return

    this.queuedDeliveries.add(sessionId)

    void this.enqueue(
      sessionId,
      async () => {
        this.queuedDeliveries.delete(sessionId)

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

  /** A background job ended and no tool call was watching: its result goes to the session's inbox. */
  private jobEnded(job: Job): void {
    const id = `job-${job.id}`

    // The entry is written before the claim: a crash between the two repeats neither.
    if (!this.store.listInbox(job.session_id).some((entry) => entry.id === id)) {
      this.store.writeInbox(
        job.session_id,
        {
          user_id: SYSTEM_USER,
          text: this.redactor.scrub(jobReport(this.jobs, job, this.jobs.state(job))),
          delivers: { kind: "job", id: job.id, ...job.tool },
        },
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

    if (outcome.ok) await this.hooks.afterTurn(sessionId, outcome.result.traceId).catch(() => undefined)

    return outcome
  }

  /** Resolves when a session has no turn or evaluator still running. */
  idle(sessionId: string): Promise<void> {
    return this.queues.get(sessionId) ?? Promise.resolve()
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

  private async execute(sessionId: string, prompt: Prompt): Promise<TurnOutcome> {
    const header = this.store.readHeader(sessionId)

    if (header === undefined)
      return { ok: false, interrupted: false, message: `No such session: ${sessionId}` }

    const env: TurnEnv = {
      store: this.store,
      sessionId,
      cwd: header.cwd,
      tools: this.tools,
      jobs: this.jobs,
      redactor: this.redactor,
      selfDir: this.selfDir,
    }

    const turn = runTurn(env, {
      text: prompt.text,
      userId: prompt.userId,
      previous: this.resolvePrevious(sessionId, prompt),
      injected: prompt.operation !== undefined ? [] : this.hooks.pendingFeedback(sessionId),
      inboxId: prompt.inboxId,
      delivers: prompt.delivers,
      operation: prompt.operation,
      handoffSeed: prompt.handoffSeed,
    }).pipe(Effect.provide(Layer.mergeAll(this.model, this.approver(sessionId))))

    const fiber = Effect.runFork(turn)

    this.running.set(sessionId, { fiber })

    const exit = await Effect.runPromise(Fiber.await(fiber))

    this.running.delete(sessionId)

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
