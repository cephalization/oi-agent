/** Real keyboard navigation and attachment; task headers/runners are deterministic fixtures. */
import { Jobs, newSessionId, type Job, type TaskHeader } from "@oi-agent/engine"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { expect } from "vite-plus/test"
import { expectOk, MODELS, scenario } from "../src/scenario.ts"

scenario(
  "tasks picker orders active first and opens running and finished conversations",
  { needs: ["rex"] },
  async (s) => {
    const store = s.spans.store
    const parent = store.createSession(s.sandbox.cwd)
    const jobs = new Jobs(path.join(s.sandbox.home, "jobs"))
    const started: Array<Job> = []
    const origin = { session_id: parent.id, trace_id: "a".repeat(32), span_id: "b".repeat(16) }

    const seed = (
      id: string,
      title: string,
      created: string,
      running: boolean,
      worktree?: TaskHeader["worktree"],
    ) => {
      const task: TaskHeader =
        worktree === undefined
          ? { id, title, isolation: "shared", model: MODELS.main }
          : { id, title, isolation: "worktree", model: MODELS.main, worktree }

      // Imported immutable headers give explicit creation order, independent of runner start order.
      const header = {
        ...parent,
        id: newSessionId(),
        created_at: created,
        cwd: worktree?.path ?? parent.cwd,
        parent: origin,
        task,
      }

      store.importHeader(header)

      const job = jobs.start({
        sessionId: parent.id,
        cwd: header.cwd,
        command: running ? "sleep 300" : "true",
        tool: origin,
        task: { id, session_id: header.id },
      })

      jobs.toBackground(job, "requested")
      started.push(job)

      return { header, job }
    }

    try {
      const old = seed("11111111", "older active", "2026-01-01T00:00:00.000Z", true)

      const worktree = {
        path: path.join(s.sandbox.root, "task-worktree"),
        branch: "picker-work",
        base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: parent.cwd, encoding: "utf8" }).trim(),
      }

      execFileSync("git", ["worktree", "add", "-b", worktree.branch, worktree.path], {
        cwd: parent.cwd,
        stdio: "ignore",
      })

      const fresh = seed("22222222", "newer active", "2026-01-02T00:00:00.000Z", true, worktree)
      const done = seed("33333333", "newest finished", "2026-01-03T00:00:00.000Z", false)

      await jobs.ended(done.job)
      expectOk(await s.run(["run", "--yolo", "-s", done.header.id, "Reply with exactly the word: heron"]))
      await s.spans.settledTurns(done.header.id, 1)
      jobs.claim(done.job)

      const term = await s.tui(["-s", parent.id])

      const visible = (pattern: RegExp) =>
        s.spans.waitFor(`viewport ${pattern}`, async () => {
          const screen = await term.viewport()

          return pattern.test(screen) ? screen : undefined
        })

      await term.waitFor(/Every step is an OpenInference span/)
      await term.line("/tasks")

      const screen = await term.waitFor(/\? Tasks · enter to choose/)

      expect(screen).toMatch(/❯ 22222222 newer active/)
      expect(screen).toContain(fresh.header.id)
      expect(screen).toContain("picker-work")
      expect(screen).toContain("task-worktree")
      expect(screen.indexOf("22222222 newer active")).toBeLessThan(screen.indexOf("11111111 older active"))
      expect(screen.indexOf("11111111 older active")).toBeLessThan(screen.indexOf("33333333 newest finished"))
      expect(screen).toMatch(/33333333 newest finished[^\n]*finished/)
      await term.key("down")
      await term.waitFor(/❯ 11111111 older active/)
      await term.key("up")
      await term.key("enter")
      await term.waitFor(/task 22222222 · \/detach to return/)
      await term.line("/detach")
      await visible(new RegExp(`session ${parent.id.slice(0, 13)}`))
      await term.line("/tasks")
      await term.waitFor(/\? Tasks · enter to choose/)
      await term.key("escape")
      expect(jobs.state(old.job).state).toBe("running")
      expect(jobs.state(fresh.job).state).toBe("running")
      await term.send("/attach ")
      await term.waitFor(/❯ 22222222 newer active/)
      await term.key("ctrl+u")
      await term.line("/tasks")
      await term.waitFor(/\? Tasks · enter to choose/)
      // Up wraps from the first active task to the finished task at the bottom.
      await term.key("up")
      await term.waitFor(/❯ 33333333 newest finished/)
      await term.key("enter")
      await term.waitFor(/task 33333333 · \/detach to return/)
      await term.waitFor(/^heron\b/im)
      await term.line("/detach")
      await visible(new RegExp(`session ${parent.id.slice(0, 13)}`))
      await term.line(`/attach ${old.header.task?.id}`)
      await term.waitFor(/task 11111111 · \/detach to return/)
      await term.line("/quit")
      expect(await term.exited()).toBe(0)
    } finally {
      for (const job of started) jobs.kill(job)
    }
  },
)
