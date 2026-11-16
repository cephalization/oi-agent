/**
 * Delegated tasks (issue #46). A session hands work to a subagent, which is a
 * session of its own run by a headless process; the two are linked through
 * their files, and the result returns as a delivery turn.
 *
 * The prompts dictate each tool call, so a scenario checks what oi does with
 * a delegation, not whether a model chooses to delegate.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  type EndedSpan,
  type EngineMetadata,
  readMetadata,
  type SessionHeader,
  stringAttr,
  OI,
} from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, type Scenario, scenario } from "../src/scenario.ts"

interface Delegation {
  /** The `TOOL` span of the delegate call. */
  readonly tool: EndedSpan
  readonly task: NonNullable<EngineMetadata["task"]>
  /** The subagent's session. */
  readonly child: SessionHeader
}

const headerOf = (s: Scenario, session: string): SessionHeader => {
  const header = s.spans.store.readHeader(session)

  if (header === undefined) throw new Error(`session ${session} has no header`)

  return header
}

/** The session the scenario's prompts went to: the one nobody delegated. */
const parentOf = (s: Scenario): string => {
  const parents = s.spans.sessions().filter((session) => headerOf(s, session).task === undefined)

  if (parents.length !== 1) throw new Error(`expected one delegating session, found ${parents.length}`)

  return parents[0] ?? ""
}

const delegations = (s: Scenario, parent: string): Array<Delegation> =>
  s.spans
    .tools(parent)
    .filter((call) => call.name === "delegate")
    .flatMap((call) => {
      const task = readMetadata(call.span).task

      return task === undefined ? [] : { tool: call.span, task, child: headerOf(s, task.session_id) }
    })

const delegation = (s: Scenario, parent: string): Delegation => {
  const [only, ...rest] = delegations(s, parent)

  if (only === undefined || rest.length > 0) throw new Error("expected exactly one delegated task")

  return only
}

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim()

/** A prompt that has the model delegate once, with these arguments, and then stop. */
const delegate = (title: string, isolation: "worktree" | "shared", brief: string): string =>
  `Call the delegate tool now with title "${title}", isolation "${isolation}" and exactly this prompt: "${brief}" ` +
  `Then call no more tools and reply with just: delegated.`

describe("delegated tasks", () => {
  scenario(
    "a task works in its own session and worktree, and its result returns as a delivery",
    {},
    async (s) => {
      const result = await s.run([
        "run",
        "--yolo",
        `${delegate(
          "add farewell",
          "worktree",
          "Create a file named farewell.txt containing exactly the word goodbye, then commit it with the message 'add farewell'. Report the file name.",
        )} When the task's result is delivered to you, reply with just the branch name it gives.`,
      ])

      expectOk(result)

      const parent = parentOf(s)
      const turns = await s.spans.settledTurns(parent, 2)
      const { tool, task, child } = delegation(s, parent)
      const worktree = child.task?.worktree

      // The two sessions name each other: the tool span its task, the task's header that span.
      expect(child.parent).toEqual({
        session_id: parent,
        trace_id: tool.context.trace_id,
        span_id: tool.context.span_id,
      })
      expect(child.task).toMatchObject({ id: task.id, title: "add farewell", isolation: "worktree" })
      expect(worktree?.path).toBe(path.join(s.sandbox.home, "worktrees", task.id))
      expect(child.cwd).toBe(worktree?.path)

      // The brief is the task's first prompt, word for word, and says where it came from.
      const [first] = await s.spans.settledTurns(child.id, 1)

      expect(first?.input).toContain("Create a file named farewell.txt")
      expect(readMetadata(first!.root).origin).toEqual(child.parent)
      expect(readMetadata(first!.root).inbox_id).toBeDefined()
      expect(readMetadata(first!.root).workspace?.cwd).toBe(worktree?.path)

      // The work is on the task's branch, in its checkout; the delegating checkout is untouched.
      expect(fs.readFileSync(path.join(worktree?.path ?? "", "farewell.txt"), "utf8").trim()).toBe("goodbye")
      expect(fs.existsSync(path.join(s.sandbox.cwd, "farewell.txt"))).toBe(false)
      expect(git(s.sandbox.cwd, "log", "--format=%s", "-1", worktree?.branch ?? "")).toBe("add farewell")
      expect(git(s.sandbox.cwd, "status", "--porcelain")).toBe("")

      // The result is a turn nobody typed, pointing both ways.
      const delivers = readMetadata(turns[1]!.root).delivers

      expect(delivers).toHaveLength(1)
      expect(delivers?.[0]).toMatchObject({
        kind: "task",
        id: task.id,
        trace_id: tool.context.trace_id,
        span_id: tool.context.span_id,
        result: { session_id: child.id },
      })
      expect(turns[1]?.input).toContain(`task ${task.id} "add farewell": finished`)
      expect(turns[1]?.input).toContain(worktree?.branch)
      expect(turns[1]?.output).toContain(worktree?.branch)
    },
  )

  scenario(
    "a task outlives the process that delegated it, and a follow-up wakes it with what it knew",
    {},
    async (s) => {
      expectOk(
        await s.run([
          "run",
          "--yolo",
          "--no-wait",
          delegate("pick a word", "shared", "Reply with exactly: the word is heron"),
        ]),
      )

      const parent = parentOf(s)
      const { task, child } = delegation(s, parent)

      // Nobody is running the delegating session. The task finishes on its own.
      const [first] = await s.spans.settledTurns(child.id, 1)

      expect(first?.output?.toLowerCase()).toContain("heron")
      expect(child.cwd).toBe(fs.realpathSync(s.sandbox.cwd))
      expect(child.task?.worktree).toBeUndefined()

      // The next process delivers the result, then sends the task a follow-up, which starts a new runner.
      expectOk(
        await s.run([
          "run",
          "--yolo",
          "-s",
          parent,
          `Call the task_message tool now with id "${task.id}" and text "Which word did you report? Reply with just that word, in capitals." ` +
            `Then call no more tools and reply with just: sent. When the task's next result is delivered, reply with just the word it gives.`,
        ]),
      )

      const again = await s.spans.settledTurns(child.id, 2)
      const message = s.spans.tools(parent).find((call) => call.name === "task_message")?.span

      expect(again[1]?.output).toContain("HERON")
      expect(readMetadata(again[1]!.root).origin).toEqual({
        session_id: parent,
        trace_id: message?.context.trace_id,
        span_id: message?.context.span_id,
      })

      // Two deliveries: the first result, picked up by the second process, and the answer.
      const deliveries = s.spans
        .turns(parent)
        .filter((turn) => readMetadata(turn.root).delivers !== undefined)

      expect(deliveries).toHaveLength(2)
      expect(deliveries.every((turn) => readMetadata(turn.root).delivers?.[0]?.id === task.id)).toBe(true)
      expect(deliveries[1]?.output).toContain("HERON")
    },
  )

  scenario(
    "two tasks in worktrees work side by side without touching each other or the checkout",
    { timeoutMs: 300_000 },
    async (s) => {
      const brief = (name: string): string =>
        `Create a file named ${name}.txt containing exactly the word ${name}, then commit it with the message 'add ${name}'. Report the file name.`

      expectOk(
        await s.run([
          "run",
          "--yolo",
          `Call the delegate tool twice now, in one step: once with title "left", isolation "worktree" and exactly this prompt: "${brief("left")}", ` +
            `and once with title "right", isolation "worktree" and exactly this prompt: "${brief("right")}" ` +
            `Then call no more tools and reply with just: delegated. Whenever results are delivered, reply with just: noted.`,
        ]),
      )

      const parent = parentOf(s)
      const tasks = delegations(s, parent)

      expect(tasks.map((entry) => entry.child.task?.title).toSorted()).toEqual(["left", "right"])

      for (const { child } of tasks) {
        const name = child.task?.title ?? ""
        const other = name === "left" ? "right" : "left"
        const dir = child.task?.worktree?.path ?? ""

        expect(fs.existsSync(path.join(dir, `${name}.txt`))).toBe(true)
        expect(fs.existsSync(path.join(dir, `${other}.txt`))).toBe(false)
        expect(git(dir, "log", "--format=%s", "-1")).toBe(`add ${name}`)
      }

      expect(
        fs.readdirSync(s.sandbox.cwd).filter((name) => name.endsWith(".txt") && /left|right/.test(name)),
      ).toEqual([])
      expect(git(s.sandbox.cwd, "status", "--porcelain")).toBe("")

      // Every result was delivered, in one turn or two.
      const delivered = s.spans
        .turns(parent)
        .flatMap((turn) => readMetadata(turn.root).delivers ?? [])
        .map((entry) => entry.id)

      expect(delivered.toSorted()).toEqual(tasks.map((entry) => entry.task.id).toSorted())
    },
  )

  scenario(
    "a task's tool call that needs a person is asked in the delegating terminal, and waits for the answer",
    { needs: ["rex"], approvals: "ask" },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/Every step is an OpenInference span/)
      await term.line(
        `${delegate(
          "say hello",
          "shared",
          "Call the bash tool now with the command `echo hello-from-task`. Do not ask first: oi asks the user itself. Then reply with just what it printed.",
        )} When the task's result is delivered, reply with just what the task printed.`,
      )

      // Delegating needs no approval; the task's bash call does, and is asked here.
      const screen = await term.waitFor(/Allow bash[\s\S]*echo hello-from-task/, 120_000)
      const parent = parentOf(s)
      const { task, child } = delegation(s, parent)

      expect(screen).toContain(`task ${task.id}`)

      // It waits: the call is still open in the task's session, marked as awaiting approval.
      expect(s.spans.waiting(child.id)).toHaveLength(1)

      await term.key("y")

      const [turn] = await s.spans.settledTurns(child.id, 1)
      const bash = s.spans.tools(child.id).find((call) => call.name === "bash")

      expect(bash?.output).toContain("hello-from-task")
      expect(readMetadata(bash!.span).approval?.decision).toBe("allow")
      expect(turn?.output).toContain("hello-from-task")

      const turns = await s.spans.settledTurns(
        await s.spans.waitFor("the delivery", () =>
          s.spans.turns(parent).length === 2 ? parent : undefined,
        ),
        2,
      )

      expect(stringAttr(turns[1]!.root, OI.USER_ID)).toBe("oi")
      expect(turns[1]?.output).toContain("hello-from-task")
      await term.waitFor(new RegExp(`result of background task ${task.id} delivered`))
      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    },
  )
})
