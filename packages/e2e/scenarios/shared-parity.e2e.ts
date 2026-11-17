import * as fs from "node:fs"
import * as path from "node:path"
import {
  ApprovalDesk,
  Jobs,
  OI,
  type SpanFile,
  pendingInbox,
  readMetadata,
  writeMetadata,
} from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"
import { awaitApproval, callBash } from "../src/steps.ts"

scenario(
  "shared drivers steer or queue while viewers observe all senders and background work",
  { needs: ["rex"], approvals: "allow", config: new Map([["steering", "off"]]) },
  async (s) => {
    const host = await s.tui()

    await host.waitFor(/enter starts a new turn/)
    await host.line("/share local")
    const screen = await host.waitFor(/View \(read-only\)/)
    const links = [...screen.matchAll(/oi join (oi-share:\S+)/g)].map((match) => match[1]!)

    expect(links).toHaveLength(2)

    const driver = await s.tui(["join", links[0]!], {
      env: new Map([
        ["OI_AGENT_HOME", path.join(s.sandbox.root, "driver")],
        ["OI_AGENT_USER", "ana"],
      ]),
    })

    const viewer = await s.tui(["join", links[1]!], {
      env: new Map([
        ["OI_AGENT_HOME", path.join(s.sandbox.root, "viewer")],
        ["OI_AGENT_USER", "eve"],
      ]),
    })

    await viewer.waitFor(/view only/)
    await host.line(
      "Call bash now with command `until [ -f go ]; do sleep 0.2; done` and background true. Then reply only started. When background results arrive reply only finished.",
    )
    const session = s.spans.onlySession()

    await s.spans.settledTurns(session, 1)
    await driver.waitFor(/⚙ job/)
    await viewer.waitFor(/⚙ job/)
    await host.line(
      "Call bash now with command `until [ -f next ]; do sleep 0.2; done` and timeout_ms 120000. Then reply only done.",
    )
    await driver.waitFor(/enter steers the running turn/)
    await driver.line("End your reply with heron.")
    await driver.key("ctrl+t")
    await driver.line("Reply only pong.")
    await host.key("ctrl+t")
    await host.line("Reply only finch.")
    await viewer.waitFor(/Reply only pong\. \(ana\)/)
    await viewer.waitFor(/Reply only finch\. \(e2e\)/)
    await driver.waitFor(/Reply only finch\. \(e2e\)/)
    await host.waitFor(/Reply only pong\. \(ana\)/)
    await viewer.waitFor(/End your reply with heron\. \(ana\)/)
    await viewer.line("Never submit this viewer message.")
    expect(pendingInbox(s.spans.store, session).map((entry) => entry.user_id)).toEqual(["ana", "ana", "e2e"])
    fs.writeFileSync(path.join(s.sandbox.cwd, "next"), "")
    const turns = await s.spans.settledTurns(session, 4)

    expect(readMetadata(turns[1]!.root).steered).toMatchObject([
      { user_id: "ana", text: "End your reply with heron." },
    ])
    expect(turns[2]?.input).toBe("Reply only pong.")
    expect(turns[3]?.input).toBe("Reply only finch.")
    await s.spans.waitFor("viewer queue clears", async () =>
      !(await viewer.viewport()).includes("queued for the next turn:") ? true : undefined,
    )
    fs.writeFileSync(path.join(s.sandbox.cwd, "go"), "")
    await s.spans.settledTurns(session, 5)
  },
)

scenario(
  "shared tool approvals remain host owned",
  { needs: ["rex"], config: new Map([["steering", "off"]]) },
  async (s) => {
    const host = await s.tui()

    await host.waitFor(/enter starts a new turn/)
    await host.line("/share local")
    const screen = await host.waitFor(/View \(read-only\)/)
    const link = /oi join (oi-share:\S+)/.exec(screen)![1]!

    const driver = await s.tui(["join", link], {
      env: new Map([
        ["OI_AGENT_HOME", path.join(s.sandbox.root, "driver")],
        ["OI_AGENT_USER", "ana"],
      ]),
    })

    await driver.waitFor(/enter starts a new turn/)
    await driver.line(callBash("echo host-approval"))
    await awaitApproval(s, host, "echo host-approval")
    expect(await driver.viewport()).not.toMatch(/Allow bash/)
    await host.key("y")
    await s.spans.settledTurns(s.spans.onlySession(), 1)
  },
)

scenario(
  "shared drivers and viewers see child task approval status without parent events",
  { needs: ["rex"], config: new Map([["steering", "off"]]) },
  async (s) => {
    const store = s.spans.store
    const parent = store.createSession(s.sandbox.cwd)
    const origin = { session_id: parent.id, trace_id: "a".repeat(32), span_id: "b".repeat(16) }

    const child = store.createSession(s.sandbox.cwd, undefined, {
      parent: origin,
      task: { id: "12345678", title: "Child status", isolation: "shared", model: "scripted/scripted" },
    })

    const jobs = new Jobs(path.join(s.sandbox.home, "jobs"))

    const job = jobs.start({
      sessionId: parent.id,
      cwd: child.cwd,
      command: "sleep 300",
      tool: origin,
      task: { id: "12345678", session_id: child.id },
    })

    jobs.toBackground(job, "requested")
    const desk = new ApprovalDesk(store)
    const abort = new AbortController()
    const host = await s.tui(["-s", parent.id])

    try {
      await host.waitFor(/enter starts a new turn/)
      await host.line("/share local")
      const screen = await host.waitFor(/View \(read-only\)/)
      const links = [...screen.matchAll(/oi join (oi-share:\S+)/g)].map((match) => match[1]!)

      const driver = await s.tui(["join", links[0]!], {
        env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, "driver")]]),
      })

      const viewer = await s.tui(["join", links[1]!], {
        env: new Map([["OI_AGENT_HOME", path.join(s.sandbox.root, "viewer")]]),
      })

      await driver.waitFor(/task 12345678 Child status/)
      await viewer.waitFor(/task 12345678 Child status/)

      // Start another task after both peers have joined. No parent Store event
      // announces it: the read-only status stream must discover it for both roles.
      const next = store.createSession(s.sandbox.cwd, undefined, {
        parent: origin,
        task: { id: "87654321", title: "New child", isolation: "shared", model: "scripted/scripted" },
      })

      const nextJob = jobs.start({
        sessionId: parent.id,
        cwd: next.cwd,
        command: "sleep 300",
        tool: origin,
        task: { id: "87654321", session_id: next.id },
      })

      jobs.toBackground(nextJob, "requested")
      await driver.waitFor(/task 87654321 New child/)
      await viewer.waitFor(/task 87654321 New child/)
      await viewer.line("Cancel all tasks.")
      expect(pendingInbox(store, parent.id)).toEqual([])
      expect(jobs.state(nextJob).state).toBe("running")
      expect(await driver.viewport()).not.toMatch(/Allow bash/)

      const tool: SpanFile = {
        name: "bash",
        context: { trace_id: "c".repeat(32), span_id: "d".repeat(16) },
        parent_id: "e".repeat(16),
        span_kind: "SPAN_KIND_INTERNAL",
        start_time: new Date().toISOString(),
        end_time: null,
        status_code: "UNSET",
        status_message: "",
        events: [],
        attributes: {
          [OI.SPAN_KIND]: "TOOL",
          [OI.SESSION_ID]: child.id,
          [OI.METADATA]: writeMetadata(undefined, { awaiting_approval: true }),
        },
      }

      store.mirrorOpen(child.id, tool)

      const decision = desk.ask(
        child.id,
        {
          tool: "bash",
          input: { command: "echo child-approved" },
          trace_id: "t",
          span_id: "approval",
          user_id: "e2e",
          prompt: "work",
          cwd: child.cwd,
        },
        abort.signal,
      )

      await driver.waitFor(/waiting for approval/)
      await viewer.waitFor(/waiting for approval/)
      expect(await viewer.viewport()).not.toMatch(/Allow bash/)
      await host.waitFor(/Allow bash/)
      await host.key("y")
      expect(await decision).toBe("allow")
      store.mirrorOpen(child.id, {
        ...tool,
        attributes: {
          ...tool.attributes,
          [OI.METADATA]: writeMetadata(undefined, { awaiting_approval: false }),
        },
      })
      await s.spans.waitFor("viewer approval status clears", async () =>
        !(await viewer.viewport()).includes("waiting for approval") ? true : undefined,
      )
    } finally {
      abort.abort()
      await host.key("ctrl+c")
      await host.exited()

      for (const running of jobs.list(parent.id)) {
        jobs.claim(running)
        jobs.kill(running)
      }

      jobs.close()
    }
  },
)
