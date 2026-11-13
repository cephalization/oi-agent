/** Session summaries for `oi sessions` and the `/resume` picker. */
import {
  listMarkers,
  readMarker,
  type SessionSummary as Summary,
  type Store,
  summarizeSession,
} from "@oi-agent/engine"

/** Where a session's files are kept between uses. */
export type Storage = "local" | "phoenix"

export interface SessionSummary {
  readonly id: string
  readonly cwd: string
  readonly turns: number
  /** The first line of the first prompt. */
  readonly title: string
  /** When the latest turn started, or the session was created if it has none. */
  readonly activeMs: number
  readonly storage: Storage
}

const timeOf = (iso: string | undefined): number => {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso)

  return Number.isFinite(ms) ? ms : 0
}

export const fromSummary = (summary: Summary, storage: Storage): SessionSummary => ({
  id: summary.id,
  cwd: summary.cwd,
  turns: summary.turns,
  title: summary.title,
  activeMs: timeOf(summary.active_at),
  storage,
})

/** The first summary of each session wins, so pass the most authoritative list first. */
export const mergeSessions = (
  ...lists: ReadonlyArray<ReadonlyArray<SessionSummary>>
): Array<SessionSummary> => {
  const byId = new Map<string, SessionSummary>()

  for (const session of lists.flat()) if (!byId.has(session.id)) byId.set(session.id, session)

  return [...byId.values()].toSorted((a, b) => b.activeMs - a.activeMs)
}

/**
 * Every session this machine knows without asking Phoenix: the ones on disk,
 * and the ones moved to Phoenix-only storage. Most recently active first.
 */
export const summarizeSessions = (store: Store): Array<SessionSummary> =>
  mergeSessions(
    store
      .listSessionIds()
      .map((id) =>
        fromSummary(summarizeSession(store, id), readMarker(store, id) === undefined ? "local" : "phoenix"),
      ),
    listMarkers(store).map((marker) => fromSummary(marker.summary, "phoenix")),
  )

/** "just now", "5m ago", "3h ago", "2d ago", or a date for anything older than a month. */
export const ago = (ms: number, nowMs: number = Date.now()): string => {
  const minutes = Math.floor((nowMs - ms) / 60_000)

  if (minutes < 1) return "just now"

  if (minutes < 60) return `${minutes}m ago`

  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`

  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / (60 * 24))}d ago`

  return new Date(ms).toISOString().slice(0, 10)
}
