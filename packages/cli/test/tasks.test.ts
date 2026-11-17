import { type TaskState } from "@oi-agent/engine"
import { describe, expect, it } from "vite-plus/test"
import { orderTasks } from "../src/tui/tasks.ts"

const entry = (id: string, state: TaskState, created: string) => ({
  task: { id, header: { created_at: created } },
  status: { state },
})

const OLD = "2026-01-01T00:00:00.000000001Z"
const NEW = "2026-01-01T00:00:00.000000002Z"

describe("task picker ordering", () => {
  it("groups running and approval-waiting ahead of every terminal state, newest within each", () => {
    const entries = [
      entry("cancelled", "cancelled", NEW),
      entry("old-running", "running", OLD),
      entry("old-finished", "finished", OLD),
      entry("new-waiting", "waiting for approval", NEW),
      entry("failed", "failed", NEW),
      entry("new-running", "running", NEW),
    ]

    expect(orderTasks(entries).map(({ task }) => task.id)).toEqual([
      "new-running",
      "new-waiting",
      "old-running",
      "cancelled",
      "failed",
      "old-finished",
    ])
    expect(entries[0]?.task.id).toBe("cancelled")
  })

  it("uses durable creation time even when an old task has a newer runner", () => {
    const old = { ...entry("old", "running", OLD), runnerStarted: NEW }
    const fresh = { ...entry("fresh", "running", NEW), runnerStarted: OLD }

    expect(orderTasks([old, fresh]).map(({ task }) => task.id)).toEqual(["fresh", "old"])
  })

  it("breaks equal-time ties by id independently of input order", () => {
    const a = entry("a", "finished", NEW)
    const b = entry("b", "failed", NEW)

    expect(orderTasks([b, a])).toEqual([a, b])
    expect(orderTasks([a, b])).toEqual([a, b])
    expect(orderTasks([])).toEqual([])
  })
})
