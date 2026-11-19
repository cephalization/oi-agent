import { randomUUID } from "node:crypto"
import * as path from "node:path"
import type { Schema } from "effect"
import { afterAll, expect } from "vite-plus/test"
import { fakeChatModel } from "../src/fakes.ts"
import { scenario } from "../src/scenario.ts"

const model = await fakeChatModel("pong", [0, 0.000125, 0.00025, undefined])

afterAll(() => model.close())

scenario(
  "provider-reported LLM cost survives resume and syncs to drivers and viewers",
  {
    needs: ["rex"],
    model: "fake/pong",
    // Only the local fixture should be contacted, even for model discovery.
    env: new Map([
      ["ANTHROPIC_API_KEY", ""],
      ["OPENAI_API_KEY", ""],
      ["OI_AGENT_KEYCHAIN_SERVICE", `oi-e2e-session-cost-${randomUUID()}`],
    ]),
    config: new Map<string, Schema.Json>([
      ["steering", "off"],
      [
        "providers",
        [
          {
            id: "fake",
            name: "Fake",
            kind: "openai-compatible",
            base_url: model.url,
            models: [{ id: "pong" }],
          },
        ],
      ],
    ]),
  },
  async (s) => {
    const host = await s.tui()
    await host.waitFor(/enter starts a new turn/)
    const session = s.spans.onlySession()
    const costs = () => s.spans.ofKind(session, "LLM").map((span) => span.attributes["llm.cost.total"])

    await host.line("First call.")
    await s.spans.settledTurns(session, 1)
    expect(costs()).toEqual([0])
    await host.waitFor(/LLM \$0\.000000/)
    await host.line("Second call.")
    await s.spans.settledTurns(session, 2)
    expect(costs()).toEqual([0, 0.000125])
    await host.waitFor(/LLM \$0\.000125/)
    await host.line("/quit")
    expect(await host.exited()).toBe(0)

    const resumed = await s.tui(["-s", session])

    await resumed.waitFor(/LLM \$0\.000125/)
    await resumed.line("/share local")
    const screen = await resumed.waitFor(/View \(read-only\)/)
    const links = [...screen.matchAll(/oi join (oi-share:\S+)/g)].map((match) => match[1]!)

    expect(links).toHaveLength(2)

    const driver = await s.tui(["join", links[0]!], {
      env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, "driver")]]),
    })

    const viewer = await s.tui(["join", links[1]!], {
      env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, "viewer")]]),
    })

    await driver.waitFor(/LLM \$0\.000125/)
    await viewer.waitFor(/LLM \$0\.000125/)
    await driver.line("Third call.")
    await s.spans.settledTurns(session, 3)
    expect(costs()).toEqual([0, 0.000125, 0.00025])

    for (const term of [resumed, driver, viewer]) await term.waitFor(/LLM \$0\.000375/)

    await resumed.line("Fourth call.")
    await s.spans.settledTurns(session, 4)
    expect(costs()).toEqual([0, 0.000125, 0.00025, undefined])

    for (const term of [resumed, driver, viewer]) await term.waitFor(/LLM \$0\.000375 \(partial\)/)
  },
)
