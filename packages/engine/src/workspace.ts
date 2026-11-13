/**
 * Where a turn ran. Spans record the conversation, not the files, so a turn
 * notes its directory and checkout. A session resumed somewhere else (from
 * Phoenix, on another machine) can then say how its files may differ.
 */
import { execFileSync } from "node:child_process"
import type { Workspace } from "./format.ts"

const git = (cwd: string, args: ReadonlyArray<string>): string | undefined => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim()
  } catch {
    return undefined
  }
}

/** A remote URL without any user or token embedded in it. */
export const publicRemote = (remote: string): string => {
  if (!URL.canParse(remote)) return remote

  const url = new URL(remote)

  url.username = ""
  url.password = ""

  return url.toString()
}

/** The directory, and the checkout's remote, commit and dirtiness when it is a git work tree. */
export const workspaceOf = (cwd: string): Workspace => {
  const commit = git(cwd, ["rev-parse", "HEAD"])

  if (commit === undefined) return { cwd }

  const remote = git(cwd, ["remote", "get-url", "origin"])
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=no"])
  const checkout: Workspace["git"] = { commit, dirty: status !== undefined && status !== "" }

  return { cwd, git: remote === undefined ? checkout : { ...checkout, remote: publicRemote(remote) } }
}

/**
 * How the checkout at `here` differs from where a session last ran, in words.
 * Empty when it matches or there is nothing to compare.
 */
export const workspaceDrift = (recorded: Workspace | undefined, here: Workspace): Array<string> => {
  const notes: Array<string> = []

  if (recorded === undefined) return notes

  if (recorded.cwd !== here.cwd) notes.push(`It ran in ${recorded.cwd}; it will run in ${here.cwd} now.`)

  const then = recorded.git
  const now = here.git

  if (then === undefined) return notes

  if (now === undefined) {
    notes.push(`It ran in a git checkout at ${then.commit.slice(0, 7)}; this directory is not one.`)

    return notes
  }

  if (then.remote !== undefined && now.remote !== undefined && then.remote !== now.remote)
    notes.push(`It ran in a checkout of ${then.remote}; this is ${now.remote}.`)

  if (then.commit !== now.commit || then.dirty)
    notes.push(
      `It last ran at ${then.commit.slice(0, 7)}${then.dirty ? " with uncommitted changes" : ""}; this checkout is at ${now.commit.slice(0, 7)}${now.dirty ? " with uncommitted changes" : ""}. Files it mentions may differ.`,
    )

  return notes
}
