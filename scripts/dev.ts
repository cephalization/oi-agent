/**
 * `pnpm dev`: build the CLI and install that build onto your PATH as `oi`.
 *
 * Each run copies the build into its own directory under the builds
 * directory and points the link there, so a later build in the repo (by you,
 * by `pnpm build`, or by an agent working on oi) never changes the `oi` that
 * is already installed or running. Run `pnpm dev` again to install a change.
 *
 * It refuses to run under oi itself (the bash tool sets OI_AGENT=1): an agent
 * working on oi would otherwise replace the `oi` it and every other session
 * runs with its unfinished work. Pass `--force` to do it anyway.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "packages", "cli")

// Links made before builds were copied pointed straight at the repo's build.
const legacyTarget = path.join(cli, "dist", "oi.mjs")
const onPath = (process.env["PATH"] ?? "").split(path.delimiter)
const candidates = [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), "bin")]

const buildsDir =
  process.env["OI_AGENT_BUILDS_DIR"] ?? path.join(os.homedir(), ".local", "share", "oi-agent", "builds")

// Older builds may still be running (and load chunks lazily); keep a few.
const KEEP_BUILDS = 5

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

if (process.env["OI_AGENT"] === "1" && !process.argv.includes("--force")) {
  fail(
    [
      "pnpm dev is running under oi, and would replace the `oi` this session runs with this checkout's build.",
      "To try a change, run `bin/oi` (the sources) or `node packages/cli/dist/oi.mjs` after `pnpm build`.",
      "If installing it really is what you were asked to do, run `pnpm dev --force`.",
    ].join("\n"),
  )
}

const linkTarget = (file: string): string | undefined => {
  try {
    return fs.readlinkSync(file)
  } catch {
    return undefined
  }
}

const binDir =
  process.env["OI_AGENT_BIN_DIR"] ??
  candidates.find((dir) => onPath.includes(dir)) ??
  fail(`None of ${candidates.join(", ")} is on your PATH. Add one, or set OI_AGENT_BIN_DIR.`)

const link = path.join(binDir, "oi")
const existing = linkTarget(link)
const ours = existing === legacyTarget || existing?.startsWith(buildsDir + path.sep) === true

// Only ever replace a link this script made; never a different program named `oi`.
if (fs.existsSync(link) && !ours) {
  fail(`${link} already exists and is not this project's build. Remove it, or set OI_AGENT_BIN_DIR.`)
}

execFileSync("node", [path.join(root, "scripts", "self.ts")], { stdio: "inherit" })

execFileSync("pnpm", ["exec", "vp", "pack"], { cwd: cli, stdio: "inherit" })

const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-")
const build = path.join(buildsDir, `${stamp}-${commit}`)

// The same layout as the package, since the CLI finds `self/` next to `dist/`.
fs.cpSync(path.join(cli, "dist"), path.join(build, "dist"), { recursive: true })

fs.cpSync(path.join(cli, "self"), path.join(build, "self"), { recursive: true })

const built = path.join(build, "dist", "oi.mjs")

fs.mkdirSync(binDir, { recursive: true })

fs.rmSync(link, { force: true })

fs.symlinkSync(built, link)

const builds = fs.readdirSync(buildsDir).toSorted().toReversed()

for (const old of builds.slice(KEEP_BUILDS))
  fs.rmSync(path.join(buildsDir, old), { recursive: true, force: true })

process.stdout.write(`\nLinked ${link} -> ${built}\nRun \`oi\` from any project.\n`)

if (!onPath.includes(binDir)) process.stdout.write(`Note: ${binDir} is not on your PATH yet.\n`)
