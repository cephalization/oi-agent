import { Cause, type Context, Exit, Option, Schema, Tracer } from "effect"
import {
  AttrValue,
  type Attributes,
  type EndedSpan,
  type EngineMetadata,
  OI,
  type SpanEvent,
  type SpanFile,
  type StatusCode,
  type StreamDelta,
  writeMetadata,
} from "./format.ts"
import { newSpanId, newTraceId, nsToIso } from "./ids.ts"
import type { Store } from "./store.ts"

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0]

const decodeAttr = Schema.decodeUnknownOption(AttrValue)

/** Values that already are attributes pass through; everything else is JSON. */
const coerce = (value: {} | null | undefined): AttrValue | undefined => {
  if (value === undefined || value === null) return undefined

  return Option.getOrElse(decodeAttr(value), () =>
    JSON.stringify(value, (_key, inner: {} | null) =>
      Schema.is(Schema.BigInt)(inner) ? Number(inner) : inner,
    ),
  )
}

const errorMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)

  return error instanceof Error ? error.message : String(error)
}

interface Outcome {
  readonly code: StatusCode
  readonly message: string
}

interface Ended {
  readonly endTime: bigint
  readonly exit: Exit.Exit<unknown, unknown>
}

/**
 * An Effect tracer whose spans are the session's state.
 *
 * `Effect.withSpan` is the only way the agent loop records anything: starting
 * a span writes its in-flight file, ending it writes the immutable span file.
 * There is no second persistence path to drift from the telemetry.
 */
export class DiskSpan implements Tracer.Span {
  readonly _tag = "Span"
  readonly name: string
  readonly spanId: string
  readonly traceId: string
  readonly parent: Option.Option<Tracer.AnySpan>
  readonly annotations: Context.Context<never>
  readonly links: Array<Tracer.SpanLink>
  readonly sampled: boolean
  readonly kind: Tracer.SpanKind
  readonly attributes = new Map<string, unknown>()
  private readonly store: Store
  private readonly sessionId: string
  private readonly attrs: Record<string, AttrValue> = {}
  private readonly events: Array<SpanEvent> = []
  private readonly startNs: bigint
  private ended: Ended | undefined
  private opened = false
  private dirty = true
  private flushQueued = true

  constructor(store: Store, sessionId: string, options: SpanOptions) {
    this.store = store
    this.sessionId = sessionId
    this.name = options.name
    this.parent = options.parent
    this.annotations = options.annotations
    this.links = options.links
    this.sampled = options.sampled
    this.kind = options.kind
    this.startNs = options.startTime
    this.spanId = newSpanId()
    this.traceId = Option.match(options.parent, {
      onNone: () => newTraceId(Number(options.startTime / 1_000_000n)),
      onSome: (parent) => parent.traceId,
    })
    this.attrs[OI.SESSION_ID] = sessionId
    queueMicrotask(() => this.flush())
  }

  // The shape of `status` is dictated by Effect's `Tracer.Span` interface.
  /* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
  get status(): Tracer.SpanStatus {
    return this.ended === undefined
      ? { _tag: "Started", startTime: this.startNs }
      : { _tag: "Ended", startTime: this.startNs, endTime: this.ended.endTime, exit: this.ended.exit }
  }
  /* oxlint-enable anti-slop-effect/no-manual-tagged-construction */

  private queueFlush(): void {
    this.dirty = true

    if (this.flushQueued) return

    this.flushQueued = true
    queueMicrotask(() => this.flush())
  }

  /** Write the in-flight file now. Runs automatically after each change. */
  flush(): void {
    this.flushQueued = false

    if (!this.dirty || this.ended !== undefined) return

    this.dirty = false
    this.store.openSpan(this.sessionId, this.toFile(), !this.opened)
    this.opened = true
  }

  private outcome(): Outcome {
    if (this.ended === undefined) return { code: "UNSET", message: "" }

    return Exit.match(this.ended.exit, {
      onSuccess: () => ({ code: "OK", message: "" }),
      onFailure: (cause) => ({
        code: "ERROR",
        message: Cause.hasInterruptsOnly(cause) ? "interrupted" : errorMessage(cause),
      }),
    })
  }

  private fields(): Omit<SpanFile, "end_time"> {
    const { code, message } = this.outcome()

    return {
      name: this.name,
      context: { trace_id: this.traceId, span_id: this.spanId },
      span_kind: "SPAN_KIND_INTERNAL",
      parent_id: Option.match(this.parent, { onNone: () => null, onSome: (parent) => parent.spanId }),
      start_time: nsToIso(this.startNs),
      status_code: code,
      status_message: message,
      attributes: { ...this.attrs },
      events: [...this.events],
    }
  }

  toFile(): SpanFile {
    return { ...this.fields(), end_time: null }
  }

  // The parameter type is dictated by Effect's `Tracer.Span` interface.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  attribute(key: string, value: unknown): void {
    if (this.ended !== undefined) return

    const attr = coerce(value)

    if (attr === undefined) {
      delete this.attrs[key]
      this.attributes.delete(key)
    } else {
      this.attrs[key] = attr
      this.attributes.set(key, value)
    }

    this.queueFlush()
  }

  // The parameter type is dictated by Effect's `Tracer.Span` interface.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    if (this.ended !== undefined) return

    const attrs: Record<string, AttrValue> = {}

    for (const [key, value] of Object.entries(attributes ?? {})) {
      const attr = coerce(value)

      if (attr !== undefined) attrs[key] = attr
    }

    this.events.push({ name, timestamp: nsToIso(startTime), attributes: attrs })
    this.queueFlush()
  }

  /** Merge engine metadata into the span's `metadata` attribute. */
  patchMetadata(patch: EngineMetadata): void {
    this.attribute(OI.METADATA, writeMetadata(this.attrs[OI.METADATA], patch))
  }

  /** Set several attributes at once. */
  assign(attributes: ReadonlyMap<string, AttrValue>): void {
    for (const [key, value] of attributes) this.attribute(key, value)
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    if (this.ended !== undefined) return

    for (const link of links) this.links.push(link)
  }

  /** Append a streaming delta for live viewers. Not part of the final span. */
  delta(delta: StreamDelta): void {
    if (this.ended !== undefined) return

    if (!this.opened) this.flush()

    this.store.appendDelta(this.sessionId, this.toFile(), delta)
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.ended !== undefined) return

    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      this.events.push({
        name: "exception",
        timestamp: nsToIso(endTime),
        attributes: {
          "exception.message": errorMessage(exit.cause),
          "exception.stacktrace": Cause.pretty(exit.cause),
        },
      })
    }

    this.ended = { endTime: endTime > this.startNs ? endTime : this.startNs, exit }

    const span: EndedSpan = { ...this.fields(), end_time: nsToIso(this.ended.endTime) }

    this.store.endSpan(this.sessionId, span)
  }
}

export type { Attributes }

export const diskTracer = (store: Store, sessionId: string): Tracer.Tracer =>
  Tracer.make({ span: (options) => new DiskSpan(store, sessionId, options) })
