import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test"
import { sharedRexSession } from "../src/rex-session.ts"

const listed = (ids: Array<string>) =>
  JSON.stringify({ sessions: ids.map((session_id) => ({ session_id, label: "oi e2e" })) })

describe("shared Rex session", () => {
  let root: string
  let lock: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "oi-e2e-rex-lock-test-"))
    lock = path.join(root, "lock")
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("serializes parallel discovery and creates exactly one windowless session", async () => {
    const ids: Array<string> = []
    const calls: Array<ReadonlyArray<string>> = []

    const command = async (args: ReadonlyArray<string>) => {
      calls.push(args)
      await new Promise((resolve) => setTimeout(resolve, 5))

      if (args[0] === "ls") return listed(ids)

      ids.push("session:shared")

      return JSON.stringify({ session_id: "session:shared" })
    }

    const results = await Promise.all(Array.from({ length: 8 }, () => sharedRexSession(command, lock)))

    expect(results).toEqual(Array.from({ length: 8 }, () => "session:shared"))
    expect(calls.filter((args) => args[0] === "api")).toEqual([
      ["api", "call", "session.create", '{"label":"oi e2e"}'],
    ])
  })

  it("re-lists after an ambiguous create failure instead of creating twice", async () => {
    let created = false

    const command = async (args: ReadonlyArray<string>) => {
      if (args[0] === "ls") return listed(created ? ["session:shared"] : [])

      created = true
      throw new Error("connection timed out after server created session")
    }

    await expect(sharedRexSession(command, lock)).resolves.toBe("session:shared")
    await expect(sharedRexSession(command, lock)).resolves.toBe("session:shared")
  })

  it("refuses ambiguous names without mutating any sessions", async () => {
    const calls: Array<ReadonlyArray<string>> = []

    await expect(
      sharedRexSession(async (args) => {
        calls.push(args)

        return listed(["session:a", "session:b"])
      }, lock),
    ).rejects.toThrow("Multiple Rex sessions")
    expect(calls).toEqual([["ls", "--json"]])
  })

  it("retains the lock when an outstanding create cannot be reconciled", async () => {
    const command = async (args: ReadonlyArray<string>) => {
      if (args[0] === "ls") return listed([])

      throw new Error("create request still outstanding")
    }

    await expect(sharedRexSession(command, lock)).rejects.toThrow("retaining")
    expect(fs.existsSync(lock)).toBe(true)
  })

  it("releases the lock after discovery fails without attempting creation", async () => {
    await expect(
      sharedRexSession(async () => {
        throw new Error("cannot list sessions")
      }, lock),
    ).rejects.toThrow("cannot list")
    expect(fs.existsSync(lock)).toBe(false)
  })
})
