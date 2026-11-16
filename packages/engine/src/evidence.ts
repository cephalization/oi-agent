/** Cheap, bounded observations around tool execution. Never persist file contents. */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { ToolEvidence } from "./format.ts"

export interface Snapshot {
  readonly root: string
  readonly reflog: string | undefined
  readonly files: string | undefined
}

const git = (cwd: string, args: Array<string>): string | undefined => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    return undefined
  }
}

/** Scope: tracked and non-ignored files in the cwd's Git worktree. Bounds fail open to evaluation. */
export const observeWorkspace = (cwd: string): Snapshot | undefined => {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim()

  if (root === undefined) return undefined
  const reflog = git(root, ["reflog", "show", "--format=%H %gs", "-n", "256"])
  const names = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  let files: string | undefined

  try {
    if (names === undefined) throw new Error("Cannot list files")
    const hash = createHash("sha256")
    let bytes = 0

    for (const name of [...new Set(names.split("\0").filter(Boolean))].sort()) {
      const file = path.join(root, name)
      hash.update(name).update("\0")

      if (!fs.existsSync(file)) {
        hash.update("missing\0")
        continue
      }

      const stat = fs.lstatSync(file)
      bytes += stat.size

      if (bytes > 64 * 1024 * 1024 || (!stat.isFile() && !stat.isSymbolicLink()))
        throw new Error("Snapshot bound")
      hash.update(String(stat.mode)).update("\0")
      hash.update(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file)).update("\0")
    }

    files = hash.digest("hex")
  } catch {
    files = undefined
  }

  return { root, reflog, files }
}

export const compareWorkspace = (before: Snapshot | undefined, after: Snapshot | undefined): ToolEvidence => {
  if (before === undefined || after === undefined || before.root !== after.root)
    return { writes: "unknown", commit: "unknown" }
  let commit: ToolEvidence["commit"] = "unknown"

  if (before.reflog !== undefined && after.reflog !== undefined) {
    const prior = before.reflog.split("\n")[0]
    const entries = after.reflog.trim().split("\n").filter(Boolean)
    const boundary = prior === "" ? entries.length : entries.indexOf(prior ?? "")

    if (boundary >= 0)
      commit = entries.slice(0, boundary).some((entry) => /^[a-f0-9]+ commit(?: |:)/.test(entry))
        ? "yes"
        : "no"
  }

  return {
    writes:
      before.files === undefined || after.files === undefined
        ? "unknown"
        : before.files === after.files
          ? "no"
          : "yes",
    commit,
  }
}
