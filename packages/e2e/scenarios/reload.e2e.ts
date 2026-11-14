/**
 * Self-patching and reload (issue #8, Layer 0). A copy of the source in the
 * sandbox stands in for patched code: the launcher runs it through
 * `OI_AGENT_ENTRY`, and `/reload` restarts into it on the same session.
 *
 * What can go wrong, and what each scenario proves:
 * - the reload itself: the patched code runs, the conversation carries on;
 * - model, effort and approval mode survive it;
 * - a patch that does not load is refused, and the old build keeps going;
 * - a patch that loads but dies on start falls back to the bundled build,
 *   and fixing it and reloading again gets back onto the patched code;
 * - a patch that crashes later, mid-session, falls back too;
 * - a killed launcher takes the CLI with it (no orphan left on the
 *   terminal), and the session resumes intact.
 *
 * Fallbacks run `packages/cli/dist/oi.mjs`, which those scenarios build.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { readMetadata } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { LAUNCHER, REPO_ROOT, type Sandbox } from "../src/sandbox.ts"
import { MODELS, type Scenario, scenario } from "../src/scenario.ts"
import { callBash } from "../src/steps.ts"
import type { Terminal } from "../src/term.ts"

const BUNDLE = path.join(REPO_ROOT, "packages/cli/dist/oi.mjs")
const WELCOME = "Every step is an OpenInference span on disk."

/** Copy the CLI and engine sources into the sandbox, sharing the checkout's installed dependencies. */
const overlay = (sandbox: Sandbox): string => {
  const root = path.join(sandbox.root, "overlay")

  for (const pkg of ["cli", "engine"]) {
    const from = path.join(REPO_ROOT, "packages", pkg)
    const to = path.join(root, "packages", pkg)

    fs.mkdirSync(to, { recursive: true })
    fs.cpSync(path.join(from, "src"), path.join(to, "src"), { recursive: true })
    fs.copyFileSync(path.join(from, "package.json"), path.join(to, "package.json"))
    fs.symlinkSync(path.join(from, "node_modules"), path.join(to, "node_modules"))
  }

  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(root, "package.json"))
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(root, "node_modules"))

  return path.join(root, "packages/cli/src/main.ts")
}

/** Replace text in an overlay file, failing loudly if the text is not there. */
const patch = (file: string, from: string, to: string): void => {
  const text = fs.readFileSync(file, "utf8")

  if (!text.includes(from)) throw new Error(`${file} no longer contains ${JSON.stringify(from)}`)

  fs.writeFileSync(file, text.replace(from, to))
}

const appFile = (entry: string): string => path.join(path.dirname(entry), "tui/app.ts")

/** Build the bundle the launcher falls back to, from the checkout's sources. */
const buildBundle = (): void => {
  execFileSync("pnpm", ["build"], { cwd: REPO_ROOT, stdio: "ignore" })

  if (!fs.existsSync(BUNDLE)) throw new Error(`pnpm build did not produce ${BUNDLE}`)
}

/** The launcher running the overlay, as `bin/oi` runs a checkout. */
const start = async (s: Scenario, entry: string): Promise<Terminal> => {
  const term = await s.tui([], { env: new Map([["OI_AGENT_ENTRY", entry]]) })

  await term.waitFor(new RegExp(WELCOME))

  return term
}

/** Run one turn and wait for the session to have `count` settled turns. */
const turn = async (s: Scenario, term: Terminal, count: number, text: string) => {
  await term.line(text)

  const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

  return { session, turns: await s.spans.settledTurns(session, count) }
}

/** Wait until the process a reload started has drawn its banner and status line. */
const reloaded = (term: Terminal): Promise<string> =>
  term.waitFor(
    /reloading oi on session[\s\S]*Every step is an OpenInference span[\s\S]*(ask before tools|yolo)/,
  )

/** The screen after the newest `reloading oi` line: what the new process drew. */
const sinceReload = async (term: Terminal): Promise<string> => {
  const screen = await term.screen()

  return screen.slice(screen.lastIndexOf("reloading oi on session"))
}

describe("reload", () => {
  scenario("/reload restarts into patched code and keeps the session", { needs: ["rex"] }, async (s) => {
    const entry = overlay(s.sandbox)
    const term = await start(s, entry)

    const {
      session,
      turns: [first],
    } = await turn(s, term, 1, "Remember the word 'heron'. Reply with just: ok")

    patch(appFile(entry), WELCOME, "PATCHED BUILD: every step is a span.")
    await term.line("/reload")
    await term.waitFor(/PATCHED BUILD/)

    const { turns } = await turn(
      s,
      term,
      2,
      "Which word did I ask you to remember? Reply with just the word.",
    )

    expect(s.spans.sessions()).toEqual([session])
    expect(turns[1]?.previous).toBe(first?.trace_id)
    expect(turns[1]?.output?.toLowerCase()).toContain("heron")
    expect(s.spans.lastModel(session)).toEqual({ model: MODELS.main, effort: "low" })

    // Each turn ran in its own process: the reload really restarted.
    const pids = turns.map((entry) => readMetadata(entry.root).pid)

    expect(pids[0]).toBeDefined()
    expect(pids[1]).not.toBe(pids[0])
  })

  scenario(
    "/reload keeps the model, effort and approval mode chosen in the session",
    { needs: ["rex", "second-model"] },
    async (s) => {
      const term = await start(s, overlay(s.sandbox))
      const { session } = await turn(s, term, 1, "Reply with just: one")

      await term.line(`/model ${MODELS.second}`)
      await term.waitFor(/Model is now/)
      await term.key("shift+tab")

      const effort = /effort (\w+)/.exec(await term.waitFor(/effort (?!low)\w+/))?.[1]

      await term.key("tab")
      await term.waitFor(/yolo/)
      await term.line("/reload")
      await reloaded(term)
      expect(await sinceReload(term)).toMatch(/⏵⏵ yolo/)

      await turn(s, term, 2, callBash("echo after-reload"))

      // Ran without asking: the approval mode came across.
      const bash = s.spans.tools(session).find((tool) => tool.input.includes("after-reload"))

      expect(bash?.output).toContain("after-reload")
      expect(readMetadata(bash!.span).approval?.decision).toBe("allow")
      expect(await sinceReload(term)).not.toMatch(/Allow bash/)
      expect(s.spans.lastModel(session)).toEqual({ model: MODELS.second, effort })
    },
  )

  scenario(
    "a patch that does not load is refused by the preflight, and this build keeps running",
    { needs: ["rex"] },
    async (s) => {
      const entry = overlay(s.sandbox)
      const term = await start(s, entry)
      const { session } = await turn(s, term, 1, "Reply with just: before")

      // A syntax error: nothing in the new code can load.
      fs.appendFileSync(entry, "\nthis is not typescript\n")
      await term.line("/reload")

      const screen = await term.waitFor(/Not reloading; this build keeps running/)

      expect(screen).toMatch(/failed the preflight/)
      expect(screen).not.toMatch(/reloading oi on session/)

      const { turns } = await turn(s, term, 2, "Reply with just: after")

      expect(turns[1]?.state).toBe("complete")
      expect(s.spans.sessions()).toEqual([session])
      // Still the same process.
      expect(readMetadata(turns[1]!.root).pid).toBe(readMetadata(turns[0]!.root).pid)
    },
  )

  scenario(
    "a patch that dies on start falls back to the bundled build, and a fixed one reloads again",
    { needs: ["rex"] },
    async (s) => {
      buildBundle()

      const entry = overlay(s.sandbox)
      const app = appFile(entry)
      const original = fs.readFileSync(app, "utf8")
      const term = await start(s, entry)
      const { session } = await turn(s, term, 1, "Remember the word 'otter'. Reply with just: ok")

      // Every module still loads, so the preflight passes; the terminal never comes up.
      patch(
        app,
        "async run(): Promise<AppExit> {",
        'async run(): Promise<AppExit> {\n    throw new Error("patched to fail")',
      )
      await term.line("/reload")
      await term.waitFor(/before it started, so this is the bundled build/)
      await turn(s, term, 2, "Reply with just: on the bundle")

      // The agent fixes its patch, and reloads onto it.
      fs.writeFileSync(app, original.replace(WELCOME, "FIXED BUILD: every step is a span."))
      await term.line("/reload")
      await term.waitFor(/FIXED BUILD/)
      expect(await sinceReload(term)).not.toMatch(/bundled build/)

      const { turns } = await turn(
        s,
        term,
        3,
        "Which word did I ask you to remember? Reply with just the word.",
      )

      expect(s.spans.sessions()).toEqual([session])
      expect(turns.map((entry) => entry.state)).toEqual(["complete", "complete", "complete"])
      expect(turns[2]?.previous).toBe(turns[1]?.trace_id)
      expect(turns[2]?.output?.toLowerCase()).toContain("otter")
    },
  )

  scenario(
    "a patch that crashes mid-session falls back to the bundled build on the same session",
    { needs: ["rex"] },
    async (s) => {
      buildBundle()

      const entry = overlay(s.sandbox)
      const term = await start(s, entry)
      const { session } = await turn(s, term, 1, "Remember the word 'puffin'. Reply with just: ok")

      // Loads and starts fine, then dies on a particular prompt.
      patch(
        appFile(entry),
        "  private submit(text: string): void {",
        '  private submit(text: string): void {\n    if (text.includes("crash-now")) throw new Error("patched to crash")',
      )
      await term.line("/reload")
      await reloaded(term)
      await term.line("crash-now")
      await term.waitFor(/crashed with exit code 1, so this is the bundled build/)

      const { turns } = await turn(
        s,
        term,
        2,
        "Which word did I ask you to remember? Reply with just the word.",
      )

      expect(s.spans.sessions()).toEqual([session])
      expect(turns[1]?.output?.toLowerCase()).toContain("puffin")
    },
  )

  scenario(
    "a killed launcher takes the CLI with it, and the session resumes intact",
    { needs: ["rex"] },
    async (s) => {
      const term = await start(s, overlay(s.sandbox))

      const {
        session,
        turns: [first],
      } = await turn(s, term, 1, "Remember the word 'gannet'. Reply with just: ok")

      const cli = readMetadata(first!.root).pid ?? 0

      const ps = (field: string, pid: number): string => {
        try {
          return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim()
        } catch {
          return ""
        }
      }

      const launcherPid = Number(ps("ppid", cli))

      expect(ps("command", launcherPid)).toContain(path.basename(LAUNCHER))
      process.kill(launcherPid, "SIGKILL")

      // No orphaned CLI left drawing on a terminal it no longer owns.
      await s.spans.waitFor("the CLI to exit", () => (ps("pid", cli) === "" ? true : undefined), 10_000)

      const resumed = await s.tui(["resume", session])

      await resumed.waitFor(/›/)

      const { turns } = await turn(
        s,
        resumed,
        2,
        "Which word did I ask you to remember? Reply with just the word.",
      )

      expect(turns[1]?.previous).toBe(first?.trace_id)
      expect(turns[1]?.output?.toLowerCase()).toContain("gannet")
    },
  )
})
