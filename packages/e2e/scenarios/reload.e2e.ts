/**
 * Self-patching and reload (issue #8, Layer 0). A copy of the source in the
 * sandbox stands in for patched code: the launcher runs it through
 * `OI_AGENT_ENTRY`, `/reload` restarts into it on the same session, and a
 * broken patch falls back to the bundled build with a banner.
 *
 * Assumes the launcher's source is `packages/cli/src/launcher.ts` and that
 * the fallback needs a built `packages/cli/dist/oi.mjs` (`pnpm build`).
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect } from "vite-plus/test"
import { REPO_ROOT, type Sandbox } from "../src/sandbox.ts"
import { scenario } from "../src/scenario.ts"

const LAUNCHER = path.join(REPO_ROOT, "packages/cli/src/launcher.ts")
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

describe("reload", () => {
  scenario(
    "/reload restarts into patched code and keeps the session",
    { needs: ["rex"], pending: 8 },
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
    },
  )

  scenario(
    "a patch that fails to start falls back to the bundled build with a banner",
    { needs: ["rex"], pending: 8 },
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

      // Either the preflight refuses the reload, or the launcher falls back.
      const screen = await term.waitFor(/fall(ing)? back|fallback|did not start|preflight/i)

      expect(screen).toMatch(/›/)
      await term.line("Reply with just: after")

      const turns = await spans.settledTurns(session, 2)

      expect(turns[1]?.state).toBe("complete")
      expect(spans.sessions()).toEqual([session])
    },
  )
})
