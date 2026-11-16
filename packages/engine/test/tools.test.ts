import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vite-plus/test"
import {
  builtinTools,
  type Job,
  type Jobs,
  jobsOf,
  type ToolContext,
  type ToolOutcome,
} from "../src/index.ts"
import type { Json } from "../src/wire.ts"
import { Tasks } from "../src/tasks.ts"
import { MODELS, tempStore } from "./helpers.ts"

const SESSION = "session"

const setup = () => {
  const store = tempStore()
  const jobs = jobsOf(store)
  const ended: Array<Job> = []

  jobs.onEnd((job) => ended.push(job))

  const context: ToolContext = {
    cwd: os.tmpdir(),
    emit: () => undefined,
    complete: (delivery, text) => {
      store.writeInbox(SESSION, { user_id: "oi", text, delivers: delivery }, delivery.inbox_id)
    },
    sessionId: SESSION,
    span: { trace_id: "trace", span_id: "span" },
    jobs,
    tasks: new Tasks(store, jobs, {}),
    userId: "tester",
    models: MODELS,
  }

  const call = (name: string, input: Json): Effect.Effect<ToolOutcome> => {
    const tool = builtinTools.find((candidate) => candidate.name === name)

    if (tool === undefined) throw new Error(`no ${name} tool`)

    return tool.run(input, context)
  }

  return {
    store,
    jobs,
    ended,
    call,
    run: (name: string, input: Json) => Effect.runPromise(call(name, input)),
  }
}

/** The one background job of the test's session. */
const onlyJob = (jobs: Jobs): Job => {
  const [job, ...rest] = jobs.list(SESSION)

  if (job === undefined || rest.length > 0) throw new Error("expected exactly one background job")

  return job
}

const until = async (check: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000

  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")

    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("bash", () => {
  it("returns the output and exit code of a command that finishes in time, and keeps nothing", async () => {
    const s = setup()
    const outcome = await s.run("bash", { command: "echo out; echo err >&2; exit 3" })

    expect(outcome.output).toBe("out\nerr\n[exit code 3]")
    expect(outcome.isError).toBe(true)
    expect(outcome.job).toBeUndefined()
    expect(fs.readdirSync(path.join(s.store.home, "jobs", SESSION))).toEqual([])
  })

  it("marks the commands it runs as running under oi", async () => {
    expect((await setup().run("bash", { command: "echo marker=$OI_AGENT" })).output).toContain("marker=1")
  })

  it("leaves a command that outlives its time limit running, and reports its end once", async () => {
    const s = setup()

    const outcome = await s.run("bash", {
      command: "echo first; sleep 0.6; echo second; exit 4",
      timeout_ms: 200,
    })

    const job = onlyJob(s.jobs)

    expect(outcome.isError).toBe(false)
    expect(outcome.output).toContain("first\n")
    expect(outcome.output).not.toContain("second")
    expect(outcome.output).toContain(
      `still running after 200 ms, so it continues in the background as job ${job.id}`,
    )
    expect(outcome.job).toEqual({ id: job.id, log: s.jobs.logPath(job), reason: "timeout" })

    await until(() => s.ended.length > 0)

    expect(s.ended).toEqual([job])
    expect(s.jobs.state(job)).toMatchObject({ state: "exited", code: 4 })
    expect(fs.readFileSync(s.jobs.logPath(job), "utf8")).toBe("first\nsecond\n")
  })

  it("starts a background command and returns at once", async () => {
    const s = setup()
    const started = Date.now()
    const outcome = await s.run("bash", { command: "sleep 30", background: true })
    const job = onlyJob(s.jobs)

    expect(Date.now() - started).toBeLessThan(5000)
    expect(outcome.output).toContain(`running in the background as job ${job.id}`)
    expect(outcome.job?.reason).toBe("requested")
    expect(s.jobs.state(job).state).toBe("running")

    s.jobs.kill(job)
  })

  it("reports a background command that fails at once as an ordinary failure", async () => {
    const s = setup()
    const outcome = await s.run("bash", { command: "no-such-command-here", background: true })

    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain("[exit code 127]")
    expect(s.jobs.list(SESSION)).toEqual([])
  })

  it("stops the command when the call is interrupted", async () => {
    const s = setup()
    const marker = `${os.tmpdir()}/oi-agent-interrupt-${process.pid}-${Date.now()}`
    const fiber = Effect.runFork(s.call("bash", { command: `sleep 1; touch ${marker}` }))

    await new Promise((resolve) => setTimeout(resolve, 300))
    await Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise((resolve) => setTimeout(resolve, 1200))

    expect(fs.existsSync(marker)).toBe(false)
    expect(s.ended).toEqual([])
  })
})

describe("background jobs", () => {
  it("a missing cwd throws without a later unhandled spawn error and cleans up the job", async () => {
    const s = setup()

    expect(() =>
      s.jobs.start({
        sessionId: SESSION,
        command: "true",
        cwd: path.join(s.store.home, "missing"),
        tool: { trace_id: "trace", span_id: "span" },
      }),
    ).toThrow(/Failed to start command/)

    // Node emits spawn's error on the next tick, after start has thrown.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fs.readdirSync(path.join(s.store.home, "jobs", SESSION))).toEqual([])
  })

  it("job_status shows a running job's output, and waiting for its end reports it instead of delivering it", async () => {
    const s = setup()

    await s.run("bash", { command: "echo working; sleep 0.8; echo done", timeout_ms: 100 })

    const job = onlyJob(s.jobs)
    const running = await s.run("job_status", { id: job.id })

    expect(running.output).toContain(`job ${job.id}: running for`)
    expect(running.output).toContain("working")
    expect((await s.run("job_status", {})).output).toContain(job.id)

    const finished = await s.run("job_status", { id: job.id, wait_ms: 10_000 })

    expect(finished.output).toContain(`job ${job.id}: exited with code 0 after`)
    expect(finished.output).toContain("working\ndone")

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(s.ended).toEqual([])
    expect(s.jobs.isReported(job)).toBe(true)
  })

  it("a wait that gives up leaves the end to be delivered", async () => {
    const s = setup()

    await s.run("bash", { command: "sleep 0.6", timeout_ms: 100 })

    const job = onlyJob(s.jobs)
    const waited = await s.run("job_status", { id: job.id, wait_ms: 100 })

    expect(waited.output).toContain("running for")

    await until(() => s.ended.length > 0)

    expect(s.ended).toEqual([job])
  })

  it("job_kill stops a job and what it started, and nothing is delivered", async () => {
    const s = setup()
    const marker = `${os.tmpdir()}/oi-agent-kill-${process.pid}-${Date.now()}`

    await s.run("bash", { command: `(sleep 1; touch ${marker}) & wait`, background: true })

    const job = onlyJob(s.jobs)
    const killed = await s.run("job_kill", { id: job.id })

    expect(killed.output).toContain(`job ${job.id}: killed after`)

    await new Promise((resolve) => setTimeout(resolve, 1300))

    expect(fs.existsSync(marker)).toBe(false)
    expect(s.ended).toEqual([])
  })

  it("refuses ids that are not this session's background jobs", async () => {
    const s = setup()

    expect((await s.run("job_status", { id: "../other" })).isError).toBe(true)
    expect((await s.run("job_kill", { id: "abcd1234" })).isError).toBe(true)
  })

  it("a new process follows the jobs a session left running, and stops what a dead tool call left", async () => {
    const s = setup()

    await s.run("bash", { command: "sleep 0.5; echo late", timeout_ms: 100 })

    const background = onlyJob(s.jobs)

    const orphan = s.jobs.start({
      sessionId: SESSION,
      command: "sleep 30",
      cwd: os.tmpdir(),
      tool: background.tool,
    })

    // What oi sees after a restart: the same files, and no child processes of its own.
    const later = jobsOf(s.store)
    const ended: Array<Job> = []

    later.onEnd((job) => ended.push(job))
    later.adopt(SESSION)

    expect(later.read(SESSION, orphan.id)).toBeUndefined()
    await until(() => ended.length > 0)

    expect(ended).toEqual([background])
    expect(later.state(background)).toMatchObject({ state: "exited", code: 0 })
    later.close()
  })
})
