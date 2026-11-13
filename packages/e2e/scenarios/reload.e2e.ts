/**
 * Self-patching and reload (issue #8, Layer 0). A copy of the source in the
 * sandbox stands in for patched code: the launcher runs it through
 * `OI_AGENT_ENTRY`, and `/reload` restarts into it on the same session. A
 * patch that does not load is refused by the preflight; one that loads but
 * crashes on start falls back to the bundled build, with a note.
 *
 * The fallback runs `packages/cli/dist/oi.mjs`, which that scenario builds.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect } from "vite-plus/test"
import { REPO_ROOT, type Sandbox } from "../src/sandbox.ts"
import { MODELS, scenario } from "../src/scenario.ts"

const LAUNCHER = path.join(REPO_ROOT, "packages/cli/src/launcher.ts")
const BUNDLE = path.join(REPO_ROOT, "packages/cli/dist/oi.mjs")
const WELCOME = "Every step is an OpenInference span on disk."

/** The launcher, failing fast with a clear message while #8 has not added it. */
const launcher = (): string => {
  if (!fs.existsSync(LAUNCHER)) throw new Error(`No launcher at ${LAUNCHER} yet (issue #8, Layer 0).`)

  return LAUNCHER
}

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
const buildBundle = (): string => {
  execFileSync("pnpm", ["build"], { cwd: REPO_ROOT, stdio: "ignore" })

  if (!fs.existsSync(BUNDLE)) throw new Error(`pnpm build did not produce ${BUNDLE}`)

  return BUNDLE
}

describe("reload", () => {
  scenario(
    "/reload restarts into patched code and keeps the session",
    { needs: ["rex"] },
    async ({ sandbox, spans, tui }) => {
      const entry = overlay(sandbox)
      const term = await tui([], { entry: launcher(), env: new Map([["OI_AGENT_ENTRY", entry]]) })

      await term.waitFor(new RegExp(WELCOME))
      await term.line("Remember the word 'heron'. Reply with just: ok")

      const session = await spans.waitFor("a session", () => spans.sessions()[0])
      const [first] = await spans.settledTurns(session, 1)

      patch(appFile(entry), WELCOME, "PATCHED BUILD: every step is a span.")
      await term.line("/reload")
      await term.waitFor(/PATCHED BUILD/)
      await term.line("Which word did I ask you to remember? Reply with just the word.")

      const turns = await spans.settledTurns(session, 2)

      expect(spans.sessions()).toEqual([session])
      expect(turns[1]?.previous).toBe(first?.trace_id)
      expect(turns[1]?.output?.toLowerCase()).toContain("heron")
      // The new process carried over the model and effort.
      expect(spans.lastModel(session)).toEqual({ model: MODELS.main, effort: "low" })
    },
  )

  scenario(
    "a patch that does not load is refused by the preflight, and this build keeps running",
    { needs: ["rex"] },
    async ({ sandbox, spans, tui }) => {
      const entry = overlay(sandbox)
      const term = await tui([], { entry: launcher(), env: new Map([["OI_AGENT_ENTRY", entry]]) })

      await term.waitFor(new RegExp(WELCOME))
      await term.line("Reply with just: before")

      const session = await spans.waitFor("a session", () => spans.sessions()[0])

      await spans.settledTurns(session, 1)

      // A syntax error at the top of the entry point: the new process dies at once.
      fs.appendFileSync(entry, "\nthis is not typescript\n")
      await term.line("/reload")

      const screen = await term.waitFor(/failed the preflight/)

      expect(screen).toMatch(/›/)
      await term.line("Reply with just: after")

      const turns = await spans.settledTurns(session, 2)

      expect(turns[1]?.state).toBe("complete")
      expect(spans.sessions()).toEqual([session])
    },
  )

  scenario(
    "a patch that loads but crashes on start falls back to the bundled build with a note",
    { needs: ["rex"] },
    async ({ sandbox, spans, tui }) => {
      buildBundle()

      const entry = overlay(sandbox)
      const term = await tui([], { entry: launcher(), env: new Map([["OI_AGENT_ENTRY", entry]]) })

      await term.waitFor(new RegExp(WELCOME))
      await term.line("Reply with just: before")

      const session = await spans.waitFor("a session", () => spans.sessions()[0])

      await spans.settledTurns(session, 1)

      // Every module still loads, so the preflight passes; the terminal never comes up.
      patch(
        appFile(entry),
        "async run(): Promise<AppExit> {",
        'async run(): Promise<AppExit> {\n    throw new Error("patched to fail")',
      )
      await term.line("/reload")
      await term.waitFor(/this is the bundled build/)
      await term.line("Reply with just: after")

      const turns = await spans.settledTurns(session, 2)

      expect(turns[1]?.state).toBe("complete")
      expect(spans.sessions()).toEqual([session])
    },
  )
})
