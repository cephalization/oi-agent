import { randomBytes, randomUUID } from "node:crypto"

/**
 * Trace ids are 16 bytes: a 6-byte millisecond timestamp followed by 10 random
 * bytes. They are valid W3C trace ids and sort by creation time, so a plain
 * directory listing shows turns in order without sequence numbers.
 */
export const newTraceId = (nowMs: number = Date.now()): string => {
  const time = Buffer.alloc(6)
  time.writeUIntBE(nowMs, 0, 6)

  return Buffer.concat([time, randomBytes(10)]).toString("hex")
}

export const newSpanId = (): string => randomBytes(8).toString("hex")

/** Session ids use the same time-prefixed scheme, formatted as a UUID. */
export const newSessionId = (nowMs: number = Date.now()): string => {
  const hex = newTraceId(nowMs)

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${(
    (parseInt(hex.slice(16, 18), 16) & 0x3f) |
    0x80
  ).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

export const newId = (): string => randomUUID()

let lastNs = 0n

/** Wall-clock nanoseconds, strictly increasing within a process. */
export const nowNs = (): bigint => {
  const wall = BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor((performance.now() % 1) * 1_000_000))
  lastNs = wall > lastNs ? wall : lastNs + 1n

  return lastNs
}

/** `2026-11-12T10:00:00.123456789Z`: ISO 8601 with nanosecond precision. */
export const nsToIso = (ns: bigint): string => {
  const ms = Number(ns / 1_000_000n)
  const rem = (ns % 1_000_000n).toString().padStart(6, "0")

  return new Date(ms).toISOString().replace("Z", `${rem}Z`)
}

export const isoToNs = (iso: string): bigint => {
  const m = /^(.*?)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(iso)

  if (!m) throw new Error(`invalid timestamp: ${iso}`)
  const ms = Date.parse(`${m[1]}${m[3]}`)

  if (Number.isNaN(ms)) throw new Error(`invalid timestamp: ${iso}`)

  return BigInt(ms) * 1_000_000n + BigInt((m[2] ?? "").padEnd(9, "0"))
}
