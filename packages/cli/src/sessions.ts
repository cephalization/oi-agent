/** Session summaries for `oi sessions` and the `/resume` picker. */
import { loadSession, type Store } from "@oi-agent/engine"

export interface SessionSummary {
  readonly id: string
  readonly cwd: string
  readonly turns: number
  /** The first line of the first prompt. */
  readonly title: string
  /** When the latest turn started, or the session was created if it has none. */
  readonly activeMs: number
}

const timeOf = (iso: string | undefined): number => {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso)

  return Number.isFinite(ms) ? ms : 0
}

/** Every session, most recently active first. */
export const summarizeSessions = (store: Store): Array<SessionSummary> =>
  store
    .listSessionIds()
    .map((id) => {
      const view = loadSession(store, id)

      return {
        id,
        cwd: view.header?.cwd ?? "",
        turns: view.turns.length,
        title: view.turns[0]?.input.split("\n")[0]?.trim() ?? "",
        activeMs: timeOf(view.turns.at(-1)?.root.start_time ?? view.header?.created_at),
      }
    })
    .toSorted((a, b) => b.activeMs - a.activeMs)

/** "just now", "5m ago", "3h ago", "2d ago", or a date for anything older than a month. */
export const ago = (ms: number, nowMs: number = Date.now()): string => {
  const minutes = Math.floor((nowMs - ms) / 60_000)

  if (minutes < 1) return "just now"

  if (minutes < 60) return `${minutes}m ago`

  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`

  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / (60 * 24))}d ago`

  return new Date(ms).toISOString().slice(0, 10)
}
