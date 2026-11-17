import { isoToNs, type TaskState } from "@oi-agent/engine"

/** A snapshot: status is read once before ordering, not during comparisons. */
interface TaskOrderEntry {
  readonly task: { readonly id: string; readonly header: { readonly created_at: string } }
  readonly status: { readonly state: TaskState }
}

const active = (state: TaskState): boolean => state === "running" || state === "waiting for approval"

/** Active first, then creation (not the latest runner/follow-up), then task id. */
export const orderTasks = <A extends TaskOrderEntry>(entries: ReadonlyArray<A>): Array<A> =>
  entries.toSorted((left, right) => {
    const group = Number(active(right.status.state)) - Number(active(left.status.state))

    if (group !== 0) return group

    const a = isoToNs(left.task.header.created_at)
    const b = isoToNs(right.task.header.created_at)

    if (a !== b) return a > b ? -1 : 1

    return left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0
  })
