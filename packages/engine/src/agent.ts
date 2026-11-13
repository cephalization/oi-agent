/**
 * The agent loop.
 *
 * A turn is one trace: a root `AGENT` span with an `LLM` span per model call
 * and a `TOOL` span per tool call. The loop holds no conversation state. Each
 * step asks the fold what to send next, so what the model sees is always
 * exactly what is on disk.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { contextFor } from "./fold.ts"
import { type AnnotationFile, type EngineMetadata, OI, writeMetadata } from "./format.ts"
import { Model, type ModelError } from "./model.ts"
import { systemPrompt } from "./prompt.ts"
import type { Redactor } from "./redact.ts"
import { rulesVersion } from "./rules.ts"
import type { Store } from "./store.ts"
import type { ToolSpec } from "./tools.ts"
import { DiskSpan, diskTracer } from "./tracer.ts"
import type { Reply, ToolCall } from "./dialect.ts"
import type { Json } from "./wire.ts"
import { workspaceOf } from "./workspace.ts"

export const AGENT_NAME = "oi-agent"

const MAX_STEPS = 200

/** Span files should not carry JavaScript stack traces. */
const UNTRACED = { captureStackTrace: false }

// --- approvals -------------------------------------------------------------

export interface ApprovalRequest {
  readonly tool: string
  readonly input: Json
  readonly trace_id: string
  readonly span_id: string
  /** Who started the turn that wants to run this tool. */
  readonly user_id: string
}

export type ApprovalDecision = "allow" | "deny"

/** Decides whether a tool that can change the machine may run. Host-side only. */
export class Approver extends Context.Service<
  Approver,
  { readonly decide: (request: ApprovalRequest) => Effect.Effect<ApprovalDecision> }
>()("oi-agent/Approver") {}

export const approveAll: Layer.Layer<Approver> = Layer.succeed(Approver, {
  decide: () => Effect.succeed("allow"),
})

export const denyAll: Layer.Layer<Approver> = Layer.succeed(Approver, {
  decide: () => Effect.succeed("deny"),
})

// --- turn ------------------------------------------------------------------

export interface TurnEnv {
  readonly store: Store
  readonly sessionId: string
  readonly cwd: string
  readonly tools: ReadonlyArray<ToolSpec>
  readonly redactor: Redactor
  /** The agent's shipped source and docs, if available, so it can explain itself. */
  readonly selfDir?: string | undefined
}

export interface TurnInput {
  readonly text: string
  readonly userId: string
  /** The turn to continue from; `null` starts the conversation. */
  readonly previous: { readonly trace_id: string; readonly span_id: string } | null
  readonly inboxId?: string | undefined
  /** Eval feedback to put in front of the user's text. */
  readonly injected?: ReadonlyArray<AnnotationFile>
}

export interface TurnResult {
  readonly traceId: string
  readonly output: string
  readonly stopReason: string
  readonly steps: number
}

class ToolFailed extends Schema.TaggedError<ToolFailed>()("ToolFailed", { message: Schema.String }) {}

const currentDiskSpan: Effect.Effect<DiskSpan> = Effect.gen(function* () {
  const span = yield* Effect.orDie(Effect.currentSpan)

  return span instanceof DiskSpan ? span : yield* Effect.die("the agent loop must run under the disk tracer")
})

const EMPTY_REPLY: Reply = { text: "", calls: [], wantsTools: false, paused: false, stopReason: "error" }

const modelStep = (env: TurnEnv, traceId: string) =>
  Effect.gen(function* () {
    const span = yield* currentDiskSpan
    const model = yield* Model

    const raw = yield* model.run(
      {
        system: systemPrompt(
          env.cwd,
          env.selfDir === undefined
            ? undefined
            : { selfDir: env.selfDir, sessionDir: env.store.sessionDir(env.sessionId) },
        ),
        tools: env.tools,
        messages: contextFor(env.store, env.sessionId, traceId, model.dialect),
      },
      {
        onRequest: (body) => {
          span.assign(model.dialect.requestAttributes(body, model.provider))
          span.patchMetadata({ api: model.dialect.api, provider: model.provider })
          span.flush()
        },
        onDelta: (delta) => span.delta(delta),
      },
    )

    span.assign(model.dialect.responseAttributes(raw))

    return model.dialect.reply(raw) ?? EMPTY_REPLY
  }).pipe(Effect.withSpan("llm", { attributes: { [OI.SPAN_KIND]: "LLM" } }, UNTRACED))

const toolStep = (env: TurnEnv, use: ToolCall, userId: string) => {
  const tool = env.tools.find((candidate) => candidate.name === use.name)

  return Effect.gen(function* () {
    const span = yield* currentDiskSpan

    span.flush()

    if (tool === undefined) return yield* new ToolFailed({ message: `Unknown tool: ${use.name}` })

    if (tool.mutates) {
      const approver = yield* Approver

      // On disk at once, so anyone reading the session (a viewer, a test) can
      // tell a call waiting for a decision from one that is running.
      span.patchMetadata({ awaiting_approval: true })
      span.flush()

      const decision = yield* approver.decide({
        tool: tool.name,
        input: use.input,
        trace_id: span.traceId,
        span_id: span.spanId,
        user_id: userId,
      })

      span.patchMetadata({ awaiting_approval: false, approval: { decision, by: env.store.device().name } })

      if (decision === "deny")
        return yield* new ToolFailed({ message: "The user declined to run this tool call." })
    }

    const outcome = yield* tool.run(use.input, {
      cwd: env.cwd,
      emit: (chunk) => span.delta({ k: "stdout", i: 0, d: env.redactor.scrub(chunk) }),
    })

    const output = env.redactor.scrub(outcome.output)

    span.attribute(OI.OUTPUT_VALUE, output)

    if (outcome.isError) return yield* new ToolFailed({ message: output })
  }).pipe(
    // A failed tool is reported to the model, not to the turn: the span is
    // marked as an error and the loop carries on.
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const span = yield* currentDiskSpan

        span.attribute(OI.OUTPUT_VALUE, error.message)
        span.patchMetadata({ is_error: true })
      }),
    ),
    Effect.withSpan(
      use.name,
      {
        attributes: {
          [OI.SPAN_KIND]: "TOOL",
          [OI.TOOL_NAME]: use.name,
          [OI.TOOL_ID]: use.id,
          [OI.TOOL_DESCRIPTION]: tool?.description ?? "",
          [OI.TOOL_PARAMETERS]: JSON.stringify(tool?.parameters ?? {}),
          [OI.INPUT_VALUE]: JSON.stringify(use.input),
          [OI.INPUT_MIME]: "application/json",
        },
      },
      UNTRACED,
    ),
    Effect.catchTag("ToolFailed", () => Effect.void),
  )
}

const loop = (env: TurnEnv, input: TurnInput): Effect.Effect<TurnResult, ModelError, Model | Approver> =>
  Effect.gen(function* () {
    const root = yield* currentDiskSpan
    const traceId = root.traceId
    let steps = 0
    let response = EMPTY_REPLY

    // The fold reads this turn's input from the root span's in-flight file.
    root.flush()

    while (steps < MAX_STEPS) {
      steps += 1
      response = yield* modelStep(env, traceId)

      if (response.wantsTools) {
        yield* Effect.forEach(response.calls, (use) => toolStep(env, use, input.userId), {
          concurrency: "unbounded",
          discard: true,
        })
        continue
      }

      // A paused server-side tool resumes when the conversation is sent back as is.
      if (!response.paused) break
    }

    const output = response.text

    root.attribute(OI.OUTPUT_VALUE, output)
    root.attribute(OI.OUTPUT_MIME, "text/plain")
    // Everything but this root span is on disk by now, so this is the turn's footprint.
    root.patchMetadata({ session_bytes: env.store.sessionBytes(env.sessionId) })

    return {
      traceId,
      output,
      stopReason: response.stopReason === "" ? "unknown" : response.stopReason,
      steps,
    }
  })

/** Run one turn to completion. Everything it does is recorded as spans. */
export const runTurn = (
  env: TurnEnv,
  input: TurnInput,
): Effect.Effect<TurnResult, ModelError, Model | Approver> => {
  const metadata: EngineMetadata = {
    previous: input.previous,
    device: env.store.device().id,
    pid: process.pid,
    prompt_version: rulesVersion(env.cwd),
    session_bytes: env.store.sessionBytes(env.sessionId),
    workspace: workspaceOf(env.cwd),
  }

  const injected = (input.injected ?? []).map((entry) => ({
    annotation_id: entry.id,
    name: entry.annotation.name,
  }))

  if (input.inboxId !== undefined) metadata.inbox_id = input.inboxId

  if (injected.length > 0) metadata.injected = injected

  return loop(env, input).pipe(
    Effect.withSpan(
      "turn",
      {
        root: true,
        attributes: {
          [OI.SPAN_KIND]: "AGENT",
          [OI.AGENT_NAME]: AGENT_NAME,
          [OI.USER_ID]: input.userId,
          [OI.INPUT_VALUE]: input.text,
          [OI.INPUT_MIME]: "text/plain",
          [OI.METADATA]: writeMetadata(undefined, metadata),
        },
      },
      UNTRACED,
    ),
    Effect.withTracer(diskTracer(env.store, env.sessionId)),
  )
}
