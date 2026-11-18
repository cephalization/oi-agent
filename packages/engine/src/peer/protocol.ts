/**
 * The peer protocol: how any interface outside the host process sees a
 * session. It is plain HTTP so it works over loopback, a LAN, or a tailcat
 * tunnel without change.
 *
 *   GET  /v1/session                 header, role
 *   GET  /v1/manifest                immutable file paths + in-flight spans
 *   GET  /v1/file?path=<rel>         one immutable file
 *   GET  /v1/events                  server-sent stream of store events
 *   POST /v1/prompt                  submit a prompt, with any images (drivers only)
 *
 * Syncing is: fetch the manifest, copy the files you lack, then follow the
 * event stream. Ended spans never change, so there is nothing to merge.
 */
import { Schema } from "effect"
import {
  AnnotationFile,
  AttachmentFile,
  EndedSpan,
  InboxFile,
  SessionHeader,
  SpanFile,
  StreamDelta,
} from "../format.ts"

export const Role = Schema.Literals(["viewer", "driver"])

export type Role = typeof Role.Type

/** What a host can do beyond the first version of this protocol. A joiner checks before relying on one. */
export const FEATURES = ["images"] as const

export const SessionInfo = Schema.Struct({
  header: SessionHeader,
  role: Role,
  host: Schema.String,
  /** Absent from hosts that predate it, which is how a joiner knows not to send them images. */
  features: Schema.optionalKey(Schema.Array(Schema.String)),
})

export type SessionInfo = typeof SessionInfo.Type

/** Ephemeral, read-only host status; derived afresh, never persisted as conversation state. */
export const SessionState = Schema.Struct({
  busy: Schema.Boolean,
  steerable: Schema.Boolean,
  waiting: Schema.Array(InboxFile),
  held: Schema.Number,
  work: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["job", "task"]),
      id: Schema.String,
      title: Schema.String,
      status: Schema.String,
      waiting: Schema.optionalKey(Schema.Boolean),
    }),
  ),
})

export type SessionState = typeof SessionState.Type

export const Manifest = Schema.Struct({
  // Older hosts replicate conversation files but do not publish live status.
  state: Schema.optionalKey(SessionState),
  paths: Schema.Array(Schema.String),
  open: Schema.Array(Schema.Struct({ span: SpanFile, deltas: Schema.Array(StreamDelta) })),
})

export type Manifest = typeof Manifest.Type

/** An image sent with a prompt: its bytes travel with it, since the host cannot read the joiner's disk. */
export const PromptImage = Schema.Struct({
  name: Schema.String,
  /** Base64. The host reads the format from the bytes and checks size and count itself. */
  data: Schema.String,
})

export type PromptImage = typeof PromptImage.Type

export const PromptRequest = Schema.Struct({
  text: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["steer", "queue"])),
  images: Schema.optionalKey(Schema.Array(PromptImage)),
})

/** A store event as sent to peers. */
export const WireEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), session_id: Schema.String, state: SessionState }),
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
  Schema.Struct({
    type: Schema.Literal("attachment"),
    session_id: Schema.String,
    attachment: AttachmentFile,
  }),
])

export type WireEvent = typeof WireEvent.Type
