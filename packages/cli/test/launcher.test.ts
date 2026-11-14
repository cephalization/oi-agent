/**
 * The launcher's protocol, against fake CLIs. Each fake follows one step of
 * a plan per run (say it is ready, ask to reload, crash, get killed, wait for
 * a signal) and logs what it was started with, so the tests check exactly
 * which code the launcher ran, with which arguments, and what it exited with.
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vite-plus/test"

const LAUNCHER = fileURLToPath(new URL("../src/launcher.ts", import.meta.url))

/**
 * A fake CLI. Its step comes from `plan.json` by run number (the number of
 * lines already in `log.txt`), and it logs one line per run:
 * `<file> | <args> | <reload entry> | <fd> | <fallback note>`.
 */
const FAKE = `
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const dir = process.env.FAKE_DIR
const log = path.join(dir, "log.txt")
const runs = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0
const step = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"))[runs] ?? { exit: 99 }
const env = process.env

fs.appendFileSync(log, [
  path.basename(path.dirname(fileURLToPath(import.meta.url))) + "/" + path.basename(fileURLToPath(import.meta.url)),
  process.argv.slice(2).join(" "),
  env.OI_AGENT_RELOAD_ENTRY ? path.basename(env.OI_AGENT_RELOAD_ENTRY) : "-",
  env.OI_AGENT_LAUNCHER_FD ?? "-",
  env.OI_AGENT_FALLBACK ?? "-",
].join(" | ") + "\\n")

const tell = (fields) => fs.writeSync(Number(env.OI_AGENT_LAUNCHER_FD), fields.join("\\0") + "\\n")

if (step.ready) tell(["ready"])
if (step.relink) { fs.rmSync(step.relink.link); fs.symlinkSync(step.relink.to, step.relink.link) }
if (step.grandchild) spawn("/bin/sh", ["-c", "sleep 5"], { detached: true, stdio: "ignore" }).unref()
if (step.reload) { tell(["reload", ...step.reload]); process.exit(step.exit ?? 75) }
if (step.kill) process.kill(process.pid, step.kill)
if (step.wait) {
  process.on("SIGTERM", () => { fs.writeFileSync(path.join(dir, "got-sigterm"), ""); process.exit(step.exit ?? 0) })
  fs.writeFileSync(path.join(dir, "waiting"), String(process.pid))
  setInterval(() => undefined, 1000)
} else {
  process.exit(step.exit ?? 0)
}
`

interface Step {
  readonly ready?: boolean
  readonly reload?: ReadonlyArray<string>
  readonly exit?: number
  readonly kill?: string
  readonly wait?: boolean
  readonly grandchild?: boolean
  readonly relink?: { readonly link: string; readonly to: string }
}

interface Rig {
  readonly dir: string
  /** The launcher, copied beside a fake bundled build (`oi.mjs`). */
  readonly launcher: string
  /** A fake CLI to point `OI_AGENT_ENTRY` at. */
  readonly entry: string
}

/** A launcher and fake bundle in `<dir>/<name>`, sharing the plan and log in `dir`. */
const install = (dir: string, name: string): string => {
  const home = path.join(dir, name)

  fs.mkdirSync(home, { recursive: true })
  fs.copyFileSync(LAUNCHER, path.join(home, "launcher.ts"))
  fs.writeFileSync(path.join(home, "oi.mjs"), FAKE)

  return path.join(home, "launcher.ts")
}

const rig = (plan: ReadonlyArray<Step>): Rig => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-launcher-"))
  const launcher = install(dir, "dist")
  const entry = path.join(dir, "src", "entry.mjs")

  fs.mkdirSync(path.dirname(entry))
  fs.writeFileSync(entry, FAKE)
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan))

  return { dir, launcher, entry }
}

interface Result {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
  readonly ms: number
  /** One entry per child started: which file, with which arguments, what it was told. */
  readonly runs: ReadonlyArray<{
    file: string
    args: string
    reloadEntry: string
    fd: string
    fallback: string
  }>
}

const runsOf = (dir: string): Result["runs"] => {
  const log = path.join(dir, "log.txt")
  const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []

  return lines.map((line) => {
    const [file = "", args = "", reloadEntry = "", fd = "", fallback = ""] = line.split(" | ")

    return { file, args, reloadEntry, fd, fallback }
  })
}

const launch = (
  r: Rig,
  options: {
    readonly args?: ReadonlyArray<string>
    readonly entry?: string | undefined
    readonly via?: string
    readonly during?: (pid: number) => Promise<void>
  } = {},
): Promise<Result> =>
  new Promise((resolve) => {
    const started = Date.now()
    const env = { ...process.env, FAKE_DIR: r.dir, OI_AGENT_ENTRY: options.entry ?? "" }

    const child = spawn(process.execPath, [options.via ?? r.launcher, ...(options.args ?? [])], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    })

    let stderr = ""

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)

    void options.during?.(child.pid ?? 0)

    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stderr, ms: Date.now() - started, runs: runsOf(r.dir) })
    })
  })

const waitForFile = async (file: string): Promise<string> => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8")

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`${file} never appeared`)
}

describe("the launcher", () => {
  it("runs the bundled build beside it, passing arguments and the exit code through", async () => {
    const r = rig([{ ready: true, exit: 3 }])
    const result = await launch(r, { args: ["run", "hello world"] })

    expect(result.code).toBe(3)
    expect(result.runs).toEqual([
      { file: "dist/oi.mjs", args: "run hello world", reloadEntry: "oi.mjs", fd: "3", fallback: "-" },
    ])
  })

  it("runs OI_AGENT_ENTRY instead when it is set, and tells the child that is what a reload starts", async () => {
    const r = rig([{ ready: true }])
    const result = await launch(r, { entry: path.join(r.dir, "src", "entry.mjs") })

    expect(result.code).toBe(0)
    expect(result.runs.map((run) => [run.file, run.reloadEntry])).toEqual([["src/entry.mjs", "entry.mjs"]])
  })

  it("starts the code again with the arguments a reload asks for, as many times as asked", async () => {
    const r = rig([
      { ready: true, reload: ["-s", "S1", "-m", "a/b"] },
      { ready: true, reload: ["-s", "S1", "--effort", "max"] },
      { ready: true, exit: 0 },
    ])

    const result = await launch(r, { args: ["resume", "S1"], entry: r.entry })

    expect(result.code).toBe(0)
    expect(result.runs.map((run) => `${run.file}: ${run.args}`)).toEqual([
      "src/entry.mjs: resume S1",
      "src/entry.mjs: -s S1 -m a/b",
      "src/entry.mjs: -s S1 --effort max",
    ])
  })

  it("treats exit code 75 without a reload request as an ordinary exit", async () => {
    const r = rig([{ ready: true, exit: 75 }])
    const result = await launch(r, { entry: r.entry })

    expect(result.code).toBe(75)
    expect(result.runs).toHaveLength(1)
  })

  it("does not restart a child that asked to reload but then exited some other way", async () => {
    const r = rig([{ ready: true, reload: ["-s", "S1"], exit: 1 }])
    const result = await launch(r, { entry: r.entry })

    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(1)
  })

  it("does not fall back when the code fails on first start: nothing was reloaded", async () => {
    const r = rig([{ exit: 1 }])
    const result = await launch(r, { entry: r.entry })

    expect(result.code).toBe(1)
    expect(result.runs.map((run) => run.file)).toEqual(["src/entry.mjs"])
  })

  for (const [label, step] of [
    ["exits with an error before it is ready", { exit: 1 }],
    ["exits cleanly before it is ready", { exit: 0 }],
    ["crashes after it is ready", { ready: true, exit: 7 }],
  ] as const) {
    it(`falls back to the bundled build, on the same session, when reloaded code ${label}`, async () => {
      const r = rig([{ ready: true, reload: ["-s", "S1"] }, step, { ready: true, exit: 0 }])
      const result = await launch(r, { entry: r.entry })

      expect(result.code).toBe(0)
      expect(result.runs.map((run) => `${run.file}: ${run.args}`)).toEqual([
        "src/entry.mjs: ",
        "src/entry.mjs: -s S1",
        "dist/oi.mjs: -s S1",
      ])
      expect(result.runs[2]?.fallback).toMatch(/entry\.mjs\) .* so this is the bundled build/)
      // A reload from the fallback still tries the patched code.
      expect(result.runs[2]?.reloadEntry).toBe("entry.mjs")
    })
  }

  it("tries the patched code again on the next reload, and clears the fallback note once it starts", async () => {
    const r = rig([
      { ready: true, reload: ["-s", "S1"] },
      { exit: 1 },
      { ready: true, reload: ["-s", "S1"] },
      { ready: true, exit: 0 },
    ])

    const result = await launch(r, { entry: r.entry })

    expect(result.code).toBe(0)
    expect(result.runs.map((run) => run.file)).toEqual([
      "src/entry.mjs",
      "src/entry.mjs",
      "dist/oi.mjs",
      "src/entry.mjs",
    ])
    expect(result.runs[3]?.fallback).toBe("-")
  })

  it("does not loop when the bundled build fails too", async () => {
    const r = rig([{ ready: true, reload: ["-s", "S1"] }, { exit: 1 }, { exit: 2 }])
    const result = await launch(r, { entry: r.entry })

    expect(result.code).toBe(2)
    expect(result.runs).toHaveLength(3)
  })

  it("does not fall back when reloaded code was killed by a signal: someone meant it to stop", async () => {
    const r = rig([
      { ready: true, reload: ["-s", "S1"] },
      { ready: true, kill: "SIGKILL" },
    ])

    const result = await launch(r, { entry: r.entry })

    expect(result.code).toBe(137)
    expect(result.runs).toHaveLength(2)
  })

  it("passes SIGTERM on to the child and exits with the child's code", async () => {
    const r = rig([{ ready: true, wait: true, exit: 4 }])

    const result = await launch(r, {
      entry: r.entry,
      during: async (pid) => {
        await waitForFile(path.join(r.dir, "waiting"))
        process.kill(pid, "SIGTERM")
      },
    })

    expect(fs.existsSync(path.join(r.dir, "got-sigterm"))).toBe(true)
    expect(result.code).toBe(4)
  })

  it("exits as soon as the child does, even if something the child started is still running", async () => {
    const r = rig([{ ready: true, grandchild: true, exit: 0 }])
    const result = await launch(r, { entry: r.entry })

    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(3000)
  })

  it("follows the oi link on reload, so a newly installed build takes over", async () => {
    const r = rig([])
    const next = install(r.dir, "next")
    const link = path.join(r.dir, "oi")

    fs.symlinkSync(r.launcher, link)
    fs.writeFileSync(
      path.join(r.dir, "plan.json"),
      JSON.stringify([{ ready: true, relink: { link, to: next }, reload: ["-s", "S1"] }, { ready: true }]),
    )

    const result = await launch(r, { via: link })

    expect(result.code).toBe(0)
    expect(result.runs.map((run) => `${run.file}: ${run.args}`)).toEqual([
      "dist/oi.mjs: ",
      "next/oi.mjs: -s S1",
    ])
  })

  it("says so and fails when there is nothing to run", async () => {
    const r = rig([])

    fs.rmSync(path.join(r.dir, "dist", "oi.mjs"))

    const result = await launch(r)

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/no CLI to run/)
  })
})
