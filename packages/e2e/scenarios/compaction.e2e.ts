import * as path from "node:path"
import { contextFor, importSession, OI, PhoenixClient, readMetadata, Store } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { PHOENIX_ENDPOINT, PHOENIX_PROJECT } from "../src/phoenix.ts"
import { expectOk, MODELS, scenario } from "../src/scenario.ts"

scenario(
  "manual compaction preserves history and survives a fresh process",
  { needs: ["rex"], phoenix: true },
  async (s) => {
    const term = await s.tui()

    await term.waitFor(/^›\s*$/m)
    await term.line("Remember: the deployment codename is walrus. Reply with just: ok")

    const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])
    const first = (await s.spans.settledTurns(session, 1))[0]
    const original = s.spans.ended(session).map((span) => JSON.stringify(span))

    await term.line("/compact Preserve the deployment codename")
    await term.waitFor(/Context compacted/)

    const turns = await s.spans.settledTurns(session, 2)
    const compact = turns[1]
    const checkpoint = s.spans.ofKind(session, "CHAIN").find((span) => span.name === "context.compact")

    expect(checkpoint).toBeDefined()
    expect(readMetadata(compact!.root).checkpoint).toEqual(checkpoint?.context)
    expect(readMetadata(checkpoint!).compaction?.source).toEqual(first?.root.context)
    expect(s.spans.ended(session).map((span) => JSON.stringify(span))).toEqual(
      expect.arrayContaining(original),
    )

    const context = contextFor(s.spans.store, session, compact!.trace_id)

    expect(JSON.stringify(context)).toContain("Generated context checkpoint")
    expect(JSON.stringify(context)).not.toContain("Reply with just: ok")
    await term.line("/quit")
    await term.exited()

    const fresh = await s.tui(["resume", session])

    await fresh.waitFor(/^›\s*$/m)
    expect(contextFor(s.spans.store, session, compact!.trace_id)).toEqual(context)
    await fresh.line("What is the deployment codename? Reply with just the codename.")

    const continued = await s.spans.settledTurns(session, 3)

    expect(continued[2]?.output?.toLowerCase()).toContain("walrus")

    const call = s.spans
      .trace(session, continued[2]!.trace_id)
      .find((span) => span.attributes[OI.SPAN_KIND] === "LLM")

    expect(call?.attributes[OI.INPUT_VALUE]).toContain("Generated context checkpoint")
    expect(call?.attributes[OI.INPUT_VALUE]).not.toContain("Reply with just: ok")
    await fresh.line("/quit")
    await fresh.exited()
    expectOk(await s.run(["export", session]))

    const client = new PhoenixClient({ endpoint: PHOENIX_ENDPOINT, project: PHOENIX_PROJECT })
    const restored = new Store(path.join(s.sandbox.home, "restored"))
    const expected = contextFor(s.spans.store, session, continued[2]!.trace_id)

    await s.spans.waitFor(
      "all compaction spans in Phoenix",
      async () => {
        await importSession(restored, client, session, { cwd: s.sandbox.home, device: restored.device() })

        return restored.readTrace(session, compact!.trace_id).ended.length ===
          s.spans.trace(session, compact!.trace_id).length &&
          restored.readTrace(session, continued[2]!.trace_id).ended.length ===
            s.spans.trace(session, continued[2]!.trace_id).length
          ? true
          : undefined
      },
      30_000,
    )
    expect(contextFor(restored, session, compact!.trace_id)).toEqual(context)
    expect(contextFor(restored, session, continued[2]!.trace_id)).toEqual(expected)
  },
)

scenario(
  "Anthropic compacts a tool conversation without replaying tool calls as summarizer actions",
  { needs: ["rex", "second-model"], model: MODELS.second, approvals: "allow" },
  async (s) => {
    const term = await s.tui()

    await term.waitFor(/^›\s*$/m)
    await term.line(
      "Call bash with printf 'migration-marker-quokka'. Remember its output as the migration marker. Then reply with just: ok",
    )
    const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

    await s.spans.settledTurns(session, 1)
    expect(s.spans.tools(session).some((tool) => tool.output.includes("migration-marker-quokka"))).toBe(true)
    await term.line("/compact preserve the migration marker")
    await term.waitFor(/Context compacted/)
    await s.spans.settledTurns(session, 2)
    await term.line("What is the migration marker? Reply with just the marker; do not call tools.")
    const turns = await s.spans.settledTurns(session, 3)

    expect(turns[2]?.output).toContain("migration-marker-quokka")
    expect(
      s.spans.trace(session, turns[1]!.trace_id).some((span) => span.attributes[OI.SPAN_KIND] === "TOOL"),
    ).toBe(false)
  },
)
