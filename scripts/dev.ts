/**
 * `pnpm dev`: build the CLI into one file and link it onto your PATH as `oi`.
 *
 * The link points at the build output, so running `pnpm dev` again after a
 * change is all it takes to update the command.
 */
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const built = path.join(root, "packages", "cli", "dist", "oi.mjs")
const onPath = (process.env["PATH"] ?? "").split(path.delimiter)
const candidates = [path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), "bin")]

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const linkTarget = (file: string): string | undefined => {
  try {
    return fs.readlinkSync(file)
  } catch {
    return undefined
  }
}

execFileSync("node", [path.join(root, "scripts", "self.ts")], { stdio: "inherit" })

execFileSync("pnpm", ["exec", "vp", "pack"], { cwd: path.join(root, "packages", "cli"), stdio: "inherit" })

const binDir =
  process.env["OI_AGENT_BIN_DIR"] ??
  candidates.find((dir) => onPath.includes(dir)) ??
  fail(`None of ${candidates.join(", ")} is on your PATH. Add one, or set OI_AGENT_BIN_DIR.`)

const link = path.join(binDir, "oi")
const existing = linkTarget(link)

// Only ever replace a link this script made; never a different program named `oi`.
if (fs.existsSync(link) && existing !== built) {
  fail(`${link} already exists and is not this project's build. Remove it, or set OI_AGENT_BIN_DIR.`)
}

fs.mkdirSync(binDir, { recursive: true })

fs.rmSync(link, { force: true })

fs.symlinkSync(built, link)

process.stdout.write(`\nLinked ${link} -> ${built}\nRun \`oi\` from any project.\n`)

if (!onPath.includes(binDir)) process.stdout.write(`Note: ${binDir} is not on your PATH yet.\n`)
