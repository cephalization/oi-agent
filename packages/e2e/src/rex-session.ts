/** Rex has no get-or-create or unique-label constraint. Serialize discovery and
 * creation across workers, suite processes and worktrees, not just this module.
 * Never expire a live lock: a paused creator could otherwise create a duplicate.
 */
import * as fs from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { Option, Schema } from "effect"

// Deliberately independent of cwd and TMPDIR (each sandbox can override it).
// A crashed holder fails closed; see the e2e README for recovery.
export const REX_SESSION_LOCK = `/tmp/oi-e2e-rex-session-${process.getuid?.() ?? "user"}.lock`

const decodeSessions = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      sessions: Schema.Array(Schema.Struct({ session_id: Schema.String, label: Schema.String })),
    }),
  ),
)

const decodeCreated = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ session_id: Schema.String })),
)

const decodeExists = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literal("EEXIST") }))

type RexCommand = (args: ReadonlyArray<string>) => Promise<string>

export const sharedRexSession = async (command: RexCommand, lock = REX_SESSION_LOCK): Promise<string> => {
  const deadline = Date.now() + 30_000

  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (error) {
      // The holder may remove the directory between mkdir's EEXIST and
      // this catch. Inspect the error, not the current filesystem state.
      if (Option.isNone(decodeExists(error))) throw error

      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${lock}; see packages/e2e/README.md for recovery.`)

      await sleep(50)
    }
  }

  let release = true

  try {
    const sessions = decodeSessions(await command(["ls", "--json"])).sessions
    const existing = sessions.filter((session) => session.label === "oi e2e")

    if (existing.length > 1)
      throw new Error('Multiple Rex sessions named "oi e2e"; refusing an ambiguous target.')

    if (existing[0] !== undefined) return existing[0].session_id

    // No initial shell/tab: each terminal owns only its separately created pane.
    // If creation times out, the server might still be processing it. Keep the
    // lock unless discovery proves it completed; never allow a second creator
    // to race an outstanding request. Recovery is deliberately manual.
    release = false

    try {
      const created = decodeCreated(await command(["api", "call", "session.create", '{"label":"oi e2e"}']))

      release = true

      return created.session_id
    } catch (error) {
      const recovered = decodeSessions(await command(["ls", "--json"])).sessions.filter(
        (session) => session.label === "oi e2e",
      )

      if (recovered.length === 1 && recovered[0] !== undefined) {
        release = true

        return recovered[0].session_id
      }

      throw new Error(`Rex creation failed; retaining ${lock} for safe recovery.`, {
        cause: error,
      })
    }
  } finally {
    if (release) fs.rmdirSync(lock)
  }
}
