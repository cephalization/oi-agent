/**
 * Where a session's files live: on this disk, or only in Phoenix.
 *
 * The fold reads nothing but local span files, so a session kept in Phoenix
 * is imported (written back to disk) before it is opened, and moved out
 * again afterwards. Moving out deletes the local files only after Phoenix
 * has been checked to hold every span and annotation.
 *
 * Which sessions live only in Phoenix is local bookkeeping, not session
 * state: one small marker file per session under `<home>/remote/`, outside
 * the session tree, holding the header and a summary for listing offline.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Schema } from "effect"
import { loadSession } from "../fold.ts"
import {
  type AnnotationFile,
  type EndedSpan,
  kindOf,
  OI,
  parser,
  printer,
  readMetadata,
  SessionHeader,
  stringAttr,
  type Workspace,
} from "../format.ts"
import type { PhoenixExporter, PhoenixTarget } from "../export/phoenix.ts"
import type { Store } from "../store.ts"
import { annotationFromRemote, type PhoenixClient } from "./phoenix.ts"

// --- summaries ---------------------------------------------------------------

export const SessionSummary = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  turns: Schema.Int,
  /** The first line of the first prompt. */
  title: Schema.String,
  /** When the latest turn started, or the session was created if it has none. */
  active_at: Schema.String,
})

export type SessionSummary = typeof SessionSummary.Type

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? ""

/** A summary of a session on disk. */
export const summarizeSession = (store: Store, sessionId: string): SessionSummary => {
  const view = loadSession(store, sessionId)

  return {
    id: sessionId,
    cwd: view.header?.cwd ?? "",
    turns: view.turns.length,
    title: firstLine(view.turns[0]?.input ?? ""),
    active_at: view.turns.at(-1)?.root.start_time ?? view.header?.created_at ?? "",
  }
}

/** The workspace the session's latest turn recorded, if it recorded one. */
export const lastWorkspace = (store: Store, sessionId: string): Workspace | undefined =>
  loadSession(store, sessionId)
    .turns.map((turn) => readMetadata(turn.root).workspace)
    .findLast((workspace) => workspace !== undefined)

// --- markers -----------------------------------------------------------------

const RemoteMarker = Schema.Struct({
  header: SessionHeader,
  summary: SessionSummary,
  endpoint: Schema.String,
  project: Schema.String,
  moved_at: Schema.String,
})

export type RemoteMarker = typeof RemoteMarker.Type

const parseMarker = parser(RemoteMarker)
const printMarker = printer(RemoteMarker)

const markerDir = (store: Store): string => path.join(store.home, "remote")

const markerFile = (store: Store, sessionId: string): string =>
  path.join(markerDir(store), `${sessionId}.json`)

export const readMarker = (store: Store, sessionId: string): RemoteMarker | undefined => {
  try {
    return parseMarker(fs.readFileSync(markerFile(store, sessionId), "utf8"))
  } catch {
    return undefined
  }
}

/** Sessions kept only in Phoenix. */
export const listMarkers = (store: Store): Array<RemoteMarker> => {
  let names: Array<string> = []

  try {
    names = fs.readdirSync(markerDir(store)).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }

  return names.flatMap((name) => readMarker(store, name.slice(0, -".json".length)) ?? [])
}

const writeMarker = (store: Store, marker: RemoteMarker): void => {
  fs.mkdirSync(markerDir(store), { recursive: true })
  fs.writeFileSync(markerFile(store, marker.header.id), printMarker(marker))
}

/**
 * Mark a session on disk as one to keep in Phoenix, without moving it yet:
 * for a session imported to be opened, which goes back once it is left.
 */
export const keepInPhoenix = (store: Store, sessionId: string, target: PhoenixTarget): void => {
  const header = store.readHeader(sessionId)

  if (header === undefined) return

  writeMarker(store, {
    header,
    summary: summarizeSession(store, sessionId),
    endpoint: target.endpoint,
    project: target.project,
    moved_at: new Date().toISOString(),
  })
}

/** Keep a session on disk from now on. Its files stay where they are. */
export const forgetMarker = (store: Store, sessionId: string): void => {
  fs.rmSync(markerFile(store, sessionId), { force: true })
}

// --- listing what Phoenix has -------------------------------------------------

/** Sessions in the Phoenix project that oi-agent turns belong to, most recently started first. */
export const listRemoteSessions = async (
  client: PhoenixClient,
  limit: number,
): Promise<Array<SessionSummary>> => {
  const sessions = await client.sessions(limit)

  const roots = await client.spans(
    sessions.flatMap((session) => session.traces.map((trace) => trace.trace_id)),
    { roots: true },
  )

  const turnsBySession = new Map<string, Array<EndedSpan>>()

  for (const root of roots) {
    const sessionId = stringAttr(root, OI.SESSION_ID)

    if (sessionId === undefined || kindOf(root) !== "AGENT") continue

    turnsBySession.set(sessionId, [...(turnsBySession.get(sessionId) ?? []), root])
  }

  return sessions.flatMap((session) => {
    const turns = (turnsBySession.get(session.session_id) ?? []).toSorted((a, b) =>
      a.start_time.localeCompare(b.start_time),
    )

    const first = turns[0]
    const last = turns.at(-1)

    if (first === undefined || last === undefined) return []

    return [
      {
        id: session.session_id,
        cwd: readMetadata(last).workspace?.cwd ?? "",
        turns: turns.length,
        title: firstLine(stringAttr(first, OI.INPUT_VALUE) ?? ""),
        active_at: last.start_time,
      },
    ]
  })
}

// --- import --------------------------------------------------------------------

export interface ImportResult {
  readonly sessionId: string
  readonly header: SessionHeader
  /** Span files written; spans already on disk are left alone. */
  readonly spans: number
  readonly annotations: number
  /** Span and annotation ids Phoenix has, for the exporter's sent log. */
  readonly ids: ReadonlyArray<string>
}

export interface ImportOptions {
  /** The directory to run in when the session's own is not on this machine. */
  readonly cwd: string
  /** This machine, recorded as the device when Phoenix does not say where the session came from. */
  readonly device: SessionHeader["device"]
}

const headerFor = (
  sessionId: string,
  spans: ReadonlyArray<EndedSpan>,
  startedAt: string,
  options: ImportOptions,
): SessionHeader => {
  const turns = spans
    .filter((span) => span.parent_id === null && kindOf(span) === "AGENT")
    .toSorted((a, b) => a.start_time.localeCompare(b.start_time))

  const recorded = turns.map((turn) => readMetadata(turn).workspace?.cwd).findLast((cwd) => cwd !== undefined)
  const device = turns.map((turn) => readMetadata(turn).device).find((id) => id !== undefined)

  return {
    format: "oi-agent/1",
    id: sessionId,
    created_at: turns[0]?.start_time ?? new Date(startedAt).toISOString(),
    cwd: recorded !== undefined && fs.existsSync(recorded) ? recorded : options.cwd,
    device: device === undefined ? options.device : { id: device, name: "unknown" },
  }
}

/**
 * Write a Phoenix session's spans and annotations into the local store.
 * Anything already on disk is kept, so importing a session that is partly
 * local fills in what is missing. Returns `undefined` when Phoenix has no
 * such session.
 */
export const importSession = async (
  store: Store,
  client: PhoenixClient,
  identifier: string,
  options: ImportOptions,
): Promise<ImportResult | undefined> => {
  const info = await client.session(identifier)

  if (info === undefined) return undefined

  const sessionId = info.session_id
  const traceIds = info.traces.map((trace) => trace.trace_id)

  const [spans, remoteAnnotations] = await Promise.all([
    client.spans(traceIds),
    client.traceAnnotations(traceIds),
  ])

  const header =
    readMarker(store, sessionId)?.header ??
    store.readHeader(sessionId) ??
    headerFor(sessionId, spans, info.start_time, options)

  store.importHeader(header)

  let written = 0

  for (const span of spans) if (store.importSpan(sessionId, span)) written += 1

  const existing = new Set(store.listAnnotations(sessionId).map((annotation) => annotation.id))

  const annotations: Array<AnnotationFile> = remoteAnnotations.map((remote) =>
    annotationFromRemote(sessionId, remote),
  )

  for (const annotation of annotations) {
    if (!existing.has(annotation.id)) store.writeAnnotation(annotation, false)
  }

  return {
    sessionId,
    header,
    spans: written,
    annotations: annotations.filter((annotation) => !existing.has(annotation.id)).length,
    ids: [...spans.map((span) => span.context.span_id), ...annotations.map((annotation) => annotation.id)],
  }
}

// --- moving to Phoenix-only ------------------------------------------------------

export type MoveResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: string }

const VERIFY_ATTEMPTS = 6
const VERIFY_DELAY_MS = 500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Why this session cannot leave the disk yet, if anything stops it. */
const blocker = (store: Store, sessionId: string): string | undefined => {
  const traces = store.listTraceIds(sessionId).map((traceId) => store.readTrace(sessionId, traceId))

  // Phoenix only receives ended spans: an unfinished turn would be lost.
  if (traces.some((trace) => trace.open.length > 0)) return "it has a turn that has not finished"

  const consumed = new Set(
    loadSession(store, sessionId).turns.map((turn) => readMetadata(turn.root).inbox_id),
  )

  if (store.listInbox(sessionId).some((entry) => !consumed.has(entry.id)))
    return "it has a queued prompt that has not run"

  return undefined
}

/** What Phoenix is still missing of this session, in words; empty when it has everything. */
const missing = async (store: Store, client: PhoenixClient, sessionId: string): Promise<Array<string>> => {
  const traceIds = store.listTraceIds(sessionId)
  const local = traceIds.flatMap((traceId) => store.readTrace(sessionId, traceId).ended)

  const [remoteSpans, remoteAnnotations] = await Promise.all([
    client.spans(traceIds),
    client.traceAnnotations(traceIds),
  ])

  const spanIds = new Set(remoteSpans.map((span) => span.context.span_id))
  const annotations = remoteAnnotations.map((remote) => annotationFromRemote(sessionId, remote))
  const annotationKeys = new Set(annotations.map((annotation) => annotation.id))

  // Annotations exported before local ids were sent are matched by trace and name.
  for (const annotation of annotations)
    annotationKeys.add(`${annotation.target.trace_id ?? ""}/${annotation.annotation.name}`)

  const absentSpans = local.filter((span) => !spanIds.has(span.context.span_id)).length

  const absentAnnotations = store
    .listAnnotations(sessionId)
    .filter(
      (annotation) =>
        !annotationKeys.has(annotation.id) &&
        !annotationKeys.has(`${annotation.target.trace_id ?? ""}/${annotation.annotation.name}`),
    ).length

  return [
    absentSpans === 0 ? "" : `${absentSpans} of ${local.length} spans`,
    absentAnnotations === 0 ? "" : `${absentAnnotations} annotations`,
  ].filter((part) => part !== "")
}

/**
 * Keep a session only in Phoenix: send whatever has not been sent, confirm
 * Phoenix holds all of it, then delete the local files. Nothing is deleted
 * unless every check passes.
 */
export const moveToPhoenix = async (
  store: Store,
  exporter: PhoenixExporter,
  client: PhoenixClient,
  sessionId: string,
): Promise<MoveResult> => {
  if (store.readHeader(sessionId) === undefined) return { ok: false, reason: "it is not on this disk" }

  const blocked = blocker(store, sessionId)

  if (blocked !== undefined) return { ok: false, reason: blocked }

  const errorsBefore = exporter.report().errors.length

  exporter.sweep(sessionId)
  await exporter.flush()

  const errors = exporter.report().errors.slice(errorsBefore)

  if (errors.length > 0) return { ok: false, reason: `sending to Phoenix failed: ${errors[0] ?? ""}` }

  // Phoenix accepts spans before it has stored them, so give it a moment to catch up.
  let absent: Array<string> = []

  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(VERIFY_DELAY_MS * attempt)

    absent = await missing(store, client, sessionId)

    if (absent.length === 0) break
  }

  if (absent.length > 0) return { ok: false, reason: `Phoenix does not have ${absent.join(" and ")} yet` }

  const bytes = store.sessionBytes(sessionId)

  keepInPhoenix(store, sessionId, exporter.target)
  store.removeSession(sessionId)

  return { ok: true, bytes }
}
