import { Option, Schema } from "effect"
import { type EndedSpan, printSpan, spanFileName } from "../format.ts"
import { isoToNs } from "../ids.ts"
import type { Store } from "../store.ts"
import { Manifest, SessionInfo, type SessionState, WireEvent } from "./protocol.ts"

export interface PeerConnection {
  /** Older hosts can sync conversation files without publishing live task status. */
  readonly statusAvailable: boolean
  readonly state: () => SessionState
  readonly info: SessionInfo
  readonly sessionId: string
  /** Submit a prompt to the host. Resolves to an error message, if any. */
  readonly prompt: (text: string, mode?: "steer" | "queue") => Promise<string | undefined>
  /** Resolves when the event stream ends. */
  readonly closed: Promise<void>
  readonly close: () => void
}

// The host sends state every 500 ms, even while idle. A tunnel can disappear
// without closing its local TCP stream; do not wait forever for an EOF.
const HOST_TIMEOUT_MS = 10_000

const decodeInfo = Schema.decodeUnknownOption(SessionInfo)
const decodeManifest = Schema.decodeUnknownOption(Manifest)
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(WireEvent))

const spanPath = (span: EndedSpan): string =>
  `traces/${span.context.trace_id}/${spanFileName(isoToNs(span.start_time), span.context.span_id)}.json`

/** Apply one event from the host to the local copy of the session. */
const apply = (store: Store, sessionId: string, event: WireEvent, spans: Map<string, WireEvent>): void => {
  if (event.type === "span_open") {
    spans.set(event.span.context.span_id, event)
    store.mirrorOpen(sessionId, event.span)
  }

  if (event.type === "delta") {
    const open = spans.get(event.span_id)

    if (open?.type === "span_open") store.mirrorDelta(sessionId, open.span, event.delta)
  }

  if (event.type === "span_end") {
    spans.delete(event.span.context.span_id)
    store.importFile(sessionId, spanPath(event.span), printSpan(event.span))
  }

  if (event.type === "annotation") {
    store.importFile(
      sessionId,
      `annotations/${event.annotation.id}.json`,
      JSON.stringify(event.annotation, null, 2),
    )
  }

  if (event.type === "inbox") {
    store.importFile(sessionId, `inbox/${event.entry.id}.json`, JSON.stringify(event.entry, null, 2))
  }
}

/**
 * Join a shared session: copy what the host has, then follow it live. The
 * result is a full local copy of the session that keeps itself up to date.
 */
export const joinSession = async (
  store: Store,
  baseUrl: string,
  token: string,
  user: string,
  hostTimeoutMs: number = HOST_TIMEOUT_MS,
): Promise<PeerConnection> => {
  const controller = new AbortController()
  const headers = { authorization: `Bearer ${token}`, "x-oi-user": user }

  const get = (route: string): Promise<Response> =>
    fetch(`${baseUrl}${route}`, { headers, signal: controller.signal })

  const infoResponse = await get("/v1/session")

  if (!infoResponse.ok) throw new Error(`The host refused the connection (HTTP ${infoResponse.status}).`)

  const info = Option.getOrUndefined(decodeInfo(await infoResponse.json().catch(() => undefined)))

  if (info === undefined)
    throw new Error(
      "The host returned an invalid session description. Update and restart the host, then rejoin.",
    )

  const sessionId = info.header.id
  // Follow events before copying files, so nothing that ends in between is missed.
  const events = await fetch(`${baseUrl}/v1/events`, { headers, signal: controller.signal })

  if (!events.ok) {
    controller.abort()

    throw new Error(`The host refused the event stream (HTTP ${events.status}).`)
  }

  const manifestResponse = await get("/v1/manifest")
  const manifest = Option.getOrUndefined(decodeManifest(await manifestResponse.json().catch(() => undefined)))

  if (!manifestResponse.ok || manifest === undefined) {
    controller.abort()

    throw new Error(
      `The host returned an invalid session manifest (HTTP ${manifestResponse.status}). Update and restart the host, then rejoin.`,
    )
  }

  let state: SessionState = manifest.state ?? {
    busy: false,
    steerable: false,
    waiting: [],
    held: 0,
    work: [],
  }

  const have = new Set(store.manifest(sessionId))
  const open = new Map<string, WireEvent>()

  for (const rel of manifest.paths) {
    if (have.has(rel)) continue

    const file = await get(`/v1/file?path=${encodeURIComponent(rel)}`)

    if (file.ok) store.importFile(sessionId, rel, await file.text())
  }

  for (const entry of manifest.open) {
    open.set(entry.span.context.span_id, { type: "span_open", session_id: sessionId, span: entry.span })
    store.mirrorOpen(sessionId, entry.span)

    for (const delta of entry.deltas) store.mirrorDelta(sessionId, entry.span, delta)
  }

  const pump = async (): Promise<void> => {
    const decoder = new TextDecoder()
    let buffer = ""

    if (events.body === null) return

    const reader = events.body.getReader()

    const cancel = (): void => {
      void reader.cancel().catch(() => undefined)
    }

    // Only a host that publishes status is known to send something every 500 ms.
    // An older host is silent while idle, so silence says nothing about it.
    const watch = (): NodeJS.Timeout | undefined =>
      manifest.state === undefined ? undefined : setTimeout(() => controller.abort(), hostTimeoutMs)

    let timeout = watch()

    controller.signal.addEventListener("abort", cancel, { once: true })

    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()

        if (done) break

        clearTimeout(timeout)
        timeout = watch()
        buffer += decoder.decode(value, { stream: true })

        const frames = buffer.split("\n\n")

        buffer = frames.pop() ?? ""

        for (const frame of frames) {
          const event = frame.startsWith("data: ")
            ? Option.getOrUndefined(decodeEvent(frame.slice(6)))
            : undefined

          if (event?.type === "state") state = event.state
          else if (event !== undefined) apply(store, sessionId, event, open)
        }
      }
    } catch {
      // The stream was closed, by us or by the host.
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener("abort", cancel)
      reader.releaseLock()
      // Cancel pending prompt requests too: they must not outlive the stream.
      controller.abort()
    }
  }

  return {
    statusAvailable: manifest.state !== undefined,
    state: () => state,
    info,
    sessionId,
    closed: pump(),
    close: () => controller.abort(),
    prompt: async (text, mode = "steer") => {
      try {
        const response = await fetch(`${baseUrl}/v1/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ text, mode }),
          signal: controller.signal,
        })

        return response.ok ? undefined : `The host rejected the prompt (HTTP ${response.status}).`
      } catch {
        controller.abort()

        return "Host disconnected. Left the joined chat."
      }
    },
  }
}
