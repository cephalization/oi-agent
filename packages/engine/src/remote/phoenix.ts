/**
 * Reading sessions back from a Phoenix server.
 *
 * Phoenix keeps everything the fold needs: the raw request and response
 * bodies come back byte for byte. Three things change on the way through,
 * and this module undoes or tolerates each:
 *
 * - JSON-string attributes (`metadata`, `tool.parameters`, ...) are parsed
 *   on ingest and returned flattened into dotted keys. They are re-nested and
 *   serialized again here.
 * - Times come back as nanoseconds computed from a float of microsecond
 *   precision. They are rounded to the microsecond, so an imported span file
 *   is named differently from the original; the store matches spans by id.
 * - Annotation ids are Phoenix's own. The exporter sends the local id in the
 *   annotation's metadata, and an import restores it when present.
 */
import { Option, Schema } from "effect"
import {
  AnnotationBody,
  type AnnotationFile,
  type Attributes,
  type AttrPrimitive,
  type AttrValue,
  type EndedSpan,
  METADATA_KEY,
  parser,
  type SpanEvent,
  StatusCode,
} from "../format.ts"
import { nsToIso } from "../ids.ts"
import type { PhoenixTarget } from "../export/phoenix.ts"
import type { Json } from "../wire.ts"

// --- response shapes -------------------------------------------------------

const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

const Scalar = Schema.Struct({
  string_value: Nullable(Schema.String),
  bool_value: Nullable(Schema.Boolean),
  int_value: Nullable(Schema.Union([Schema.Finite, Schema.String])),
  double_value: Nullable(Schema.Finite),
})

const AnyValue = Schema.Struct({
  ...Scalar.fields,
  array_value: Nullable(Schema.Struct({ values: Schema.Array(Scalar) })),
})

const KeyValue = Schema.Struct({ key: Schema.String, value: AnyValue })

const OtlpEvent = Schema.Struct({
  name: Nullable(Schema.String),
  time_unix_nano: Nullable(Schema.String),
  attributes: Nullable(Schema.Array(KeyValue)),
})

const OtlpSpan = Schema.Struct({
  trace_id: Schema.String,
  span_id: Schema.String,
  parent_span_id: Nullable(Schema.String),
  name: Schema.String,
  start_time_unix_nano: Schema.String,
  end_time_unix_nano: Nullable(Schema.String),
  attributes: Nullable(Schema.Array(KeyValue)),
  events: Nullable(Schema.Array(OtlpEvent)),
  status: Nullable(Schema.Struct({ code: Nullable(Schema.Finite), message: Nullable(Schema.String) })),
})

type OtlpSpan = typeof OtlpSpan.Type

const SpansPage = Schema.Struct({ data: Schema.Array(OtlpSpan), next_cursor: Nullable(Schema.String) })

const SessionTrace = Schema.Struct({ trace_id: Schema.String, start_time: Schema.String })

const SessionInfo = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  start_time: Schema.String,
  end_time: Schema.String,
  traces: Schema.Array(SessionTrace),
})

export type RemoteSessionInfo = typeof SessionInfo.Type

const SessionPage = Schema.Struct({ data: SessionInfo })
const SessionsPage = Schema.Struct({ data: Schema.Array(SessionInfo), next_cursor: Nullable(Schema.String) })

const RemoteAnnotation = Schema.Struct({
  id: Schema.String,
  trace_id: Schema.String,
  name: Schema.String,
  annotator_kind: AnnotationBody.fields.annotator_kind,
  identifier: Nullable(Schema.String),
  metadata: Nullable(Schema.Record(Schema.String, Schema.Json)),
  created_at: Schema.String,
  result: Nullable(
    Schema.Struct({
      label: Nullable(Schema.String),
      score: Nullable(Schema.Finite),
      explanation: Nullable(Schema.String),
    }),
  ),
})

type RemoteAnnotation = typeof RemoteAnnotation.Type

const AnnotationsPage = Schema.Struct({
  data: Schema.Array(RemoteAnnotation),
  next_cursor: Nullable(Schema.String),
})

const LocalId = Schema.Struct({ [METADATA_KEY]: Schema.Struct({ id: Schema.String }) })
const decodeLocalId = Schema.decodeUnknownOption(LocalId)

// --- conversion ------------------------------------------------------------

/** Attributes Phoenix parses from JSON strings on ingest (`JSON_STRING_ATTRIBUTES`). */
const JSON_STRING_SUFFIXES = [
  "document.metadata",
  "llm.prompt_template.variables",
  "metadata",
  "tool.parameters",
]

/** The attribute a flattened key was split out of, when it was a JSON string. */
const jsonRoot = (key: string): string | undefined => {
  const parts = key.split(".")

  for (let end = 1; end < parts.length; end += 1) {
    const prefix = parts.slice(0, end).join(".")

    if (JSON_STRING_SUFFIXES.some((suffix) => prefix.endsWith(suffix))) return prefix
  }

  return undefined
}

const scalar = (value: typeof Scalar.Type): AttrPrimitive | undefined => {
  if (value.string_value !== undefined && value.string_value !== null) return value.string_value

  if (value.bool_value !== undefined && value.bool_value !== null) return value.bool_value

  if (value.int_value !== undefined && value.int_value !== null) return Number(value.int_value)

  return value.double_value ?? undefined
}

const attrValue = (value: typeof AnyValue.Type): AttrValue | undefined => {
  if (value.array_value !== undefined && value.array_value !== null)
    return value.array_value.values.flatMap((item) => scalar(item) ?? [])

  return scalar(value)
}

/** A tree of nested keys, built from dotted paths. */
class Node {
  readonly children = new Map<string, Node>()
  value: Json | undefined

  child(key: string): Node {
    const existing = this.children.get(key)

    if (existing !== undefined) return existing

    const created = new Node()

    this.children.set(key, created)

    return created
  }

  /** Phoenix flattens arrays of objects with numeric indexes: `0`, `1`, ... become an array again. */
  toJson(): Json {
    if (this.children.size === 0) return this.value ?? null

    const keys = [...this.children.keys()]
    const entries = [...this.children.entries()].map(([key, node]) => [key, node.toJson()] as const)

    if (keys.every((key, index) => key === String(index))) return entries.map(([, json]) => json)

    return Object.fromEntries(entries)
  }
}

const toJsonValue = (value: AttrValue): Json => (Array.isArray(value) ? [...value] : value)

/** Undo Phoenix's flattening of JSON-string attributes. */
export const restoreAttributes = (pairs: ReadonlyArray<readonly [string, AttrValue]>): Attributes => {
  const attributes = new Map<string, AttrValue>()
  const trees = new Map<string, Node>()

  for (const [key, value] of pairs) {
    const root = jsonRoot(key)

    if (root === undefined) {
      attributes.set(key, value)
      continue
    }

    const tree = trees.get(root) ?? new Node()
    let node = tree

    for (const part of key.slice(root.length + 1).split(".")) node = node.child(part)

    node.value = toJsonValue(value)
    trees.set(root, tree)
  }

  for (const [root, tree] of trees) attributes.set(root, JSON.stringify(tree.toJson()))

  return Object.fromEntries(attributes)
}

/** Phoenix's nanoseconds carry float error; it stores microseconds. */
const roundToMicros = (ns: string): bigint => ((BigInt(ns) + 500n) / 1000n) * 1000n

const pairsOf = (list: ReadonlyArray<typeof KeyValue.Type> | null | undefined) =>
  (list ?? []).flatMap((entry) => {
    const value = attrValue(entry.value)

    return value === undefined ? [] : [[entry.key, value] as const]
  })

const STATUS: ReadonlyArray<StatusCode> = ["UNSET", "OK", "ERROR"]

/** A Phoenix span as a span file, or `undefined` if it has not ended. */
export const spanFromOtlp = (span: OtlpSpan): EndedSpan | undefined => {
  if (span.end_time_unix_nano === undefined || span.end_time_unix_nano === null) return undefined

  const events: Array<SpanEvent> = (span.events ?? []).map((event) => ({
    name: event.name ?? "",
    timestamp: nsToIso(roundToMicros(event.time_unix_nano ?? span.start_time_unix_nano)),
    attributes: restoreAttributes(pairsOf(event.attributes)),
  }))

  return {
    name: span.name,
    context: { trace_id: span.trace_id, span_id: span.span_id },
    span_kind: "SPAN_KIND_INTERNAL",
    parent_id: span.parent_span_id ?? null,
    start_time: nsToIso(roundToMicros(span.start_time_unix_nano)),
    end_time: nsToIso(roundToMicros(span.end_time_unix_nano)),
    status_code: STATUS[span.status?.code ?? 0] ?? "UNSET",
    status_message: span.status?.message ?? "",
    attributes: restoreAttributes(pairsOf(span.attributes)),
    events,
  }
}

/** A Phoenix trace annotation as an annotation file, with its local id restored when it was sent. */
export const annotationFromRemote = (sessionId: string, remote: RemoteAnnotation): AnnotationFile => {
  const metadata = new Map(Object.entries(remote.metadata ?? {}))

  metadata.delete(METADATA_KEY)

  const body: MutableAnnotation = { name: remote.name, annotator_kind: remote.annotator_kind }
  const result = remote.result

  if (remote.identifier !== undefined && remote.identifier !== null) body.identifier = remote.identifier

  if (result?.label !== undefined && result.label !== null) body.label = result.label

  if (result?.score !== undefined && result.score !== null) body.score = result.score

  if (result?.explanation !== undefined && result.explanation !== null) body.explanation = result.explanation

  if (metadata.size > 0) body.metadata = Object.fromEntries(metadata)

  return {
    id: Option.match(decodeLocalId(remote.metadata ?? {}), {
      onNone: () => remote.id,
      onSome: (local) => local[METADATA_KEY].id,
    }),
    scope: "trace",
    target: { session_id: sessionId, trace_id: remote.trace_id },
    created_at: new Date(remote.created_at).toISOString(),
    annotation: body,
  }
}

type MutableAnnotation = {
  -readonly [K in keyof AnnotationFile["annotation"]]: AnnotationFile["annotation"][K]
}

// --- the client --------------------------------------------------------------

/** Trace ids per request: they go in the query string. */
const TRACE_CHUNK = 50

const chunks = <A>(items: ReadonlyArray<A>, size: number): Array<Array<A>> => {
  const out: Array<Array<A>> = []

  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))

  return out
}

/** OTLP JSON times exceed 2^53, so they are quoted before parsing to keep every digit. */
const quoteNanos = (text: string): string =>
  text.replaceAll(/"((?:start_|end_)?time_unix_nano)":\s*(\d+)/g, '"$1":"$2"')

const parseSpansPage = parser(SpansPage)
const parseSession = parser(SessionPage)
const parseSessions = parser(SessionsPage)
const parseAnnotations = parser(AnnotationsPage)

export class PhoenixError extends Error {}

export class PhoenixClient {
  private readonly base: string
  private readonly headers: Headers
  readonly project: string

  constructor(target: PhoenixTarget) {
    this.base = `${target.endpoint.replace(/\/+$/, "")}/v1`
    this.project = target.project
    this.headers = new Headers({ accept: "application/json" })

    if (target.apiKey !== undefined) this.headers.set("authorization", `Bearer ${target.apiKey}`)
  }

  private async get<A>(
    route: string,
    query: ReadonlyArray<readonly [string, string]>,
    parse: (text: string) => A | undefined,
  ): Promise<A | undefined> {
    const search = new URLSearchParams(query.map(([key, value]) => [key, value]))
    const url = `${this.base}/${route}${query.length === 0 ? "" : `?${search.toString()}`}`

    const response = await fetch(url, { headers: this.headers }).catch((error: Error) => {
      throw new PhoenixError(`Could not reach Phoenix at ${this.base}: ${error.message}`)
    })

    if (response.status === 404) return undefined

    const text = await response.text()

    if (!response.ok)
      throw new PhoenixError(`Phoenix ${route}: HTTP ${response.status} ${text.slice(0, 200)}`)

    const value = parse(quoteNanos(text))

    if (value === undefined) throw new PhoenixError(`Phoenix ${route}: unexpected response`)

    return value
  }

  /** A session by its `session.id`, or by the id in a Phoenix URL. */
  async session(identifier: string): Promise<RemoteSessionInfo | undefined> {
    return (await this.get(`sessions/${encodeURIComponent(identifier)}`, [], parseSession))?.data
  }

  /** The most recently started sessions in the project. */
  async sessions(limit: number): Promise<Array<RemoteSessionInfo>> {
    const query = [
      ["limit", String(limit)],
      ["order", "desc"],
    ] as const

    const page = await this.get(`projects/${encodeURIComponent(this.project)}/sessions`, query, parseSessions)

    return [...(page?.data ?? [])]
  }

  /** Every ended span of these traces, or only their root spans. */
  async spans(
    traceIds: ReadonlyArray<string>,
    options: { readonly roots?: boolean; readonly project?: string } = {},
  ): Promise<Array<EndedSpan>> {
    const project = encodeURIComponent(options.project ?? this.project)

    const pages = await Promise.all(
      chunks(traceIds, TRACE_CHUNK).map(async (group) => {
        const found: Array<EndedSpan> = []
        let cursor: string | undefined

        do {
          const query: Array<readonly [string, string]> = group.map((id) => ["trace_id", id] as const)

          query.push(["limit", "1000"])

          if (options.roots === true) query.push(["parent_id", "null"])

          if (cursor !== undefined) query.push(["cursor", cursor])

          const page = await this.get(`projects/${project}/spans/otlpv1`, query, parseSpansPage)

          for (const span of page?.data ?? []) {
            const ended = spanFromOtlp(span)

            if (ended !== undefined) found.push(ended)
          }

          cursor = page?.next_cursor ?? undefined
        } while (cursor !== undefined)

        return found
      }),
    )

    return pages.flat()
  }

  /** Trace annotations on these traces, in the order Phoenix returns them. */
  async traceAnnotations(traceIds: ReadonlyArray<string>): Promise<Array<RemoteAnnotation>> {
    const pages = await Promise.all(
      chunks(traceIds, TRACE_CHUNK).map(async (group) => {
        const found: Array<RemoteAnnotation> = []
        let cursor: string | undefined

        do {
          const query: Array<readonly [string, string]> = group.map((id) => ["trace_ids", id] as const)

          query.push(["limit", "1000"])

          if (cursor !== undefined) query.push(["cursor", cursor])

          const route = `projects/${encodeURIComponent(this.project)}/trace_annotations`
          const page = await this.get(route, query, parseAnnotations)

          found.push(...(page?.data ?? []))
          cursor = page?.next_cursor ?? undefined
        } while (cursor !== undefined)

        return found
      }),
    )

    return pages.flat()
  }
}

// --- links -------------------------------------------------------------------

export type PhoenixLink =
  | { readonly kind: "session"; readonly id: string }
  /** `project` is absent in a `/redirects/traces/...` link. */
  | { readonly kind: "trace"; readonly id: string; readonly project: string | undefined }

/**
 * A session or trace URL copied from the Phoenix UI:
 * `.../projects/<project>/sessions/<id>`, `.../projects/<project>/traces/<trace id>`,
 * or `.../redirects/traces/<trace id>`.
 */
export const parsePhoenixLink = (text: string): PhoenixLink | undefined => {
  if (!URL.canParse(text)) return undefined

  const match = /(?:\/projects\/([^/]+)|\/redirects)\/(sessions|traces)\/([^/?#]+)/.exec(
    new URL(text).pathname,
  )

  if (match === null) return undefined

  const [, project, kind, id = ""] = match

  return kind === "sessions"
    ? { kind: "session", id: decodeURIComponent(id) }
    : {
        kind: "trace",
        id: decodeURIComponent(id),
        project: project === undefined ? undefined : decodeURIComponent(project),
      }
}
