/**
 * The peer protocol: how any interface outside the host process sees a
 * session. It is plain HTTP so it works over loopback, a LAN, or a tailcat
 * tunnel without change.
 *
 *   GET  /v1/session                 header, role
 *   GET  /v1/manifest                immutable file paths + in-flight spans
 *   GET  /v1/file?path=<rel>         one immutable file
 *   GET  /v1/events                  server-sent stream of store events
 *   POST /v1/prompt                  submit a prompt (drivers only)
 *
 * Syncing is: fetch the manifest, copy the files you lack, then follow the
 * event stream. Ended spans never change, so there is nothing to merge.
 */
import { Schema } from "effect"
import { AnnotationFile, EndedSpan, InboxFile, SessionHeader, SpanFile, StreamDelta } from "../format.ts"

export const Role = Schema.Literals(["viewer", "driver"])

export type Role = typeof Role.Type

export const SessionInfo = Schema.Struct({ header: SessionHeader, role: Role, host: Schema.String })

export type SessionInfo = typeof SessionInfo.Type

export const Manifest = Schema.Struct({
  paths: Schema.Array(Schema.String),
  open: Schema.Array(Schema.Struct({ span: SpanFile, deltas: Schema.Array(StreamDelta) })),
})

export type Manifest = typeof Manifest.Type

export const PromptRequest = Schema.Struct({ text: Schema.String })

/** A store event as sent to peers. */
export const WireEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), session_id: Schema.String, header: SessionHeader }),
  Schema.Struct({ type: Schema.Literal("span_open"), session_id: Schema.String, span: SpanFile }),
  Schema.Struct({ type: Schema.Literal("span_end"), session_id: Schema.String, span: EndedSpan }),
  Schema.Struct({
    type: Schema.Literal("delta"),
    session_id: Schema.String,
    trace_id: Schema.String,
    span_id: Schema.String,
    delta: StreamDelta,
  }),
  Schema.Struct({
    type: Schema.Literal("annotation"),
    session_id: Schema.String,
    annotation: AnnotationFile,
  }),
  Schema.Struct({ type: Schema.Literal("inbox"), session_id: Schema.String, entry: InboxFile }),
])

export type WireEvent = typeof WireEvent.Type
