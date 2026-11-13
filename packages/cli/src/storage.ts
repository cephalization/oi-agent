/**
 * Opening sessions that may be kept in Phoenix, and moving sessions between
 * this disk and Phoenix-only storage.
 *
 * The engine only ever runs a session from local span files. A session kept
 * in Phoenix is imported when it is opened and moved out again when it is
 * left, so between uses it takes no space here.
 */
import {
  forgetMarker,
  formatBytes,
  importSession,
  keepInPhoenix,
  lastWorkspace,
  listRemoteSessions,
  moveToPhoenix,
  type PhoenixClient,
  type PhoenixExporter,
  readMarker,
  type Store,
  workspaceDrift,
  workspaceOf,
} from "@oi-agent/engine"
import { fromSummary, mergeSessions, type SessionSummary, summarizeSessions } from "./sessions.ts"

/** Sessions listed from Phoenix at once. */
const REMOTE_LIMIT = 50

export interface Phoenix {
  readonly exporter: PhoenixExporter
  readonly client: PhoenixClient
}

export interface Opened {
  readonly sessionId: string
  /** Things to tell the user before the session opens. */
  readonly notes: ReadonlyArray<string>
  /** The session was written on another machine. */
  readonly foreign: boolean
}

export class Sessions {
  private readonly store: Store
  private readonly phoenix: Phoenix | undefined
  /** Phoenix's sessions, from the last listing. */
  private remote: ReadonlyArray<SessionSummary> = []

  constructor(store: Store, phoenix: Phoenix | undefined) {
    this.store = store
    this.phoenix = phoenix
  }

  get connected(): boolean {
    return this.phoenix !== undefined
  }

  /** Every session: on disk, kept in Phoenix, and (once listed) the rest of the Phoenix project. */
  all(): Array<SessionSummary> {
    return mergeSessions(summarizeSessions(this.store), this.remote)
  }

  /** Ask Phoenix for its sessions. Resolves to an error message when it cannot. */
  async refresh(): Promise<string | undefined> {
    if (this.phoenix === undefined) return undefined

    try {
      const listed = await listRemoteSessions(this.phoenix.client, REMOTE_LIMIT)

      this.remote = listed.map((summary) => fromSummary(summary, "phoenix"))

      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** A full session id, a unique prefix of one, or `undefined`. */
  resolve(idOrPrefix: string): string | undefined {
    const local = this.store.resolveSession(idOrPrefix)

    if (local !== undefined) return local

    const ids = this.all().map((session) => session.id)

    if (ids.includes(idOrPrefix)) return idOrPrefix

    const matches = ids.filter((id) => id.startsWith(idOrPrefix))

    return matches.length === 1 ? matches[0] : undefined
  }

  /**
   * Make a session runnable here: import it from Phoenix if it is not on
   * disk. A session that comes from Phoenix goes back there when it is left.
   * `identifier` may be a session id or the id in a Phoenix session URL.
   */
  async open(identifier: string): Promise<Opened> {
    const local = this.store.resolveSession(identifier)

    if (local !== undefined && this.store.readHeader(local) !== undefined)
      return { sessionId: local, notes: [], foreign: false }

    if (this.phoenix === undefined)
      throw new Error(`No session "${identifier}" on disk, and no Phoenix endpoint is configured to look in.`)

    const result = await importSession(this.store, this.phoenix.client, identifier, {
      cwd: process.cwd(),
      device: this.store.device(),
    })

    if (result === undefined) throw new Error(`Phoenix has no session "${identifier}".`)

    this.phoenix.exporter.markSent(result.ids)

    if (readMarker(this.store, result.sessionId) === undefined)
      keepInPhoenix(this.store, result.sessionId, this.phoenix.exporter.target)

    const drift = workspaceDrift(lastWorkspace(this.store, result.sessionId), workspaceOf(result.header.cwd))

    return {
      sessionId: result.sessionId,
      notes: [`Opened ${result.sessionId.slice(0, 13)} from Phoenix.`, ...drift],
      foreign: result.header.device.id !== this.store.device().id,
    }
  }

  /** After leaving a session: if it is kept in Phoenix, move it back out. Resolves to a message. */
  async putAway(sessionId: string): Promise<string | undefined> {
    if (this.phoenix === undefined || readMarker(this.store, sessionId) === undefined) return undefined

    if (this.store.readHeader(sessionId) === undefined) return undefined

    const moved = await moveToPhoenix(this.store, this.phoenix.exporter, this.phoenix.client, sessionId)

    return moved.ok
      ? `Moved back to Phoenix (${formatBytes(moved.bytes)} freed).`
      : `Kept on disk for now: ${moved.reason}.`
  }

  /** Tab in the picker: keep a session only in Phoenix, or on disk again. Resolves to a message. */
  async toggle(session: SessionSummary): Promise<string> {
    const short = session.id.slice(0, 13)

    if (this.phoenix === undefined) return "Keeping sessions in Phoenix needs a Phoenix endpoint (oi setup)."

    if (session.storage === "phoenix") {
      if (this.store.readHeader(session.id) === undefined) {
        const result = await importSession(this.store, this.phoenix.client, session.id, {
          cwd: process.cwd(),
          device: this.store.device(),
        })

        if (result === undefined) return `Phoenix no longer has ${short}.`

        this.phoenix.exporter.markSent(result.ids)
      }

      forgetMarker(this.store, session.id)
      this.remote = this.remote.filter((entry) => entry.id !== session.id)

      return `${short} is kept on disk now (${formatBytes(this.store.sessionBytes(session.id))}).`
    }

    const moved = await moveToPhoenix(this.store, this.phoenix.exporter, this.phoenix.client, session.id)

    return moved.ok
      ? `${short} is kept only in Phoenix now (${formatBytes(moved.bytes)} freed).`
      : `${short} stays on disk: ${moved.reason}.`
  }
}
