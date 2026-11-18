/**
 * A decision model for auto-approvals and steering (issue #12), against a
 * fake System One server so each answer is chosen by the test. The real
 * service is not needed: what matters is how oi routes on the answers and
 * records them.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import {
  importSession,
  kindOf,
  OI,
  PhoenixClient,
  projectDir,
  readMetadata,
  Store,
  stringAttr,
} from "@oi-agent/engine"
import { Option, Schema } from "effect"
import { afterAll, describe, expect } from "vite-plus/test"
import { type Decide, fakeSystemOne, type FakeServer } from "../src/fakes.ts"
import { expectOk, MODELS, type Scenario, scenario } from "../src/scenario.ts"
import { awaitApproval, callBash } from "../src/steps.ts"
import { PHOENIX_ENDPOINT, PHOENIX_PROJECT } from "../src/phoenix.ts"

const SteeringState = Schema.fromJsonString(Schema.Struct({ user_message: Schema.String }))
const decodeSteeringState = Schema.decodeUnknownOption(SteeringState)

/** Approvals: safe unless the state mentions `rm -rf`. Steering: durable when the user says "from now on". */
const decide: Decide = (question, state) => {
  const destructive = state.includes("rm -rf")

  if (question === "durable")
    return Option.match(decodeSteeringState(state), {
      onNone: () => 0,
      onSome: ({ user_message }) => (/from now on/i.test(user_message) ? 0.95 : 0.05),
    })

  if (question === "irreversible") return destructive ? 0.97 : state.includes("needs-human") ? 0.6 : 0.02

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
    { needs: ["rex"], ...withDecider(server) },
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
    "auto explains why it asks and a one-call approval never enables yolo",
    {
      needs: ["rex"],
      ...withDecider(server),
      config: new Map<string, Schema.Json>([...withDecider(server).config, ["steering", "off"]]),
    },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/›/)
      await term.line(callBash("echo needs-human"))

      const screen = await awaitApproval(s, term, "echo needs-human")

      expect(screen).toMatch(/Auto asked/)
      expect(screen).toMatch(/irreversible=0.60/)
      expect(screen).not.toMatch(/always allow|enable yolo/)
      // `a` is not an approval shortcut in auto mode. Only y/n answer, without changing mode.
      await term.key("a")
      await term.key("y")

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)
      await term.waitFor(/⏵ auto/)
      await term.line(callBash("echo needs-human-again"))
      await awaitApproval(s, term, "echo needs-human-again")
      await term.key("n")
      await s.spans.settledTurns(session, 2)
      await term.line(callBash("echo safe-after-human"))
      await s.spans.settledTurns(session, 3)

      const calls = s.spans.tools(session)
      const allowed = calls.find((call) => call.input.includes('"echo needs-human"'))
      const denied = calls.find((call) => call.input.includes("needs-human-again"))
      const safe = calls.find((call) => call.input.includes("safe-after-human"))

      expect(allowed?.output).toContain("needs-human")
      expect(readMetadata(denied!.span).approval?.decision).toBe("deny")
      expect(readMetadata(safe!.span).approval?.by).toBe("auto:jev-fake")
      expect(decisionSpans(s, session)).toHaveLength(3)
    },
  )

  scenario(
    "reload preserves auto approvals selected in a session whose config says ask",
    { needs: ["rex"], ...withDecider(server), approvals: "ask" },
    async (s) => {
      const term = await s.tui()

      await term.waitFor(/›/)
      await term.line("/auto")
      await term.waitFor(/now approves tool calls/)
      await term.line("/reload")
      await term.waitFor(/reloading oi on session[\s\S]*Every step is an OpenInference span[\s\S]*⏵ auto/)
      await term.line(callBash("echo auto-after-reload"))

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.settledTurns(session, 1)

      const bash = s.spans.tools(session).find((tool) => tool.input.includes("auto-after-reload"))

      expect(bash?.output).toContain("auto-after-reload")
      expect(readMetadata(bash!.span).approval?.by).toBe("auto:jev-fake")
    },
  )

  scenario(
    "headless auto mode records a decision that round-trips through Phoenix",
    { phoenix: true, ...withDecider(server) },
    async (s) => {
      expectOk(await s.run(["run", callBash("echo auto-phoenix")]))

      const session = s.spans.onlySession()
      const [decision] = decisionSpans(s, session)

      expect(decision).toBeDefined()
      expect(s.spans.tools(session).find((tool) => tool.input.includes("auto-phoenix"))?.output).toContain(
        "auto-phoenix",
      )
      expectOk(await s.run(["export", session]))

      const client = new PhoenixClient({ endpoint: PHOENIX_ENDPOINT, project: PHOENIX_PROJECT })

      const restored = await s.spans.waitFor("the decision span in Phoenix", async () =>
        (await client.spans([decision!.context.trace_id])).find(
          (span) => span.context.span_id === decision!.context.span_id,
        ),
      )

      expect(kindOf(restored)).toBe("DECISION")
      expect(restored.parent_id).toBe(decision!.parent_id)
      expect(restored.attributes["decision.model_name"]).toBe("jev-fake")
      expect(restored.attributes["decision.token_count.input"]).toBe(120)
      expect(restored.attributes["decision.token_count.output"]).toBe(8)
      expect(readMetadata(restored).purpose).toBe("approval")
      expect(stringAttr(restored, OI.INPUT_VALUE)).toBe(stringAttr(decision!, OI.INPUT_VALUE))
      expect(stringAttr(restored, OI.OUTPUT_VALUE)).toBe(stringAttr(decision!, OI.OUTPUT_VALUE))
      expect(Object.keys(restored.attributes).some((key) => key.startsWith("llm."))).toBe(false)
    },
  )

  scenario(
    "auto mode still asks for a destructive command",
    { needs: ["rex"], ...withDecider(server) },
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
      approvals: "auto",
      config: withDecider(server).config,
      env: new Map([["TYPESAFE_API_KEY", ""]]),
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

  scenario(
    "steering screens every prompt with the decision model and writes an evaluator only for durable ones",
    {
      phoenix: true,
      config: new Map<string, Schema.Json>([
        ...withDecider(server).config,
        ["steering", "auto"],
        ["steering_model", "decision:jev-latest"],
      ]),
      // No Anthropic key: the evaluator is written by the session's own model.
      env: new Map([...withDecider(server).env, ["ANTHROPIC_API_KEY", ""]]),
    },
    async (s) => {
      // A skipped evaluator still records a verdict span, without needing a judge model.
      const dir = path.join(projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "evals")

      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, "check.json"),
        JSON.stringify({
          name: "check",
          description: "Check commits",
          kind: "code",
          pattern: "unused",
          target: "output",
          match_label: "fail",
          otherwise_label: "pass",
          fail_labels: ["fail"],
          applicability: { any: ["commit"] },
          feedback: false,
          learn: false,
        }),
      )

      expectOk(
        await s.run([
          "run",
          "What command installs this project's dependencies? Reply with just the command.",
        ]),
      )

      const session = s.spans.sessions()[0] ?? ""

      expectOk(
        await s.run(["run", "-s", session, "From now on, always use pnpm instead of npm in this project."]),
      )

      const detections = s.spans
        .ended(session)
        .filter((span) => span.parent_id === null && span.name === "steering")

      expect(detections).toHaveLength(2)

      const children = detections.map((detection) =>
        s.spans
          .trace(session, detection.context.trace_id)
          .filter((span) => span.parent_id === detection.context.span_id),
      )

      // The one-off prompt cost one decision and no model call; the durable one, a decision then a model call.
      expect(children.map((spans) => spans.map(kindOf))).toEqual([["DECISION"], ["DECISION", "LLM"]])
      expect(
        children
          .flat()
          .filter((span) => kindOf(span) === "DECISION")
          .map((span) => readMetadata(span).purpose),
      ).toEqual(["steering", "steering"])
      expect(s.spans.modelOf(children[1]![1]!).model).toBe(MODELS.main)

      // One evaluator was learned, and the verdict's confidence is the decision model's probability.
      expect(fs.readdirSync(dir).filter((name) => name !== "check.json")).toHaveLength(1)
      expect(stringAttr(detections[1]!, OI.OUTPUT_VALUE)).toContain('"confidence":0.95')

      const client = new PhoenixClient({ endpoint: PHOENIX_ENDPOINT, project: PHOENIX_PROJECT })
      const turns = await s.spans.settledTurns(session, 2)

      const evalsOnDisk = s.spans
        .ended(session)
        .filter((span) => kindOf(span) === "EVALUATOR" && span.name.startsWith("eval "))

      const auxiliaries = [...detections, ...children.flat(), ...evalsOnDisk]

      expect(evalsOnDisk.filter((span) => span.name === "eval check")).toHaveLength(2)

      // First wait for every ID via the session listing, including old-style traces on a regression.
      const remote = await s.spans.waitFor("all auxiliary spans in Phoenix", async () => {
        const info = await client.session(session)
        const traces = info?.traces.map((trace) => trace.trace_id) ?? []
        const spans = await client.spans(traces)
        const byId = new Map(spans.map((span) => [span.context.span_id, span]))

        return [...auxiliaries, ...turns.map((turn) => turn.root)].every((span) =>
          byId.has(span.context.span_id),
        )
          ? { traces, byId }
          : undefined
      })

      expect(remote.traces.toSorted()).toEqual(turns.map((turn) => turn.trace_id).toSorted())

      for (const span of [...detections, ...evalsOnDisk]) {
        const owner = turns.find((turn) => turn.trace_id === readMetadata(span).evaluates)

        expect(remote.byId.get(span.context.span_id)).toMatchObject({
          context: { trace_id: owner!.trace_id },
          parent_id: owner!.root.context.span_id,
        })
      }

      for (const child of children.flat()) {
        expect(remote.byId.get(child.context.span_id)).toMatchObject({
          context: { trace_id: remote.byId.get(child.parent_id!)!.context.trace_id },
          parent_id: child.parent_id,
        })
      }

      const restored = new Store(path.join(s.sandbox.root, "restored"))
      const header = s.spans.store.readHeader(session)

      await importSession(restored, client, session, { cwd: s.sandbox.cwd, device: header!.device })

      for (const span of auxiliaries) {
        const imported = restored
          .readTrace(session, span.context.trace_id)
          .ended.find((candidate) => candidate.context.span_id === span.context.span_id)

        expect(imported).toMatchObject({ context: span.context, parent_id: span.parent_id })
        expect(stringAttr(imported!, OI.INPUT_VALUE)).toBe(stringAttr(span, OI.INPUT_VALUE))
      }

      s.note(
        `Phoenix session ${session}: ${remote.traces.length} turn traces, ${auxiliaries.length} nested auxiliary spans`,
      )
    },
  )

  scenario(
    "a message said to a running turn reaches the approval decider and steering detection",
    {
      needs: ["rex"],
      ...withDecider(server),
      config: new Map<string, Schema.Json>([
        ...withDecider(server).config,
        ["steering", "auto"],
        ["steering_model", "decision:jev-latest"],
      ]),
      env: new Map([...withDecider(server).env, ["ANTHROPIC_API_KEY", ""]]),
    },
    async (s) => {
      const gated = "until [ -f go ]; do sleep 0.2; done; echo gate-opened"
      const steer = "From now on, always use printf instead of echo in this project."
      const term = await s.tui()

      await term.waitFor(/enter starts a new turn/)
      await term.line(
        `Call the bash tool now with exactly the command \`${gated}\` and no other arguments. When it finishes, call the bash tool a second time to print the word after-gate, then reply with just: done.`,
      )

      const session = await s.spans.waitFor("a session", () => s.spans.sessions()[0])

      await s.spans.waitFor("the gated command to be running", () =>
        s.spans
          .open(session)
          .find((span) => kindOf(span) === "TOOL" && readMetadata(span).awaiting_approval === false),
      )
      await term.waitFor(/enter steers the running turn/)
      await term.line(steer)
      await term.waitFor(/↳ steering, when the turn's current step ends/)
      fs.writeFileSync(path.join(s.sandbox.cwd, "go"), "")

      const [turn] = await s.spans.settledTurns(session, 1)

      expect(readMetadata(turn!.root).steered?.map((entry) => entry.text)).toEqual([steer])

      // The decider was asked about each command against what had been said by then.
      const asked = s.spans
        .tools(session)
        .map((tool) =>
          s.spans
            .ended(session)
            .find((span) => kindOf(span) === "DECISION" && span.parent_id === tool.span.context.span_id),
        )
        .map((decision) => (decision === undefined ? "" : (stringAttr(decision, OI.INPUT_VALUE) ?? "")))

      expect(asked.length).toBeGreaterThanOrEqual(2)
      expect(asked[0]).toContain("gate-opened")
      expect(asked[0]).not.toContain("printf instead of echo")

      for (const request of asked.slice(1)) expect(request).toContain("printf instead of echo")

      // Detection read the prompt and then the message, each on its own; only the message is durable.
      const detections = await s.spans.waitFor("both detections", () => {
        const found = s.spans
          .ended(session)
          .filter((span) => span.parent_id === null && span.name === "steering")

        return found.length === 2 ? found : undefined
      })

      expect(stringAttr(detections[1]!, OI.INPUT_VALUE)).toBe(steer)
      expect(detections.map((detection) => readMetadata(detection).evaluates)).toEqual([
        turn?.trace_id,
        turn?.trace_id,
      ])

      const screens = detections.map((detection) =>
        s.spans.trace(session, detection.context.trace_id).find((span) => kindOf(span) === "DECISION"),
      )

      // The message was judged against the turn as it stood, not against the turn before.
      expect(stringAttr(screens[1]!, OI.INPUT_VALUE)).toContain("gate-opened")
      expect(stringAttr(detections[0]!, OI.OUTPUT_VALUE)).toContain('"durable":false')
      expect(stringAttr(detections[1]!, OI.OUTPUT_VALUE)).toContain('"durable":true')
    },
  )
})
