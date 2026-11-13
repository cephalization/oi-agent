import { Option, Schema } from "effect"
import { type EndedSpan, printSpan, spanFileName } from "../format.ts"
import { isoToNs } from "../ids.ts"
import type { Store } from "../store.ts"
import { Manifest, SessionInfo, WireEvent } from "./protocol.ts"

export interface PeerConnection {
  readonly info: SessionInfo
  readonly sessionId: string
  /** Submit a prompt to the host. Resolves to an error message, if any. */
  readonly prompt: (text: string) => Promise<string | undefined>
  /** Resolves when the event stream ends. */
  readonly closed: Promise<void>
  readonly close: () => void
}

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
): Promise<PeerConnection> => {
  const headers = { authorization: `Bearer ${token}`, "x-oi-user": user }
  const get = (route: string): Promise<Response> => fetch(`${baseUrl}${route}`, { headers })
  const infoResponse = await get("/v1/session")

  if (!infoResponse.ok) throw new Error(`The host refused the connection (HTTP ${infoResponse.status}).`)

  const info = Option.getOrThrow(decodeInfo(await infoResponse.json()))
  const sessionId = info.header.id
  const controller = new AbortController()
  // Follow events before copying files, so nothing that ends in between is missed.
  const events = await fetch(`${baseUrl}/v1/events`, { headers, signal: controller.signal })
  const manifest = Option.getOrThrow(decodeManifest(await (await get("/v1/manifest")).json()))
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

    try {
      for await (const chunk of events.body) {
        buffer += decoder.decode(chunk, { stream: true })

        const frames = buffer.split("\n\n")

        buffer = frames.pop() ?? ""

        for (const frame of frames) {
          const event = frame.startsWith("data: ")
            ? Option.getOrUndefined(decodeEvent(frame.slice(6)))
            : undefined

          if (event !== undefined) apply(store, sessionId, event, open)
        }
      }
    } catch {
      // The stream was closed, by us or by the host.
    }
  }

  return {
    info,
    sessionId,
    closed: pump(),
    close: () => controller.abort(),
    prompt: async (text) => {
      const response = await fetch(`${baseUrl}/v1/prompt`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      })

      return response.ok ? undefined : `The host rejected the prompt (HTTP ${response.status}).`
    },
  }
}
