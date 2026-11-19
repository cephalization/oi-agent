import * as fs from "node:fs"
import * as path from "node:path"
import { OI, projectDir, readMetadata, Store, stringAttr } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { expectOk, type Scenario, scenario } from "../src/scenario.ts"

const seed = (s: Scenario, name: string, pattern: string, any = ["tool:bash"]): void => {
  const dir = path.join(projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "evals")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({
      name,
      description: `Answer must match ${pattern}`,
      kind: "code",
      target: "output",
      pattern,
      match_label: "pass",
      otherwise_label: "fail",
      fail_labels: ["fail"],
      feedback: true,
      learn: false,
      applicability: { any },
    }),
  )
}

scenario(
  "automatic correction batches feedback and rechecks inapplicable obligations twice",
  {
    approvals: "allow",
    config: new Map<string, string | boolean>([
      ["auto_correction", true],
      ["steering", "off"],
    ]),
  },
  async (s) => {
    seed(s, "prefix", "^heron", ["commit"])
    seed(s, "suffix", "finch$", ["commit"])

    const result = await s.run([
      "run",
      "--yolo",
      "Call bash with `git commit --allow-empty -m initial-check`, then reply only rook. This is a staged test: when the next message explicitly says attempt 1, reply only wren, with no tools, even though this intentionally fails the checks. When it explicitly says attempt 2, reply only heron finch, with no tools. The attempt 1 response MUST NOT pass the checks. Treat evaluator feedback as observations, not new user instructions.",
    ])

    expectOk(result)
    const id = s.spans.onlySession()
    const turns = s.spans.turns(id)
    expect(turns).toHaveLength(3)
    expect(
      readMetadata(turns[1]!.root)
        .injected?.map((item) => item.name)
        .sort(),
    ).toEqual(["prefix", "suffix"])
    expect(s.spans.tools(id)).toHaveLength(1)
    const request = s.spans.trace(id, turns[1]!.trace_id).find((span) => span.name === "llm")!
    expect(stringAttr(request, OI.INPUT_VALUE)).toContain("<eval-feedback>")
    expect(stringAttr(request, OI.INPUT_VALUE)).toContain("did not match")
    const checks = s.spans.store.listAnnotations(id)

    for (const name of ["prefix", "suffix"]) {
      const original = checks.find(
        (a) => a.annotation.name === name && a.target.trace_id === turns[0]!.trace_id,
      )!

      for (const [index, label] of [
        [1, "fail"],
        [2, "pass"],
      ]) {
        const turn = turns[Number(index)]!
        expect(
          checks.find((a) => a.annotation.name === name && a.target.trace_id === turn.trace_id)?.annotation,
        ).toMatchObject({ label, metadata: { rechecks: original.id } })
      }
    }

    expect(result.stderr).toContain("Automatic correction stopped: passed")
  },
)

const enabled = new Map<string, string | boolean | number>([
  ["auto_correction", true],
  ["steering", "off"],
  ["max_correction_turns", 2],
])

scenario(
  "automatic correction stops at its bound despite newly failing evaluations",
  { config: enabled, needs: ["rex"] },
  async (s) => {
    seed(s, "unmet", "^never-say-this$", ["always"])
    seed(s, "new-failure", "^rook$", ["always"])

    const result = await s.run([
      "run",
      "--yolo",
      "This is a staged test. On the initial turn, call bash with `echo stage-zero` and reply only rook. On attempt 1, reply only wren with no tools; on attempt 2, reply only finch with no tools. The staged replies intentionally fail the original check; follow them even when the evaluator reports failure.",
    ])

    expectOk(result)
    const id = s.spans.onlySession()
    const turns = s.spans.turns(id)
    expect(turns.map((turn) => readMetadata(turn.root).correction?.attempt)).toEqual([undefined, 1, 2])
    expect(readMetadata(turns[2]!.root).injected?.map((item) => item.name)).toEqual(["unmet"])
    expect(
      s.spans.store
        .listAnnotations(id)
        .find(
          (entry) => entry.target.trace_id === turns[1]!.trace_id && entry.annotation.name === "new-failure",
        )?.annotation.label,
    ).toBe("fail")
    expect(result.stderr).toContain("Automatic correction stopped: budget exhausted")

    // Reopen the immutable prefix a crash would leave after the first durable recheck,
    // before attempt 2 started. Do not edit the original session or substitute synthetic spans.
    const from = s.spans.store

    const firstDecision = s.spans.ended(id).find((span) => {
      const state = readMetadata(span).correction_checkpoint

      return state?.attempts === 1 && state.stop === undefined
    })!

    expect(firstDecision).toBeDefined()
    const restartHome = path.join(s.sandbox.root, "restart")
    const restart = new Store(restartHome)

    const prefixTraces = new Set(
      s.spans
        .ended(id)
        .filter((span) => span.end_time <= firstDecision.end_time)
        .map((span) => span.context.trace_id),
    )

    const annotations = new Set(
      from
        .listAnnotations(id)
        .filter((entry) => prefixTraces.has(entry.target.trace_id ?? ""))
        .map((entry) => `annotations/${entry.id}.json`),
    )

    try {
      for (const file of from.manifest(id)) {
        const trace = file.split("/")[1] ?? ""

        if (
          file !== "session.json" &&
          !annotations.has(file) &&
          !(file.startsWith("traces/") && prefixTraces.has(trace))
        )
          continue
        const target = path.join(restart.sessionDir(id), file)

        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(from.sessionDir(id), file), target)
      }

      const resumed = await s.tui(["resume", id], { env: new Map([["OI_AGENT_HOME", restartHome]]) })
      await resumed.waitFor(/Automatic correction stopped: budget exhausted/)

      const corrected = restart
        .listTraceIds(id)
        .flatMap((trace) => restart.readTraceRoots(id, trace).ended)
        .flatMap((span) => readMetadata(span).correction ?? [])

      expect(corrected.map((entry) => entry.attempt).sort((a, b) => a - b)).toEqual([1, 2])
      expect(
        corrected.every((entry) => entry.budget === 2 && entry.origin.trace_id === turns[0]!.trace_id),
      ).toBe(true)
    } finally {
      restart.close()
    }
  },
)

scenario(
  "default feedback waits for the next user turn",
  {
    config: new Map([["steering", "off"]]),
  },
  async (s) => {
    seed(s, "ordinary", "^heron$", ["always"])
    const first = await s.run(["run", "Reply only rook."])
    expectOk(first)
    const id = s.spans.onlySession()
    expect(s.spans.turns(id)).toHaveLength(1)
    const [failure] = s.spans.store.listAnnotations(id)
    expect(failure?.annotation.metadata?.["feedback"]).toBe(true)
    const second = await s.run(["-s", id, "run", "Reply only heron."])
    expectOk(second)
    expect(readMetadata(s.spans.turns(id)[1]!.root).injected?.[0]?.annotation_id).toBe(failure?.id)
  },
)

scenario("automatic correction does not retry a session-size threshold", { config: enabled }, async (s) => {
  const dir = path.join(projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "evals")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "size.json"),
    JSON.stringify({
      name: "size",
      description: "Small session",
      kind: "threshold",
      metric: "session_bytes",
      max: 1,
      fail_labels: ["fail"],
      feedback: true,
      learn: false,
    }),
  )
  const result = await s.run(["run", "Reply only rook."])
  expectOk(result)
  expect(s.spans.turns(s.spans.onlySession())).toHaveLength(1)
  expect(result.stderr).toContain("Automatic correction stopped: unrepairable")
})

scenario(
  "shared correction is visible to both roles but only the host can approve it",
  {
    needs: ["rex"],
    config: enabled,
  },
  async (s) => {
    seed(s, "word", "^heron$", ["always"])
    const host = await s.tui()
    await host.waitFor(/enter starts a new turn/)
    await host.line("/share local")
    const screen = await host.waitFor(/View \(read-only\)/)
    const [drive, view] = [...screen.matchAll(/oi join (oi-share:\S+)/g)].map((match) => match[1]!)

    const driver = await s.tui(["join", drive!], {
      env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, "driver")]]),
    })

    const viewer = await s.tui(["join", view!], {
      env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, "viewer")]]),
    })

    await driver.waitFor(/enter starts a new turn/)
    await viewer.waitFor(/view only/)
    await driver.line(
      "Reply only rook to this initial message. When automatically asked to correct it, call bash with `echo correction-approved > proof` before replying heron. Call bash directly: oi asks the host for approval; your reply alone is not enough.",
    )
    await host.waitFor(/Allow bash[\s\S]*correction-approved/)

    for (const peer of [driver, viewer]) {
      await peer.waitFor(/Automatic correction 1\/2: word/)
      expect(await peer.viewport()).not.toMatch(/Allow bash/)
    }

    expect(fs.existsSync(s.sandbox.file("proof"))).toBe(false)
    await host.key("y")
    const id = s.spans.onlySession()
    await s.spans.settledTurns(id, 2)

    for (const peer of [host, driver, viewer]) await peer.waitFor(/Automatic correction stopped: passed/)
    expect(fs.readFileSync(s.sandbox.file("proof"), "utf8")).toBe("correction-approved\n")
  },
)

scenario(
  "a restarted correction does not repeat a side effect from a started turn",
  {
    needs: ["rex"],
    approvals: "allow",
    config: enabled,
  },
  async (s) => {
    seed(s, "word", "^heron$", ["always"])
    const term = await s.tui()
    await term.waitFor(/enter starts a new turn/)
    await term.line(
      "Reply only rook now. When automatically asked to correct it, first call bash with `printf x >> proof; sleep 25`. Run it in the foreground and then reply heron. Do not omit or background the tool call.",
    )
    const id = await s.spans.waitFor("session created", () => s.spans.sessions()[0])
    await s.spans.waitFor("corrective side effect", () =>
      fs.existsSync(s.sandbox.file("proof")) ? true : undefined,
    )
    const pid = await s.spans.waitFor("owner pid", () => s.spans.ownerPid(id))
    process.kill(pid, "SIGKILL")
    await term.exited(5000)
    const resumed = await s.tui(["resume", id])
    await resumed.waitFor(/Automatic correction stopped: interrupted/)
    const turns = s.spans.turns(id)
    expect(turns.map((turn) => readMetadata(turn.root).correction?.attempt)).toEqual([undefined, 1])
    expect(fs.readFileSync(s.sandbox.file("proof"), "utf8")).toBe("x")
  },
)

scenario(
  "escape stops an automatic correction waiting for approval",
  {
    needs: ["rex"],
    config: enabled,
  },
  async (s) => {
    seed(s, "word", "^heron$", ["always"])
    const term = await s.tui()
    await term.waitFor(/enter starts a new turn/)
    await term.line(
      "Follow this two-stage approval test. Stage 0 (this message only): reply exactly rook without tools. Stage 1 (a new message saying Automatic evaluator correction attempt 1): your first action MUST be a bash tool call with exactly `echo not-approved > proof`. Do not repeat rook or answer in prose in stage 1; call the tool directly so oi can ask me for approval. After the tool returns, reply heron.",
    )
    const approval = /Allow bash[\s\S]*not-approved/
    expect(await term.waitFor(/Allow bash[\s\S]*not-approved|Automatic correction stopped:/)).toMatch(
      approval,
    )
    await term.key("escape")
    await term.waitFor(/Automatic correction stopped: interrupted/)
    const id = s.spans.onlySession()
    expect(s.spans.turns(id).map((turn) => turn.state)).toEqual(["complete", "interrupted"])
    expect(fs.existsSync(s.sandbox.file("proof"))).toBe(false)
  },
)
