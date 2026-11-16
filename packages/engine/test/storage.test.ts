import * as fs from "node:fs"
import { describe, expect, it, vi } from "vite-plus/test"
import { PhoenixExporter } from "../src/export/phoenix.ts"
import { pendingInbox } from "../src/fold.ts"
import { jobsOf } from "../src/jobs.ts"
import { PhoenixClient } from "../src/remote/phoenix.ts"
import { moveToPhoenix, readMarker } from "../src/remote/storage.ts"
import { tempStore } from "./helpers.ts"

const setup = () => {
  const store = tempStore()
  const session = store.createSession(store.home)
  const target = { endpoint: "http://unused.invalid", project: "test" }
  const exporter = new PhoenixExporter(store, target)
  const client = new PhoenixClient(target)

  vi.spyOn(exporter, "sweep").mockImplementation(() => undefined)
  const flush = vi.spyOn(exporter, "flush").mockResolvedValue(undefined)
  const remoteSpans = vi.spyOn(client, "spans").mockResolvedValue([])
  vi.spyOn(client, "traceAnnotations").mockResolvedValue([])

  const jobs = jobsOf(store)

  const start = (sessionId: string = session.id, task?: { id: string; session_id: string }) => {
    const job = jobs.start({
      sessionId,
      cwd: store.home,
      command: "sleep 30",
      tool: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
      task,
    })

    jobs.toBackground(job, "requested")

    return job
  }

  return {
    store,
    session,
    exporter,
    client,
    jobs,
    start,
    flush,
    remoteSpans,
    move: () => moveToPhoenix(store, exporter, client, session.id),
  }
}

describe("Phoenix eviction with background work", () => {
  it("blocks a running background job even without an open span or inbox entry", async () => {
    const s = setup()
    const job = s.start()

    try {
      expect(await s.move()).toMatchObject({ ok: false, reason: expect.stringContaining("background") })
      expect(s.flush).not.toHaveBeenCalled()
      expect(s.store.readHeader(s.session.id)).toBeDefined()
      expect(readMarker(s.store, s.session.id)).toBeUndefined()
    } finally {
      s.jobs.kill(job)
      await s.jobs.ended(job)
    }
  })

  it("blocks an ended but unreported job until its result is accounted for", async () => {
    const s = setup()
    const job = s.start()

    s.jobs.kill(job)
    await s.jobs.ended(job)
    expect(await s.move()).toMatchObject({ ok: false })
    s.jobs.claim(job)
    expect(await s.move()).toMatchObject({ ok: true })
  })

  it("blocks eviction of a task session while its runner belongs to its parent", async () => {
    const s = setup()
    const parent = s.store.createSession(s.store.home)

    const child = s.store.createSession(s.store.home, undefined, {
      parent: { session_id: parent.id, trace_id: "a".repeat(32), span_id: "b".repeat(16) },
      task: { id: "task", title: "task", isolation: "shared", model: "scripted/scripted" },
    })

    const job = s.start(parent.id, { id: "task", session_id: child.id })

    try {
      expect(await moveToPhoenix(s.store, s.exporter, s.client, parent.id)).toMatchObject({ ok: false })
      expect(await moveToPhoenix(s.store, s.exporter, s.client, child.id)).toMatchObject({ ok: false })
      s.jobs.kill(job)
      await s.jobs.ended(job)
      expect(await moveToPhoenix(s.store, s.exporter, s.client, child.id)).toMatchObject({ ok: false })
      s.jobs.claim(job)
      expect(await moveToPhoenix(s.store, s.exporter, s.client, child.id)).toMatchObject({ ok: true })
    } finally {
      s.jobs.kill(job)
      await s.jobs.ended(job)
    }
  })

  it("rechecks after flush so a claimed result written to the inbox is not deleted", async () => {
    const s = setup()

    s.flush.mockImplementation(async () => {
      const job = s.start()

      s.jobs.kill(job)
      await s.jobs.ended(job)
      s.jobs.claim(job)
      s.store.writeInbox(s.session.id, { user_id: "oi", text: "background result" })
    })

    expect(await s.move()).toMatchObject({ ok: false })
    expect(pendingInbox(s.store, s.session.id)).toHaveLength(1)
    expect(fs.existsSync(s.store.sessionDir(s.session.id))).toBe(true)
    expect(readMarker(s.store, s.session.id)).toBeUndefined()
  })

  it("rechecks background work started during remote verification", async () => {
    const s = setup()
    let job: ReturnType<typeof s.start> | undefined

    s.remoteSpans.mockImplementation(async () => {
      job = s.start()

      return []
    })

    try {
      expect(await s.move()).toMatchObject({ ok: false })
      expect(s.store.readHeader(s.session.id)).toBeDefined()
    } finally {
      if (job !== undefined) {
        s.jobs.kill(job)
        await s.jobs.ended(job)
      }
    }
  })
})
