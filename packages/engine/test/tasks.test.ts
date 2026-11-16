import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { loadConfig } from "../src/config.ts"
import { Engine } from "../src/engine.ts"
import { linksOf } from "../src/export/otlp.ts"
import { pendingInbox } from "../src/fold.ts"
import { type EndedSpan, type EngineMetadata, kindOf, OI, writeMetadata } from "../src/format.ts"
import { jobsOf } from "../src/jobs.ts"
import { scriptedModel } from "../src/model.ts"
import { Store, type StoreEvent } from "../src/store.ts"
import { taskTools } from "../src/task-tools.ts"
import { ApprovalDesk, type Delegator, Tasks } from "../src/tasks.ts"
import { MODELS, tempStore } from "./helpers.ts"

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000

  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A git checkout with one commit. */
const checkout = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-repo-")))

  const git = (...args: ReadonlyArray<string>): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })

  git("init", "-q")
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n")
  git("add", ".")
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first")

  return dir
}

/** Tasks whose "subagent" is a shell command, so nothing here needs a model. */
const setup = (runner: string, limit?: number) => {
  const store = tempStore()
  const jobs = jobsOf(store)
  const tasks = new Tasks(store, jobs, { runner: () => runner, limit })
  const cwd = checkout()
  const parent = store.createSession(cwd)

  const from: Delegator = {
    sessionId: parent.id,
    cwd,
    userId: "tony",
    span: { trace_id: "a".repeat(32), span_id: "b".repeat(16) },
  }

  return { store, jobs, tasks, cwd, parent, from }
}

const BRIEF = { title: "Fix the thing!", prompt: "Do it.", model: "scripted/scripted" }

describe("tasks", () => {
  it("a delegated task is a session that names its delegator, with the brief in its inbox", () => {
    const s = setup("sleep 30")
    const task = s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" })
    const origin = { session_id: s.parent.id, ...s.from.span }

    expect(s.store.readHeader(task.header.id)).toMatchObject({
      cwd: s.cwd,
      parent: origin,
      task: { id: task.id, title: "Fix the thing!", isolation: "shared", model: "scripted/scripted" },
    })
    expect(pendingInbox(s.store, task.header.id)).toMatchObject([{ user_id: "tony", text: "Do it.", origin }])
    expect(task.job.task).toEqual({ id: task.id, session_id: task.header.id })
    expect(s.tasks.list(s.parent.id).map((entry) => entry.id)).toEqual([task.id])
    expect(s.tasks.status(task).state).toBe("running")

    s.tasks.cancel(task)
    expect(s.tasks.status(task).state).toBe("cancelled")
  })

  it("an unchanged worktree and branch survive completion so a task message can resume", async () => {
    const s = setup("true")
    const task = s.tasks.delegate(s.from, { ...BRIEF, isolation: "worktree" })
    const worktree = task.task.worktree!

    expect(worktree.path).toBe(path.join(s.store.home, "worktrees", task.id))
    expect(worktree.branch).toBe(`oi/fix-the-thing-${task.id}`)
    expect(task.header.cwd).toBe(worktree.path)
    expect(fs.existsSync(path.join(worktree.path, "README.md"))).toBe(true)

    await s.jobs.ended(task.job)

    const status = s.tasks.status(task)

    s.tasks.tidy(task)

    // The runner left without a turn: that is a failure, and the report says where to look.
    expect(status.state).toBe("failed")
    expect(s.tasks.report(task, status)).toContain("It left no report")
    expect(s.tasks.report(task, status)).toContain(`worktree: ${worktree.path}`)
    expect(fs.existsSync(worktree.path)).toBe(true)
    expect(
      execFileSync("git", ["-C", s.cwd, "branch", "--list", worktree.branch], { encoding: "utf8" }),
    ).toContain(worktree.branch)

    s.tasks.message(s.from, task, "Resume in the same checkout.")

    const again = s.tasks.find(s.parent.id, task.id)!

    expect(again.runners).toHaveLength(2)
    expect(again.job.cwd).toBe(task.header.cwd)
    await expect(s.jobs.ended(again.job)).resolves.toMatchObject({ state: "exited", code: 0 })
  })

  it("a worktree with work in it is kept and described", async () => {
    const s = setup("echo more > NEW.md")
    const task = s.tasks.delegate(s.from, { ...BRIEF, isolation: "worktree" })

    await s.jobs.ended(task.job)

    const report = s.tasks.report(task, s.tasks.status(task))

    expect(report).toContain(`worktree: ${task.task.worktree?.path}`)
    expect(report).toContain("0 commits since")
    expect(report).toContain("plus uncommitted changes")
    expect(fs.existsSync(path.join(task.task.worktree?.path ?? "", "NEW.md"))).toBe(true)
  })

  it("refuses a worktree outside a git checkout, and more tasks than the limit", () => {
    const s = setup("sleep 30", 1)

    expect(() =>
      s.tasks.delegate({ ...s.from, cwd: os.tmpdir() }, { ...BRIEF, isolation: "worktree" }),
    ).toThrow(/not a git checkout/)

    const first = s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" })

    expect(() => s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" })).toThrow(/limit/)
    s.tasks.cancel(first)
    expect(s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" }).id).not.toBe(first.id)
    s.jobs.killAll(s.parent.id)
  })

  it("a message to a task whose runner has left starts another on the same session", async () => {
    const s = setup("true")
    const task = s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" })

    await s.jobs.ended(task.job)
    const followup = { ...s.from, span: { trace_id: "c".repeat(32), span_id: "d".repeat(16) } }
    expect(s.tasks.message(followup, task, "One more thing.")).toBe(true)

    const again = s.tasks.find(s.parent.id, task.id)!

    expect(again.runners).toHaveLength(2)
    expect(again.job.tool).toEqual(followup.span)
    expect(again.header.id).toBe(task.header.id)
    expect(pendingInbox(s.store, task.header.id).map((entry) => entry.text)).toEqual([
      "Do it.",
      "One more thing.",
    ])
    await s.jobs.ended(again.job)
  })

  it("task_message marks a newly started runner and task_cancel records its terminal observation before claiming", async () => {
    const s = setup("true")
    const task = s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" })
    await s.jobs.ended(task.job)
    const message = taskTools.find((tool) => tool.name === "task_message")!
    const cancel = taskTools.find((tool) => tool.name === "task_cancel")!
    const observed: Array<string> = []

    const context = {
      cwd: s.cwd,
      emit: () => undefined,
      sessionId: s.parent.id,
      span: { trace_id: "e".repeat(32), span_id: "f".repeat(16) },
      jobs: s.jobs,
      tasks: s.tasks,
      userId: "tony",
      models: MODELS,
      complete: (delivery: NonNullable<EngineMetadata["delivers"]>[number], text: string) => {
        expect(s.jobs.isReported(s.tasks.find(s.parent.id, task.id)!.job)).toBe(false)
        s.store.writeInbox(s.parent.id, { user_id: "oi", text, delivers: delivery }, delivery.inbox_id)
        observed.push(delivery.span_id)
      },
    }

    const result = await Effect.runPromise(
      message.run({ id: task.id, text: "Run verification again." }, context),
    )

    expect(result.task?.started_runner).toBe(true)
    const again = s.tasks.find(s.parent.id, task.id)!
    expect(again.job.tool).toEqual(context.span)
    await Effect.runPromise(cancel.run({ id: task.id }, context))
    expect(observed).toEqual([context.span.span_id])
    expect(s.jobs.isReported(again.job)).toBe(true)
    expect(s.store.listInbox(s.parent.id)).toHaveLength(1)
    await s.jobs.ended(again.job)
  })

  it("the job tools leave a task's runner to the task tools", async () => {
    const s = setup("sleep 30")
    const task = s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" })

    const engine = new Engine({
      store: s.store,
      config: loadConfig({ OI_AGENT_CONFIG_DIR: `${s.store.home}/config`, OI_AGENT_HOME: s.store.home }),
      approvals: "allow",
      model: scriptedModel((call) =>
        JSON.stringify(call.messages).includes("tool_result")
          ? { model: "scripted", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }
          : {
              model: "scripted",
              content: [{ type: "tool_use", id: "c1", name: "job_kill", input: { id: task.job.id } }],
              stop_reason: "tool_use",
            },
      ),
    })

    await engine.submit(s.parent.id, { text: "kill it", userId: "tony" })

    const tool = s.store
      .listTraceIds(s.parent.id)
      .flatMap((id) => s.store.readTrace(s.parent.id, id).ended)
      .find((span) => kindOf(span) === "TOOL")

    expect(tool?.attributes[OI.OUTPUT_VALUE]).toContain("No background job")
    expect(s.jobs.state(task.job).state).toBe("running")
    s.tasks.cancel(task)
    engine.close()
  })
})

describe("a task's approval request, relayed to its delegator", () => {
  it("reaches whoever listens, including a listener that arrives later, until it is answered", async () => {
    const s = setup("sleep 30")
    const task = s.tasks.delegate(s.from, { ...BRIEF, isolation: "shared" })

    const engine = new Engine({
      store: s.store,
      config: loadConfig({ OI_AGENT_CONFIG_DIR: `${s.store.home}/config`, OI_AGENT_HOME: s.store.home }),
      approvals: "ask",
      model: scriptedModel(() => ({ model: "scripted", content: [], stop_reason: "end_turn" })),
      runner: () => "sleep 30",
    })

    const request = {
      tool: "bash",
      input: { command: "rm x" },
      trace_id: "t",
      span_id: "s9",
      user_id: "tony",
      prompt: "do it",
      cwd: "/tmp",
    }

    // The task's own process asks; this engine attends the session that delegated it.
    const asked = engine.tasks.approvals.ask(task.header.id, request, new AbortController().signal)
    const first: Array<string> = []
    const later: Array<string> = []
    const stop = engine.onApproval((relayed) => first.push(relayed.reason ?? ""))

    engine.attend(s.parent.id)
    await until(() => first.length === 1)
    expect(first).toEqual([`task ${task.id} "Fix the thing!"`])

    // The terminal that showed it went elsewhere; the next one is told too.
    stop()
    engine.onApproval((relayed) => later.push(relayed.span_id))
    expect(later).toEqual(["s9"])

    expect(engine.resolveApproval("s9", "allow")).toBe(true)
    expect(await asked).toBe("allow")

    engine.onApproval((relayed) => later.push(`again ${relayed.span_id}`))
    expect(later).toEqual(["s9"])
    s.tasks.cancel(engine.tasks.find(s.parent.id, task.id)!)
    engine.close()
  })
})

describe("approvals across processes", () => {
  const request = {
    tool: "bash",
    input: { command: "rm x" },
    trace_id: "t",
    span_id: "s1",
    user_id: "tony",
    prompt: "do it",
    cwd: "/tmp",
  }

  it("a request waits as a file until someone answers it", async () => {
    const desk = new ApprovalDesk(tempStore())
    const asked = desk.ask("child", request, new AbortController().signal)

    await until(() => desk.waiting("child").length === 1)
    expect(desk.waiting("child")).toEqual([request])
    expect(desk.waiting("other")).toEqual([])

    desk.answer("child", "s1", "allow")
    expect(desk.waiting("child")).toEqual([])
    expect(await asked).toBe("allow")
  })

  it("a request nobody answers is denied when the asking turn is interrupted", async () => {
    const desk = new ApprovalDesk(tempStore())
    const abort = new AbortController()
    const asked = desk.ask("child", request, abort.signal)

    abort.abort()
    expect(await asked).toBe("deny")
    expect(desk.waiting("child")).toEqual([])
  })
})

describe("following a session another process writes", () => {
  it("emits what the writer would have emitted, from the files alone", async () => {
    const writer = tempStore()
    const session = writer.createSession(os.tmpdir())
    const reader = new Store(writer.home)
    const seen: Array<StoreEvent> = []

    const engine = new Engine({
      store: writer,
      config: loadConfig({ OI_AGENT_CONFIG_DIR: `${writer.home}/config`, OI_AGENT_HOME: writer.home }),
      approvals: "allow",
      tools: [],
      model: scriptedModel(
        () => ({ model: "scripted", content: [{ type: "text", text: "pong" }], stop_reason: "end_turn" }),
        300,
      ),
    })

    // History is not news: a turn that ended before following began is not emitted.
    await engine.submit(session.id, { text: "first", userId: "tony" })
    reader.subscribe((event) => seen.push(event))

    const stop = reader.follow(session.id, 20)
    const turn = engine.submit(session.id, { text: "second", userId: "tony" })

    await turn
    await until(() => seen.some((event) => event.type === "span_end" && event.span.parent_id === null))
    stop()

    const kinds = seen.map((event) =>
      event.type === "span_open" || event.type === "span_end"
        ? `${event.type}:${kindOf(event.span)}`
        : event.type,
    )

    expect(kinds.filter((kind) => kind.startsWith("span"))).toEqual([
      "span_open:AGENT",
      "span_open:LLM",
      "span_end:LLM",
      "span_end:AGENT",
    ])
    expect(seen.every((event) => event.session_id === session.id)).toBe(true)
    engine.close()
  })
})

describe("span links on export", () => {
  const span = (metadata: Parameters<typeof writeMetadata>[1]): EndedSpan => ({
    name: "turn",
    context: { trace_id: "1".repeat(32), span_id: "2".repeat(16) },
    span_kind: "SPAN_KIND_INTERNAL",
    parent_id: null,
    start_time: "2026-11-16T00:00:00.000000000Z",
    end_time: "2026-11-16T00:00:01.000000000Z",
    status_code: "OK",
    status_message: "",
    events: [],
    attributes: { [OI.METADATA]: writeMetadata(undefined, metadata) },
  })

  it("restates the relations kept in metadata", () => {
    const tool = { trace_id: "3".repeat(32), span_id: "4".repeat(16) }
    const result = { session_id: "child", trace_id: "5".repeat(32), span_id: "6".repeat(16) }

    expect(
      linksOf(
        span({
          previous: { trace_id: "7".repeat(32), span_id: "8".repeat(16) },
          delivers: [{ kind: "task", id: "t1", ...tool, result, inbox_id: "job-j1" }],
          origin: { session_id: "parent", ...tool },
        }),
      ),
    ).toEqual([
      { trace_id: "7".repeat(32), span_id: "8".repeat(16), relation: "previous" },
      { ...tool, relation: "delivers" },
      { trace_id: result.trace_id, span_id: result.span_id, relation: "result" },
      { ...tool, relation: "origin" },
    ])
    expect(linksOf(span({ previous: null }))).toEqual([])
  })
})
