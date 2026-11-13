/**
 * Export to a Phoenix server.
 *
 * Spans are posted as OTLP when they end; annotations are posted to the
 * annotation endpoints. Phoenix ignores a span id it already has, so sending
 * a span twice (from a retry, a sweep or a second device) is harmless.
 *
 * What has been sent is tracked in a per-collector log outside the session
 * tree: it is local bookkeeping, not session state, and is never synced.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { type AnnotationFile, type EndedSpan, METADATA_KEY } from "../format.ts"
import type { Store, StoreEvent } from "../store.ts"
import { encodeTraceRequest } from "./otlp.ts"

export interface PhoenixTarget {
  readonly endpoint: string
  readonly project: string
  readonly apiKey?: string | undefined
}

export interface ExportReport {
  readonly spans: number
  readonly annotations: number
  readonly errors: ReadonlyArray<string>
}

const FLUSH_MS = 250

const ANNOTATION_ROUTE = {
  span: "span_annotations",
  trace: "trace_annotations",
  session: "session_annotations",
} as const

const targetFor = (annotation: AnnotationFile) => {
  if (annotation.scope === "span") return { span_id: annotation.target.span_id ?? "" }

  if (annotation.scope === "trace") return { trace_id: annotation.target.trace_id ?? "" }

  return { session_id: annotation.target.session_id }
}

export class PhoenixExporter {
  private readonly store: Store
  private readonly destination: PhoenixTarget
  private readonly logFile: string
  private readonly sent: Set<string>
  private readonly spans: Array<EndedSpan> = []
  private readonly annotations: Array<AnnotationFile> = []
  private readonly errors: Array<string> = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> = Promise.resolve()
  private spanCount = 0
  private annotationCount = 0

  constructor(store: Store, target: PhoenixTarget) {
    const key = createHash("sha256")
      .update(`${target.endpoint}\n${target.project}`)
      .digest("hex")
      .slice(0, 16)

    this.store = store
    this.destination = { ...target, endpoint: target.endpoint.replace(/\/+$/, "") }
    this.logFile = path.join(store.home, "export", `${key}.log`)
    this.sent = new Set(this.readLog())
  }

  private readLog(): Array<string> {
    try {
      return fs.readFileSync(this.logFile, "utf8").split("\n").filter(Boolean)
    } catch {
      return []
    }
  }

  private remember(ids: ReadonlyArray<string>): void {
    if (ids.length === 0) return

    for (const id of ids) this.sent.add(id)

    fs.mkdirSync(path.dirname(this.logFile), { recursive: true })
    fs.appendFileSync(this.logFile, `${ids.join("\n")}\n`)
  }

  /** Record ids Phoenix already has (because they were imported from it), so they are not sent back. */
  markSent(ids: ReadonlyArray<string>): void {
    this.remember(ids.filter((id) => !this.sent.has(id)))
  }

  /** Ids in this list that this collector has not been sent. */
  unsent(ids: ReadonlyArray<string>): Array<string> {
    return ids.filter((id) => !this.sent.has(id))
  }

  get target(): PhoenixTarget {
    return this.destination
  }

  /** Export spans and annotations as they are written. Returns a stop function. */
  watch(): () => void {
    return this.store.subscribe((event) => this.onEvent(event))
  }

  private onEvent(event: StoreEvent): void {
    if (event.type === "span_end") this.queueSpan(event.span)

    if (event.type === "annotation") this.queueAnnotation(event.annotation)
  }

  private queueSpan(span: EndedSpan): void {
    if (this.sent.has(span.context.span_id)) return

    this.spans.push(span)
    this.schedule()
  }

  private queueAnnotation(annotation: AnnotationFile): void {
    if (this.sent.has(annotation.id)) return

    this.annotations.push(annotation)
    this.schedule()
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, FLUSH_MS)
  }

  /** Queue everything in a session that has not been sent yet. */
  sweep(sessionId: string): void {
    for (const traceId of this.store.listTraceIds(sessionId)) {
      for (const span of this.store.readTrace(sessionId, traceId).ended) this.queueSpan(span)
    }

    for (const annotation of this.store.listAnnotations(sessionId)) this.queueAnnotation(annotation)
  }

  private headers(contentType: string): Headers {
    const headers = new Headers({ "content-type": contentType })

    if (this.destination.apiKey !== undefined)
      headers.set("authorization", `Bearer ${this.destination.apiKey}`)

    return headers
  }

  private async post(
    route: string,
    contentType: string,
    body: string | Uint8Array<ArrayBuffer>,
  ): Promise<string | undefined> {
    try {
      const response = await fetch(`${this.destination.endpoint}/v1/${route}`, {
        method: "POST",
        headers: this.headers(contentType),
        body,
      })

      return response.ok
        ? undefined
        : `${route}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
    } catch (error) {
      return `${route}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private async sendSpans(): Promise<void> {
    const batch = this.spans.splice(0)

    if (batch.length === 0) return

    const body = encodeTraceRequest(batch, { project: this.destination.project, serviceName: "oi-agent" })
    const error = await this.post("traces", "application/x-protobuf", new Uint8Array(body))

    if (error !== undefined) {
      this.errors.push(error)

      return
    }

    this.spanCount += batch.length
    this.remember(batch.map((span) => span.context.span_id))
  }

  private async sendAnnotations(): Promise<void> {
    const batch = this.annotations.splice(0)

    for (const scope of ["span", "trace", "session"] as const) {
      const group = batch.filter((annotation) => annotation.scope === scope)

      if (group.length === 0) continue

      const data = group.map((file) => ({
        ...targetFor(file),
        name: file.annotation.name,
        annotator_kind: file.annotation.annotator_kind,
        identifier: file.annotation.identifier ?? "",
        // The local id rides along so an import can restore it: Phoenix assigns its own.
        metadata: { ...file.annotation.metadata, [METADATA_KEY]: { id: file.id } },
        result: {
          label: file.annotation.label,
          score: file.annotation.score,
          explanation: file.annotation.explanation,
        },
      }))

      const error = await this.post(ANNOTATION_ROUTE[scope], "application/json", JSON.stringify({ data }))

      if (error === undefined) {
        this.annotationCount += group.length
        this.remember(group.map((annotation) => annotation.id))
      } else {
        this.errors.push(error)
      }
    }
  }

  /** Send everything queued. Spans go first so annotations find their targets. */
  flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    this.flushing = this.flushing.then(async () => {
      await this.sendSpans()
      await this.sendAnnotations()
    })

    return this.flushing
  }

  report(): ExportReport {
    return { spans: this.spanCount, annotations: this.annotationCount, errors: [...this.errors] }
  }
}
