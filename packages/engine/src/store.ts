import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { loadConfig } from "./config.ts"
import {
  type AnnotationFile,
  type Device,
  type EndedSpan,
  FORMAT_VERSION,
  type InboxFile,
  kindOf,
  parseAnnotation,
  parseDelta,
  parseDevice,
  parseEndedSpan,
  parseHeader,
  parseInbox,
  parseSpan,
  printAnnotation,
  printDevice,
  printHeader,
  printInbox,
  printSpan,
  type SessionHeader,
  type SpanFile,
  type StreamDelta,
  spanFileName,
  stringAttr,
} from "./format.ts"
import { isoToNs, newId, newSessionId, nowNs, nsToIso } from "./ids.ts"

/**
 * The span store.
 *
 *   sessions/<session-id>/
 *     session.json
 *     traces/<trace-id>/<start-ns>-<span-id>.json          ended, immutable
 *     traces/<trace-id>/<start-ns>-<span-id>.open.json     in flight
 *     traces/<trace-id>/<start-ns>-<span-id>.stream.jsonl  in-flight deltas
 *     annotations/<id>.json
 *     inbox/<id>.json
 *
 * Ended span files, annotations and inbox entries are never modified, so two
 * copies of a session merge by taking the union of their files.
 */

export type StoreEvent =
  | { readonly type: "session"; readonly session_id: string; readonly header: SessionHeader }
  | { readonly type: "span_open"; readonly session_id: string; readonly span: SpanFile }
  | { readonly type: "span_end"; readonly session_id: string; readonly span: EndedSpan }
  | {
      readonly type: "delta"
      readonly session_id: string
      readonly trace_id: string
      readonly span_id: string
      readonly delta: StreamDelta
    }
  | { readonly type: "annotation"; readonly session_id: string; readonly annotation: AnnotationFile }
  | { readonly type: "inbox"; readonly session_id: string; readonly entry: InboxFile }

export interface OpenSpan {
  readonly span: SpanFile
  /** Last heartbeat, from the in-flight file's modification time. */
  readonly heartbeat_ms: number
  readonly deltas: ReadonlyArray<StreamDelta>
}

export interface TraceFiles {
  readonly trace_id: string
  readonly ended: ReadonlyArray<EndedSpan>
  readonly open: ReadonlyArray<OpenSpan>
}

const HEARTBEAT_MS = 2000

/** An in-flight span with no heartbeat for this long has no live writer. */
export const STALE_AFTER_MS = 10_000

const TEXT_PART = /^llm\.output_messages\.(\d+)\.message\.contents\.(\d+)\.message_content\.text$/
const WHOLE_TEXT = /^llm\.output_messages\.\d+\.message\.content$/

/**
 * The text a model call replied with, from the `LLM` span's output message
 * attributes: the text parts in order where a message is recorded in parts
 * (Anthropic), and its whole content otherwise (OpenAI).
 */
const replyText = (span: EndedSpan): string => {
  if (kindOf(span) !== "LLM") return ""

  const parts = Object.keys(span.attributes)
    .flatMap((key) => {
      const match = TEXT_PART.exec(key)

      if (match === null || span.attributes[key.replace(/text$/, "type")] !== "text") return []

      return [{ message: Number(match[1]), part: Number(match[2]), text: stringAttr(span, key) ?? "" }]
    })
    .toSorted((x, y) => x.message - y.message || x.part - y.part)

  return parts.length > 0
    ? parts.map((part) => part.text).join("")
    : Object.keys(span.attributes)
        .filter((key) => WHOLE_TEXT.test(key))
        .toSorted()
        .map((key) => stringAttr(span, key) ?? "")
        .join("")
}

/** How often a followed session's files are checked, and how many of its newest traces. */
const FOLLOW_MS = 150
const FOLLOW_TRACES = 3

const ENDED_NAME = /^\d{20}-[0-9a-f]{16}\.json$/
const OPEN_NAME = /^\d{20}-[0-9a-f]{16}\.open\.json$/
const TRACE_NAME = /^[0-9a-f]{32}$/
const SYNC_SPAN = /^traces\/[0-9a-f]{32}\/\d{20}-[0-9a-f]{16}\.json$/
const SYNC_SIDE = /^(?:annotations|inbox)\/[0-9a-zA-Z-]+\.json$/

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

const readWith = <A>(parse: (text: string) => A | undefined, file: string): A | undefined => {
  const text = readText(file)

  return text === undefined ? undefined : parse(text)
}

const listDir = (dir: string): Array<string> => {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

const readAll = <A>(parse: (text: string) => A | undefined, dir: string): Array<A> => {
  const values: Array<A> = []

  for (const name of listDir(dir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue

    const value = readWith(parse, path.join(dir, name))

    if (value !== undefined) values.push(value)
  }

  return values
}

const writeAtomic = (file: string, contents: string, durable: boolean): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  const fd = fs.openSync(tmp, "w")

  try {
    fs.writeSync(fd, contents)

    if (durable) fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  fs.renameSync(tmp, file)
}

const readDeltas = (file: string): Array<StreamDelta> => {
  const deltas: Array<StreamDelta> = []

  for (const line of (readText(file) ?? "").split("\n")) {
    // A torn final line from a crashed writer fails to parse and is skipped.
    const delta = line === "" ? undefined : parseDelta(line)

    if (delta !== undefined) deltas.push(delta)
  }

  return deltas
}

export class Store {
  readonly home: string
  readonly sessionsDir: string
  private readonly listeners = new Set<(event: StoreEvent) => void>()
  private readonly streams = new Map<string, number>()
  private readonly owned = new Map<string, string>()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private deviceCache: Device | undefined

  constructor(home?: string) {
    this.home = home ?? loadConfig().home
    this.sessionsDir = path.join(this.home, "sessions")
    fs.mkdirSync(this.sessionsDir, { recursive: true })
  }

  // --- identity -----------------------------------------------------------

  /** This machine's identity. Local to the device; never synced. */
  device(): Device {
    if (this.deviceCache !== undefined) return this.deviceCache

    const file = path.join(this.home, "device.json")
    const existing = readWith(parseDevice, file)

    if (existing !== undefined) {
      this.deviceCache = existing

      return existing
    }

    const created: Device = { id: newId(), name: os.hostname() }

    writeAtomic(file, printDevice(created), true)
    this.deviceCache = created

    return created
  }

  // --- events -------------------------------------------------------------

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A failing listener must never break a write.
      }
    }
  }

  // --- paths --------------------------------------------------------------

  sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId)
  }

  traceDir(sessionId: string, traceId: string): string {
    return path.join(this.sessionDir(sessionId), "traces", traceId)
  }

  private spanBase(sessionId: string, span: SpanFile): string {
    return path.join(
      this.traceDir(sessionId, span.context.trace_id),
      spanFileName(isoToNs(span.start_time), span.context.span_id),
    )
  }

  // --- sessions -----------------------------------------------------------

  /** `delegated` makes it a subagent's session: who delegated it, and what the task is. */
  createSession(
    cwd: string,
    id: string = newSessionId(),
    delegated?: Required<Pick<SessionHeader, "parent" | "task">>,
  ): SessionHeader {
    const header: SessionHeader = {
      format: FORMAT_VERSION,
      id,
      created_at: nsToIso(nowNs()),
      cwd,
      device: this.device(),
      ...delegated,
    }

    writeAtomic(path.join(this.sessionDir(id), "session.json"), printHeader(header), true)
    fs.mkdirSync(path.join(this.sessionDir(id), "traces"), { recursive: true })
    this.emit({ type: "session", session_id: id, header })

    return header
  }

  readHeader(sessionId: string): SessionHeader | undefined {
    return readWith(parseHeader, path.join(this.sessionDir(sessionId), "session.json"))
  }

  listSessionIds(): Array<string> {
    return listDir(this.sessionsDir).filter((name) => !name.startsWith("."))
  }

  /** Resolve a full id or a unique prefix of one. */
  resolveSession(idOrPrefix: string): string | undefined {
    const ids = this.listSessionIds()

    if (ids.includes(idOrPrefix)) return idOrPrefix

    const matches = ids.filter((id) => id.startsWith(idOrPrefix))

    return matches.length === 1 ? matches[0] : undefined
  }

  /** Bytes a session occupies on disk: every file under its directory. */
  sessionBytes(sessionId: string): number {
    const root = this.sessionDir(sessionId)
    let total = 0

    try {
      for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue

        total += fs.statSync(path.join(entry.parentPath, entry.name), { throwIfNoEntry: false })?.size ?? 0
      }
    } catch {
      return 0
    }

    return total
  }

  listTraceIds(sessionId: string): Array<string> {
    return listDir(path.join(this.sessionDir(sessionId), "traces")).filter((name) => TRACE_NAME.test(name))
  }

  // --- spans --------------------------------------------------------------

  /** Write (or rewrite) the in-flight file for a span this process owns. */
  openSpan(sessionId: string, span: SpanFile, announce: boolean): void {
    const file = `${this.spanBase(sessionId, span)}.open.json`

    writeAtomic(file, printSpan(span), false)
    this.owned.set(span.context.span_id, file)
    this.startHeartbeat()

    if (announce) this.emit({ type: "span_open", session_id: sessionId, span })
  }

  appendDelta(sessionId: string, span: SpanFile, delta: StreamDelta): void {
    const file = `${this.spanBase(sessionId, span)}.stream.jsonl`
    let fd = this.streams.get(file)

    if (fd === undefined) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fd = fs.openSync(file, "a")
      this.streams.set(file, fd)
    }

    fs.writeSync(fd, `${JSON.stringify(delta)}\n`)
    this.emit({
      type: "delta",
      session_id: sessionId,
      trace_id: span.context.trace_id,
      span_id: span.context.span_id,
      delta,
    })
  }

  /** Write the final, immutable span file and drop the in-flight files. */
  endSpan(sessionId: string, span: EndedSpan): void {
    const base = this.spanBase(sessionId, span)
    const stream = `${base}.stream.jsonl`
    const fd = this.streams.get(stream)

    writeAtomic(`${base}.json`, printSpan(span), true)

    if (fd !== undefined) {
      fs.closeSync(fd)
      this.streams.delete(stream)
    }

    fs.rmSync(`${base}.open.json`, { force: true })
    fs.rmSync(stream, { force: true })
    this.owned.delete(span.context.span_id)
    this.emit({ type: "span_end", session_id: sessionId, span })
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== undefined) return

    this.heartbeat = setInterval(() => {
      const now = new Date()

      for (const file of this.owned.values()) {
        try {
          fs.utimesSync(file, now, now)
        } catch {
          // The span ended between the check and the touch.
        }
      }
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  readTrace(sessionId: string, traceId: string): TraceFiles {
    const dir = this.traceDir(sessionId, traceId)
    const names = listDir(dir)
    const ended: Array<EndedSpan> = []
    const open: Array<OpenSpan> = []
    const endedIds = new Set<string>()

    for (const name of names) {
      const span = ENDED_NAME.test(name) ? readWith(parseEndedSpan, path.join(dir, name)) : undefined

      // The same span can arrive twice under different names (an import rounds
      // its start time), so the span id decides.
      if (span === undefined || endedIds.has(span.context.span_id)) continue

      ended.push(span)
      endedIds.add(span.context.span_id)
    }

    for (const name of names) {
      const file = path.join(dir, name)
      const span = OPEN_NAME.test(name) ? readWith(parseSpan, file) : undefined

      if (span === undefined || endedIds.has(span.context.span_id)) continue

      open.push({
        span,
        heartbeat_ms: fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0,
        deltas: readDeltas(file.replace(/\.open\.json$/, ".stream.jsonl")),
      })
    }

    return { trace_id: traceId, ended, open }
  }

  /**
   * Read only the root span of a trace. The root starts first, so it is the
   * first span file in name order and the rest of the trace is never parsed.
   */
  readTraceRoots(sessionId: string, traceId: string): TraceFiles {
    const dir = this.traceDir(sessionId, traceId)

    for (const name of listDir(dir)) {
      const file = path.join(dir, name)

      if (ENDED_NAME.test(name)) {
        const span = readWith(parseEndedSpan, file)

        if (span?.parent_id === null) return { trace_id: traceId, ended: [span], open: [] }
      }

      if (OPEN_NAME.test(name)) {
        const span = readWith(parseSpan, file)
        const heartbeat = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0

        if (span?.parent_id === null) {
          return { trace_id: traceId, ended: [], open: [{ span, heartbeat_ms: heartbeat, deltas: [] }] }
        }
      }
    }

    return { trace_id: traceId, ended: [], open: [] }
  }

  // --- import -------------------------------------------------------------

  /**
   * Write an ended span that came from elsewhere (Phoenix). Nothing is
   * announced, and a span this session already has is left alone.
   * Returns whether a file was written.
   */
  importSpan(sessionId: string, span: EndedSpan): boolean {
    const dir = this.traceDir(sessionId, span.context.trace_id)
    const suffix = `-${span.context.span_id}.json`

    if (listDir(dir).some((name) => name.endsWith(suffix))) return false

    writeAtomic(`${this.spanBase(sessionId, span)}.json`, printSpan(span), true)

    return true
  }

  /** Write a session header that came from elsewhere, unless the session has one. */
  importHeader(header: SessionHeader): void {
    const file = path.join(this.sessionDir(header.id), "session.json")

    if (fs.existsSync(file)) return

    writeAtomic(file, printHeader(header), true)
    fs.mkdirSync(path.join(this.sessionDir(header.id), "traces"), { recursive: true })
  }

  /**
   * Delete a session's directory. Only for a session that is safely
   * elsewhere: moving it to Phoenix-only storage verifies that first.
   */
  removeSession(sessionId: string): void {
    if (!this.listSessionIds().includes(sessionId)) return

    fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true })
  }

  // --- annotations --------------------------------------------------------

  /** `announce: false` for an annotation imported from Phoenix rather than produced here. */
  writeAnnotation(annotation: AnnotationFile, announce = true): void {
    const sessionId = annotation.target.session_id
    const file = path.join(this.sessionDir(sessionId), "annotations", `${annotation.id}.json`)

    writeAtomic(file, printAnnotation(annotation), true)

    if (announce) this.emit({ type: "annotation", session_id: sessionId, annotation })
  }

  listAnnotations(sessionId: string): Array<AnnotationFile> {
    return readAll(parseAnnotation, path.join(this.sessionDir(sessionId), "annotations")).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    )
  }

  // --- following another writer -------------------------------------------

  /**
   * Emit events for what another process writes to a session, by watching
   * its files: the same events a writer in this process would emit. It
   * starts from now: spans already ended are history, read with the fold;
   * spans in flight are announced, with what they stream from here on.
   * Returns how to stop.
   */
  follow(sessionId: string, intervalMs: number = FOLLOW_MS): () => void {
    const ended = new Set<string>()
    /** In-flight span file → how many of its deltas have been emitted. */
    const open = new Map<string, number>()
    /** Span id → the reply text emitted for it so far. */
    const shown = new Map<string, string>()
    const side = new Set<string>()
    let first = true

    const scanTrace = (traceId: string): void => {
      const dir = this.traceDir(sessionId, traceId)
      const finished: Array<EndedSpan> = []

      for (const name of listDir(dir)) {
        const file = path.join(dir, name)

        if (ENDED_NAME.test(name) && !ended.has(file)) {
          ended.add(file)

          const span = first ? undefined : readWith(parseEndedSpan, file)

          if (span !== undefined) finished.push(span)
        }

        if (!OPEN_NAME.test(name)) continue

        const span = readWith(parseSpan, file)

        if (span === undefined) continue

        const deltas = readDeltas(file.replace(/\.open\.json$/, ".stream.jsonl"))
        const sent = open.get(file)

        // A turn already running is shown by the fold; only what is inside it is news.
        if (sent === undefined && !(first && span.parent_id === null))
          this.emit({ type: "span_open", session_id: sessionId, span })

        for (const delta of deltas.slice(sent ?? (first ? deltas.length : 0))) {
          if (delta.k === "text")
            shown.set(span.context.span_id, `${shown.get(span.context.span_id) ?? ""}${delta.d}`)

          this.emit({
            type: "delta",
            session_id: sessionId,
            trace_id: span.context.trace_id,
            span_id: span.context.span_id,
            delta,
          })
        }

        open.set(file, deltas.length)
      }

      // Files list by start time; spans that ended since the last look are told in the order they ended.
      for (const span of finished.toSorted((a, b) => a.end_time.localeCompare(b.end_time))) {
        // A span's stream file goes when it ends, so what it streamed since the last look, or
        // all of it for a call that began and ended between two looks, is only in the ended span.
        const reply = replyText(span)
        const seen = shown.get(span.context.span_id) ?? ""
        const missed = reply.startsWith(seen) ? reply.slice(seen.length) : ""

        shown.delete(span.context.span_id)

        if (missed !== "")
          this.emit({
            type: "delta",
            session_id: sessionId,
            trace_id: span.context.trace_id,
            span_id: span.context.span_id,
            delta: { k: "text", i: 0, d: missed },
          })

        this.emit({ type: "span_end", session_id: sessionId, span })
      }
    }

    const scanSide = (): void => {
      for (const entry of this.listInbox(sessionId)) {
        if (side.has(entry.id)) continue

        side.add(entry.id)

        if (!first) this.emit({ type: "inbox", session_id: sessionId, entry })
      }

      for (const annotation of this.listAnnotations(sessionId)) {
        if (side.has(annotation.id)) continue

        side.add(annotation.id)

        if (!first) this.emit({ type: "annotation", session_id: sessionId, annotation })
      }
    }

    const scan = (): void => {
      const traces = this.listTraceIds(sessionId)

      // Trace ids sort by time: after the first pass, only the newest can change.
      for (const traceId of first ? traces : traces.slice(-FOLLOW_TRACES)) scanTrace(traceId)

      scanSide()
      first = false
    }

    scan()

    const timer = setInterval(scan, intervalMs)

    return () => clearInterval(timer)
  }

  // --- inbox --------------------------------------------------------------

  /** `id` is for an entry that must exist only once however often it is written (a job's result). */
  writeInbox(
    sessionId: string,
    entry: Omit<InboxFile, "id" | "created_at">,
    id: string = newId(),
  ): InboxFile {
    const full: InboxFile = { id, created_at: nsToIso(nowNs()), ...entry }

    writeAtomic(path.join(this.sessionDir(sessionId), "inbox", `${full.id}.json`), printInbox(full), true)
    this.emit({ type: "inbox", session_id: sessionId, entry: full })

    return full
  }

  listInbox(sessionId: string): Array<InboxFile> {
    return readAll(parseInbox, path.join(this.sessionDir(sessionId), "inbox")).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    )
  }

  // --- sync ---------------------------------------------------------------

  /**
   * Relative paths of every immutable file in a session. Two stores are in
   * sync when their manifests are equal; syncing is copying the difference.
   */
  manifest(sessionId: string): Array<string> {
    const root = this.sessionDir(sessionId)
    const paths: Array<string> = []

    if (fs.existsSync(path.join(root, "session.json"))) paths.push("session.json")

    for (const traceId of this.listTraceIds(sessionId)) {
      for (const name of listDir(path.join(root, "traces", traceId))) {
        if (ENDED_NAME.test(name)) paths.push(`traces/${traceId}/${name}`)
      }
    }

    for (const sub of ["annotations", "inbox"]) {
      for (const name of listDir(path.join(root, sub))) {
        if (name.endsWith(".json") && !name.startsWith(".")) paths.push(`${sub}/${name}`)
      }
    }

    return paths
  }

  static isSyncPath(rel: string): boolean {
    return rel === "session.json" || SYNC_SPAN.test(rel) || SYNC_SIDE.test(rel)
  }

  readSyncFile(sessionId: string, rel: string): string | undefined {
    return Store.isSyncPath(rel) ? readText(path.join(this.sessionDir(sessionId), rel)) : undefined
  }

  /**
   * Accept a file from a peer. Existing files win: immutable files with the
   * same name are the same file. Returns whether anything was written.
   */
  importFile(sessionId: string, rel: string, contents: string): boolean {
    const file = path.join(this.sessionDir(sessionId), rel)

    if (!Store.isSyncPath(rel) || fs.existsSync(file)) return false

    if (rel === "session.json") {
      const header = parseHeader(contents)

      if (header === undefined) return false

      writeAtomic(file, contents, true)
      this.emit({ type: "session", session_id: sessionId, header })

      return true
    }

    if (rel.startsWith("traces/")) {
      const span = parseEndedSpan(contents)

      if (span === undefined) return false

      const base = file.replace(/\.json$/, "")

      writeAtomic(file, contents, true)
      // A mirrored in-flight copy is superseded by the ended span.
      fs.rmSync(`${base}.open.json`, { force: true })
      fs.rmSync(`${base}.stream.jsonl`, { force: true })
      this.emit({ type: "span_end", session_id: sessionId, span })

      return true
    }

    if (rel.startsWith("annotations/")) {
      const annotation = parseAnnotation(contents)

      if (annotation === undefined) return false

      writeAtomic(file, contents, true)
      this.emit({ type: "annotation", session_id: sessionId, annotation })

      return true
    }

    const entry = parseInbox(contents)

    if (entry === undefined) return false

    writeAtomic(file, contents, true)
    this.emit({ type: "inbox", session_id: sessionId, entry })

    return true
  }

  /** Mirror a peer's in-flight span so local readers see it. Not owned here. */
  mirrorOpen(sessionId: string, span: SpanFile): void {
    const base = this.spanBase(sessionId, span)

    if (fs.existsSync(`${base}.json`)) return

    writeAtomic(`${base}.open.json`, printSpan(span), false)
    this.emit({ type: "span_open", session_id: sessionId, span })
  }

  mirrorDelta(sessionId: string, span: SpanFile, delta: StreamDelta): void {
    const base = this.spanBase(sessionId, span)

    if (fs.existsSync(`${base}.json`)) return

    fs.mkdirSync(path.dirname(base), { recursive: true })
    fs.appendFileSync(`${base}.stream.jsonl`, `${JSON.stringify(delta)}\n`)
    this.emit({
      type: "delta",
      session_id: sessionId,
      trace_id: span.context.trace_id,
      span_id: span.context.span_id,
      delta,
    })
  }

  close(): void {
    clearInterval(this.heartbeat)
    this.heartbeat = undefined

    for (const fd of this.streams.values()) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed.
      }
    }

    this.streams.clear()
  }
}
