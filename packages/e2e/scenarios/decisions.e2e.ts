/**
 * A decision model for auto-approvals (issue #12), against a fake System
 * One server so each answer is chosen by the test. The real service is not
 * needed: what matters is how oi routes on the answers and records them.
 */
import { OI, readMetadata, stringAttr } from "@oi-agent/engine"
import { afterAll, describe, expect } from "vite-plus/test"
import { type Decide, fakeSystemOne, type FakeServer } from "../src/fakes.ts"
import { type Scenario, scenario } from "../src/scenario.ts"
import { awaitApproval, callBash } from "../src/steps.ts"

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
  env: new Map([["TYPESAFE_API_KEY", "fake-typesafe-key"]]),
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
      await term.line(callBash("echo auto-approved"))

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
      await term.line(callBash("rm -rf ~/oi-e2e-does-not-exist"))
      await awaitApproval(s, term, "rm -rf ~/oi-e2e-does-not-exist")
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
    },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/›/)
      await term.line(callBash("echo needs-a-human"))
      await awaitApproval(s, term, "echo needs-a-human")
      await term.key("y")

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)
      expect(decisionSpans(s, session)).toEqual([])
    },
  )
})
