import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { expect, it } from "vite-plus/test"
import { findRex } from "../src/term.ts"

const decodeTerminals = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ session: Schema.String, block: Schema.String }))),
)

const decodeSessions = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      sessions: Schema.Array(Schema.Struct({ session_id: Schema.String, label: Schema.String })),
    }),
  ),
)

const rex = await findRex()

const command = (args: Array<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    if (rex === undefined) return reject(new Error("Rex is not installed"))

    execFile(rex, args, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
  })

const worker = () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../test/fixtures/rex-worker.ts", import.meta.url))],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  )

  const output = createInterface({ input: child.stdout })
  const exited = once(child, "exit")

  const ready = Promise.race([
    once(output, "line").then(([line]) => decodeTerminals(line)),
    exited.then(([code]) => {
      throw new Error(`Rex worker exited before readiness: ${code}`)
    }),
  ])

  let closed = false

  return {
    ready,
    close: async () => {
      if (closed) return

      closed = true

      if (child.exitCode === null) child.stdin.end("close\n")
      await exited
      output.close()
    },
  }
}

it.skipIf(rex === undefined)(
  "independent suite processes share oi e2e and close only their own panes",
  async () => {
    const first = worker()
    const second = worker()

    try {
      const [a, b] = await Promise.all([first.ready, second.ready])
      const sessions = decodeSessions(await command(["ls", "--json"])).sessions
      const shared = sessions.filter((session) => session.label === "oi e2e")

      expect(shared).toHaveLength(1)
      expect(new Set([...a, ...b].map((term) => term.session))).toEqual(new Set([shared[0]?.session_id]))
      expect(new Set([...a, ...b].map((term) => term.block)).size).toBe(8)
      const owner = a[0]
      const guest = b[0]

      if (owner === undefined || guest === undefined) throw new Error("Workers did not create terminals")

      // Even a tab created by the first worker is not safe to close wholesale
      // after another worker's pane has been moved into it.
      await command(["move", "-s", owner.session, guest.block, "right", owner.block])
      await first.close()

      for (const term of b) {
        await command(["send", "-s", term.session, "-b", term.block, "still-alive\n"])
        expect(await command(["capture", "-s", term.session, "-b", term.block, "--trim"])).toContain(
          "still-alive",
        )
      }

      await second.close()
      const view = await command(["session", "inspect", a[0]?.session ?? "", "--json"])

      for (const term of [...a, ...b]) expect(view).not.toContain(term.block)

      expect(decodeSessions(await command(["ls", "--json"])).sessions).toContainEqual(shared[0])
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  },
)
