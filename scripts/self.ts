/**
 * Assemble `packages/cli/self/`: the source, README and guide that ship with
 * the CLI so the agent can read how it works and explain itself.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = path.join(root, "packages", "cli", "self")

const documents = [
  ["README.md", "README.md"],
  ["docs/how-it-works.md", "GUIDE.md"],
  ["PLAN.md", "PLAN.md"],
  ["docs/spec-gaps.md", "spec-gaps.md"],
  ["LICENSE", "LICENSE"],
] as const

fs.rmSync(out, { recursive: true, force: true })

fs.mkdirSync(out, { recursive: true })

for (const [from, to] of documents) fs.copyFileSync(path.join(root, from), path.join(out, to))

for (const name of ["engine", "cli"]) {
  fs.cpSync(path.join(root, "packages", name, "src"), path.join(out, "source", name, "src"), {
    recursive: true,
  })
}

process.stdout.write(`Wrote ${path.relative(root, out)}\n`)
