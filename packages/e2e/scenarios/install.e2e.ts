/**
 * `/reload` as oi is really installed, not from a checkout: the bundled
 * build behind a symlink, found by following the link at each reload.
 *
 * - `pnpm dev` links `oi` into a builds directory, one directory per build;
 *   running it again moves the link to a new one. A reload must follow it.
 * - `npm install -g` links `oi` to the package's `dist/launcher.mjs`; an
 *   upgrade replaces the files in place. A reload must pick them up.
 *
 * Each installs into the scenario's sandbox, never onto your PATH.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { readMetadata } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { REPO_ROOT } from "../src/sandbox.ts"
import { type Scenario, scenario } from "../src/scenario.ts"
import type { Terminal } from "../src/term.ts"

const WELCOME = "Every step is an OpenInference span on disk."

/** Replace text in a built file, failing loudly if the text is not there. */
const patch = (file: string, from: string, to: string): void => {
  const text = fs.readFileSync(file, "utf8")

  if (!text.includes(from)) throw new Error(`${file} no longer contains ${JSON.stringify(from)}`)

  fs.writeFileSync(file, text.replace(from, to))
}

/** Run one turn and wait for the session to have `count` settled turns. */
const turn = async (s: Scenario, term: Terminal, count: number, text: string) => {
  await term.line(text)

  const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

  return { session, turns: await s.spans.settledTurns(session, count) }
}

/** Start the installed `oi` (no OI_AGENT_ENTRY: the launcher runs the bundle beside it), chat, reload onto `banner`. */
const reloadOnto = async (s: Scenario, oi: string, upgrade: () => void, banner: RegExp): Promise<void> => {
  const term = await s.tui([], { entry: oi, env: new Map([["OI_AGENT_ENTRY", ""]]) })

  await term.waitFor(new RegExp(WELCOME))

  const {
    session,
    turns: [first],
  } = await turn(s, term, 1, "Remember the word 'tern'. Reply with just: ok")

  upgrade()
  await term.line("/reload")
  await term.waitFor(banner)

  const { turns } = await turn(s, term, 2, "Which word did I ask you to remember? Reply with just the word.")

  expect(s.spans.sessions()).toEqual([session])
  expect(turns[1]?.previous).toBe(first?.trace_id)
  expect(turns[1]?.output?.toLowerCase()).toContain("tern")
  expect(readMetadata(turns[1]!.root).pid).not.toBe(readMetadata(turns[0]!.root).pid)
}

describe("installed builds", () => {
  scenario(
    "a pnpm dev install reloads onto the build a later pnpm dev linked",
    { needs: ["rex"], timeoutMs: 420_000 },
    async (s) => {
      const bin = path.join(s.sandbox.root, "bin")
      const builds = path.join(s.sandbox.root, "builds")

      execFileSync("node", [path.join(REPO_ROOT, "scripts/dev.ts"), "--force"], {
        cwd: REPO_ROOT,
        stdio: "ignore",
        env: { ...process.env, OI_AGENT_BIN_DIR: bin, OI_AGENT_BUILDS_DIR: builds },
      })

      const oi = path.join(bin, "oi")
      const [installed = ""] = fs.readdirSync(builds)

      expect(fs.readlinkSync(oi)).toBe(path.join(builds, installed, "dist", "launcher.mjs"))

      // What a second `pnpm dev` does: a new build directory, and the link moved to it.
      const upgrade = (): void => {
        const next = path.join(builds, `${installed}-next`)

        fs.cpSync(path.join(builds, installed), next, { recursive: true })
        patch(path.join(next, "dist", "oi.mjs"), WELCOME, "NEXT BUILD: every step is a span.")
        fs.rmSync(oi)
        fs.symlinkSync(path.join(next, "dist", "launcher.mjs"), oi)
      }

      await reloadOnto(s, oi, upgrade, /NEXT BUILD/)
    },
  )

  scenario(
    "an npm install reloads onto files an upgrade replaced in place",
    { needs: ["rex"], timeoutMs: 420_000 },
    async (s) => {
      const packs = path.join(s.sandbox.root, "packs")
      const prefix = path.join(s.sandbox.root, "prefix")

      execFileSync("pnpm", ["pack", "--pack-destination", packs], {
        cwd: path.join(REPO_ROOT, "packages/cli"),
        stdio: "ignore",
      })

      const [tarball = ""] = fs.readdirSync(packs)

      execFileSync("npm", ["install", "--global", "--prefix", prefix, path.join(packs, tarball)], {
        stdio: "ignore",
      })

      const oi = path.join(prefix, "bin", "oi")
      const installed = path.join(prefix, "lib", "node_modules", "oi-agent", "dist")

      expect(fs.realpathSync(oi)).toBe(fs.realpathSync(path.join(installed, "launcher.mjs")))

      await reloadOnto(
        s,
        oi,
        () => patch(path.join(installed, "oi.mjs"), WELCOME, "UPGRADED: every step is a span."),
        /UPGRADED/,
      )
    },
  )
})
