/**
 * A decision model for auto-approvals (issue #12), against a fake System
 * One server so each answer is chosen by the test. The real service is not
 * needed: what matters is how oi routes on the answers and records them.
 */
import { OI, readMetadata, stringAttr } from "@oi-agent/engine"
import { afterAll, describe, expect } from "vite-plus/test"
import { type Decide, fakeSystemOne, type FakeServer } from "../src/fakes.ts"
import { MODELS, type Scenario, scenario } from "../src/scenario.ts"

/** Safe unless the state mentions `rm -rf`. */
const decide: Decide = (question, state) => {
  const destructive = state.includes("rm -rf")

  if (question === "irreversible") return destructive ? 0.97 : 0.02

  if (question === "requested") return 0.95

  return 0.03
}

/** Config that turns on auto approvals with the fake as the decision service. */
const withDecider = (server: FakeServer) => ({
  approvals: "auto" as const,
  config: new Map([["decision", { kind: "systemone", base_url: server.url, model: "jev-latest" }]]),
  env: new Map([
    ["TYPESAFE_API_KEY", "fake-typesafe-key"],
    // Until `approvals: "auto"` is valid, the CLI ignores the whole config
    // file; pin the model so that never means running on the default one.
    ["OI_AGENT_MODEL", MODELS.main],
  ]),
})

// Scenario options are fixed when the test is declared, but the fake's port
// is only known once it listens; start one fake up front for the file.
const server = await fakeSystemOne(decide)

afterAll(() => server.close())

const decisionSpans = (s: Scenario, session: string) =>
  s.spans.ended(session).filter((span) => span.attributes[OI.SPAN_KIND] === "DECISION")

describe("decision model", () => {
  scenario(
    "auto mode runs a safe command without asking and records the decision",
    { needs: ["rex"], pending: 12, ...withDecider(server) },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/›/)
      await term.line(
        "Call the bash tool now with `echo auto-approved`, without asking me first, and show the output.",
      )

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)
      expect(await term.screen()).not.toMatch(/Allow bash/)

      const bash = s.spans.tools(session).find((tool) => tool.input.includes("auto-approved"))

      expect(bash?.output).toContain("auto-approved")
      expect(readMetadata(bash!.span).approval).toMatchObject({ decision: "allow", by: "auto:jev-fake" })

      // One DECISION span, a child of the TOOL span it decided, with no llm.* attributes.
      const decisions = decisionSpans(s, session)

      expect(decisions).toHaveLength(1)
      expect(decisions[0]?.parent_id).toBe(bash?.span.context.span_id)
      expect(decisions[0]?.attributes["decision.system"]).toBe("typesafe")
      expect(decisions[0]?.attributes["decision.model_name"]).toBe("jev-fake")
      expect(Object.keys(decisions[0]?.attributes ?? {}).filter((key) => key.startsWith("llm."))).toEqual([])
      expect(stringAttr(decisions[0]!, OI.INPUT_VALUE)).toContain("irreversible")

      // The key never reaches the request body or a span.
      expect(server.requests.at(-1)?.headers["authorization"]).toBe("Bearer fake-typesafe-key")
      expect(JSON.stringify(s.spans.ended(session))).not.toContain("fake-typesafe-key")
    },
  )

  scenario(
    "auto mode still asks for a destructive command",
    { needs: ["rex"], pending: 12, ...withDecider(server) },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/›/)
      await term.line(
        "Call the bash tool now with `rm -rf ~/oi-e2e-does-not-exist`, without asking me first.",
      )
      await term.waitFor(/Allow bash/)
      await term.key("n")

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)

      const bash = s.spans.tools(session).find((tool) => tool.input.includes("rm -rf"))

      expect(readMetadata(bash!.span).approval?.decision).toBe("deny")
    },
  )

  scenario(
    "without a key, auto mode asks as before",
    {
      needs: ["rex"],
      pending: 12,
      approvals: "auto",
      config: withDecider(server).config,
      env: new Map([["OI_AGENT_MODEL", MODELS.main]]),
    },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/›/)
      await term.line("Call the bash tool now with `echo needs-a-human`, without asking me first.")
      await term.waitFor(/Allow bash/)
      await term.key("y")

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)
      expect(decisionSpans(s, session)).toEqual([])
    },
  )
})
