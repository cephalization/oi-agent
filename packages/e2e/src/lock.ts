/**
 * A lock between test workers. Scenarios run side by side, each in its own
 * sandbox; the few that also touch something shared (the repo's `dist/`,
 * say) name it, and take turns.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { REPO_ROOT } from "./sandbox.ts"

const POLL_MS = 200

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

/** Take the lock, or clear it when the process that held it is gone. */
const tryTake = (dir: string): boolean => {
  const owner = path.join(dir, "pid")

  try {
    fs.mkdirSync(dir)
    fs.writeFileSync(owner, String(process.pid))

    return true
  } catch {
    // Held. An unreadable owner is a holder between its mkdir and its write.
    const pid = Number(fs.existsSync(owner) ? fs.readFileSync(owner, "utf8") : process.pid)

    if (!alive(pid)) fs.rmSync(dir, { recursive: true, force: true })

    return false
  }
}

/** Run `body` while no other worker of this checkout runs one under the same name. */
export const withLock = async <A>(name: string, body: () => Promise<A>): Promise<A> => {
  // Per checkout: two worktrees share nothing, and must not wait on each other.
  const checkout = createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 12)
  const dir = path.join(os.tmpdir(), "oi-e2e-locks", `${checkout}-${name}`)

  fs.mkdirSync(path.dirname(dir), { recursive: true })

  while (!tryTake(dir)) await sleep(POLL_MS)

  try {
    return await body()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
