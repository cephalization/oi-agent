/**
 * The tools a session delegates with. A subagent's own session does not get
 * them: tasks do not start tasks.
 */
import { Effect, Schema } from "effect"
import type { Task, Tasks } from "./tasks.ts"
import { defineTool, failed, ok, type ToolContext, type ToolOutcome, type ToolSpec } from "./tools.ts"

/** How much of a task's last output a status report quotes. */
const OUTPUT_CHARS = 2000

const delegator = (context: ToolContext) => ({
  sessionId: context.sessionId,
  cwd: context.cwd,
  userId: context.userId,
  span: context.span,
})

const unknownTask = (id: string): ToolOutcome =>
  failed(`No task ${id} was delegated from this session. Call task_status without an id to list them.`)

const line = (tasks: Tasks, task: Task): string => {
  const status = tasks.status(task)

  const where =
    task.task.worktree === undefined
      ? task.header.cwd
      : `${task.task.worktree.path} (${task.task.worktree.branch})`

  return `${task.id}  "${task.task.title}"  ${tasks.describe(status)}  in ${where}`
}

const withTask = (
  context: ToolContext,
  id: string,
  body: (task: Task) => ToolOutcome,
): Effect.Effect<ToolOutcome> =>
  Effect.sync(() => {
    const task = context.tasks.find(context.sessionId, id)

    return task === undefined ? unknownTask(id) : body(task)
  })

const delegate = defineTool({
  name: "delegate",
  description:
    'Hand a piece of work to a subagent: another oi agent with its own conversation and the same tools, which works on its own while you stay free. It sees nothing of this conversation, so the prompt must stand alone: the goal, the context it needs (paths, decisions already made, what was tried), what done means, and what to report back. Returns at once with a task id; the result is delivered to you when the task finishes. isolation "worktree" gives it its own git worktree and branch, starting from the current commit (uncommitted changes are not in it): use that for anything that changes files, so parallel tasks and this checkout never collide. Use "shared" only for work that reads.',
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words naming the task, for status lists and its branch." },
      prompt: { type: "string", description: "The whole brief. The subagent knows nothing else." },
      isolation: {
        type: "string",
        enum: ["worktree", "shared"],
        description: "worktree: its own checkout and branch. shared: this directory, for read-only work.",
      },
      model: {
        type: "string",
        enum: ["default", "cheap"],
        description:
          "default: the model you are running on, for design, debugging and anything subtle. cheap: the configured cheap model, for mechanical work such as running a suite and reporting, or a rote edit. Defaults to default.",
      },
    },
    required: ["title", "prompt", "isolation"],
    additionalProperties: false,
  },
  // It starts an agent, and every tool call that agent makes goes through approval itself.
  mutates: false,
  input: Schema.Struct({
    title: Schema.String,
    prompt: Schema.String,
    isolation: Schema.Literals(["worktree", "shared"]),
    model: Schema.optionalKey(Schema.Literals(["default", "cheap"])),
  }),
  run: (input, context) =>
    Effect.sync(() => {
      const models = context.models()
      const model = input.model === "cheap" && models.cheap !== "" ? models.cheap : models.default

      try {
        const task = context.tasks.delegate(delegator(context), { ...input, model })
        const worktree = task.task.worktree

        return {
          ...ok(
            [
              `Started task ${task.id} "${task.task.title}" on ${model}, in session ${task.header.id}.`,
              worktree === undefined
                ? `It works in this directory (${task.header.cwd}).`
                : `It works in its own worktree, ${worktree.path}, on branch ${worktree.branch}. Leave that directory to it.`,
              "Its result will be delivered to you when it finishes: do not wait or poll. task_status shows progress, task_message sends it more, task_cancel stops it.",
            ].join("\n"),
          ),
          task: { id: task.id, session_id: task.header.id },
        }
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error))
      }
    }),
})

const taskStatus = defineTool({
  name: "task_status",
  description:
    "Check on delegated tasks: one task's state, what it is doing now and its latest report, or a list of every task this session delegated when no id is given. A finished task's result is delivered to you without asking, so call this only to look at progress or to see where each task is working.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The task id. Omit to list every task." } },
    additionalProperties: false,
  },
  mutates: false,
  input: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
  run: (input, context) => {
    const { id } = input

    if (id === undefined)
      return Effect.sync(() => {
        const lines = context.tasks.list(context.sessionId).map((task) => line(context.tasks, task))

        return ok(lines.length === 0 ? "No tasks have been delegated from this session." : lines.join("\n"))
      })

    return withTask(context, id, (task) => {
      const status = context.tasks.status(task)
      const output = status.output ?? ""

      return ok(
        [
          line(context.tasks, task),
          `session: ${task.header.id}, ${status.turns} turn${status.turns === 1 ? "" : "s"}, on ${task.task.model}`,
          output === "" ? "(no report yet)" : `--- its latest report ---\n${output.slice(-OUTPUT_CHARS)}`,
        ].join("\n"),
      )
    })
  },
})

const taskMessage = defineTool({
  name: "task_message",
  description:
    "Send a delegated task a follow-up: a correction, an answer to its question, or more work in the same context. A running task reads it when its current turn ends; a finished one wakes up for it, remembering everything it did. Its next result is delivered to you as before.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The task id." },
      text: { type: "string", description: "What to tell it. It still sees nothing of this conversation." },
    },
    required: ["id", "text"],
    additionalProperties: false,
  },
  mutates: false,
  input: Schema.Struct({ id: Schema.String, text: Schema.String }),
  run: (input, context) =>
    withTask(context, input.id, (task) => {
      const started = context.tasks.message(delegator(context), task, input.text)

      return {
        ...ok(`Sent to task ${task.id}.`),
        task: { id: task.id, session_id: task.header.id, started_runner: started },
      }
    }),
})

const taskCancel = defineTool({
  name: "task_cancel",
  description:
    "Stop a delegated task and the commands it left running. Its conversation, and its worktree and branch if it has them, stay: task_message afterwards restarts it with new instructions and everything it had learned.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The task id." } },
    required: ["id"],
    additionalProperties: false,
  },
  mutates: false,
  input: Schema.Struct({ id: Schema.String }),
  run: (input, context) =>
    withTask(context, input.id, (task) => {
      const running = context.jobs.state(task.job).state === "running"

      context.tasks.cancel(task)

      const status = context.tasks.status(task)

      // A task that had already ended has a report nobody has read yet: this call is what reads it.
      const report = running
        ? `Stopped task ${task.id}. ${line(context.tasks, task)}`
        : `Task ${task.id} had already ended, so nothing was stopped.\n${context.tasks.report(task, status)}`

      context.complete({ ...context.tasks.delivery(task, status), inbox_id: `job-${task.job.id}` }, report)
      context.jobs.claim(task.job)

      return ok(report)
    }),
})

export const taskTools: ReadonlyArray<ToolSpec> = [delegate, taskStatus, taskMessage, taskCancel]
