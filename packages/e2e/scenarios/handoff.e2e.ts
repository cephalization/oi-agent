import * as path from "node:path"
import { contextFor, importSession, OI, PhoenixClient, readMetadata, Store } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { PHOENIX_ENDPOINT, PHOENIX_PROJECT } from "../src/phoenix.ts"
import { expectOk, scenario } from "../src/scenario.ts"

scenario(
  "handoff opens a self-contained thread with the exact query and traced brief",
  { needs: ["rex"], phoenix: true },
  async (s) => {
    const term = await s.tui()

    await term.waitFor(/^›\s*$/m)
    await term.line("Remember: the migration codename is walrus. Reply with just: ok")
    const source = await s.spans.waitFor("source session", () => s.spans.sessions()[0])
    const first = (await s.spans.settledTurns(source, 1))[0]!
    const original = contextFor(s.spans.store, source, first.trace_id)
    const query = "What is the migration codename? Reply with just the codename."

    await term.line(`/handoff ${query}`)

    const destination = await s.spans.waitFor("handoff destination", () =>
      s.spans.sessions().find((id) => id !== source),
    )

    const turns = await s.spans.settledTurns(destination, 1)
    const turn = turns[0]!

    expect(turn.input).toBe(query)
    expect(turn.output?.toLowerCase()).toContain("walrus")
    expect(readMetadata(turn.root).previous).toBeNull()
    expect(readMetadata(turn.root).handoff_seed).toBeDefined()
    const seed = s.spans.ended(destination).find((span) => span.name === "handoff.seed")!

    expect(readMetadata(seed).handoff?.source_session_id).toBe(source)
    expect(seed.attributes[OI.INPUT_VALUE]).toBe(query)
    expect(seed.attributes[OI.OUTPUT_VALUE]).toBeTruthy()
    const sourceTurns = await s.spans.settledTurns(source, 2)

    expect(contextFor(s.spans.store, source, sourceTurns[1]!.trace_id)).toEqual(original)
    expect(s.spans.ofKind(source, "CHAIN").some((span) => span.name === "context.compact")).toBe(true)

    const call = s.spans
      .trace(destination, turn.trace_id)
      .find((span) => span.attributes[OI.SPAN_KIND] === "LLM")!

    expect(call.attributes[OI.INPUT_VALUE]).toContain("Generated handoff brief")
    await term.line("/quit")
    await term.exited()
    expectOk(await s.run(["export", destination]))
    const restored = new Store(path.join(s.sandbox.home, "restored"))
    const client = new PhoenixClient({ endpoint: PHOENIX_ENDPOINT, project: PHOENIX_PROJECT })

    await s.spans.waitFor("destination in Phoenix", async () => {
      await importSession(restored, client, destination, { cwd: s.sandbox.home, device: restored.device() })

      return restored.listTraceIds(destination).flatMap((id) => restored.readTrace(destination, id).ended)
        .length === s.spans.ended(destination).length
        ? true
        : undefined
    })
    expect(restored.readHeader(source)).toBeUndefined()
    expect(contextFor(restored, destination, turn.trace_id)).toEqual(
      contextFor(s.spans.store, destination, turn.trace_id),
    )

    const fresh = await s.tui(["resume", destination])

    await fresh.waitFor(/^›\s*$/m)
    await fresh.line("Repeat the migration codename only.")
    expect((await s.spans.settledTurns(destination, 2))[1]?.output?.toLowerCase()).toContain("walrus")
  },
)
