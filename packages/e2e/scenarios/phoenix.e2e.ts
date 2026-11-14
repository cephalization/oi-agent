/**
 * Phoenix as the place sessions live between machines: export a turn, wipe
 * the local session tree (and device identity, so it is a different
 * machine), then continue the session from Phoenix alone.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { kindOf, PhoenixClient, readMetadata } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { PHOENIX_ENDPOINT, PHOENIX_PROJECT } from "../src/phoenix.ts"
import { expectOk, scenario } from "../src/scenario.ts"

describe("Phoenix", () => {
  scenario(
    "a session exported from one machine continues on another from Phoenix alone",
    { phoenix: true },
    async ({ run, sandbox, spans }) => {
      const first = await run(["run", "Remember the word 'quokka'. Reply with just: ok"])

      expectOk(first)

      const session = spans.onlySession()
      const [turn] = await spans.settledTurns(session, 1)

      const exported = await run(["export", session])

      expectOk(exported)

      // Phoenix ingests asynchronously; wait until the turn is queryable.
      const client = new PhoenixClient({ endpoint: PHOENIX_ENDPOINT, project: PHOENIX_PROJECT })

      await spans.waitFor(
        "the turn in Phoenix",
        async () =>
          (await client.spans([turn?.trace_id ?? ""], { roots: true })).length > 0 ? true : undefined,
        30_000,
      )

      // Another machine: no local sessions, a new device id.
      fs.rmSync(path.join(sandbox.home, "sessions"), { recursive: true, force: true })
      fs.rmSync(path.join(sandbox.home, "device.json"), { force: true })

      const second = await run([
        "run",
        "-s",
        session,
        "Which word did I ask you to remember? Reply with just the word.",
      ])

      expectOk(second)
      expect(second.stdout.toLowerCase()).toContain("quokka")

      // The resumed session goes back to living only in Phoenix, so check
      // the second turn there: an AGENT root that continues the first.
      const roots = await spans.waitFor(
        "both turns in Phoenix",
        async () => {
          const traces = (await client.session(session))?.traces.map((trace) => trace.trace_id) ?? []

          // Steering and evaluator traces have roots too; the turns are the AGENT ones.
          const found = (await client.spans(traces, { roots: true })).filter(
            (root) => kindOf(root) === "AGENT",
          )

          return found.length >= 2 ? found : undefined
        },
        30_000,
      )

      const next = roots.find((root) => root.context.trace_id !== turn?.trace_id)

      expect(readMetadata(next ?? roots[0]!).previous?.trace_id).toBe(turn?.trace_id)
      expect(fs.existsSync(path.join(sandbox.home, "remote"))).toBe(true)
    },
  )
})
