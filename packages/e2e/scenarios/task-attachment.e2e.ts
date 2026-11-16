/**
 * Directly opening a task must attend its delegator, just as /attach does.
 * Live only: parent and task model calls race, and their results name per-run task IDs.
 */
import { readMetadata } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"
import { callBash } from "../src/steps.ts"

scenario(
  "direct task attachment recovers approvals after terminal restart and parent switching",
  {
    needs: ["rex"],
    liveOnly: true,
    approvals: "ask",
    config: new Map([["delegation", "auto"]]),
  },
  async (s) => {
    const parentTerm = await s.tui()

    await parentTerm.waitFor(/Every step is an OpenInference span/)
    await parentTerm.line(
      'Call the delegate tool now with title "approval recovery", isolation "shared" and prompt "Reply with just: ready". ' +
        "Then call no more tools and reply with just: delegated. Whenever a task result arrives, reply with just: noted.",
    )

    const child = await s.spans.waitFor("the task header", () =>
      s.spans
        .sessions()
        .map((id) => s.spans.store.readHeader(id))
        .find((header) => header?.task !== undefined),
    )

    const parent = child.parent!.session_id
    const task = child.task!.id

    await s.spans.settledTurns(child.id, 1)
    await s.spans.settledTurns(parent, 2)
    await parentTerm.line("/quit")
    expect(await parentTerm.exited()).toBe(0)

    // No parent has been hosted in this process: -s opens the attachment directly.
    const direct = await s.tui(["-s", child.id])

    await direct.waitFor(new RegExp(`task ${task} · /detach to return`))
    await direct.line(`${callBash("echo recovered-approval")} Then reply with just: done.`)
    await direct.waitFor(/Allow bash[\s\S]*echo recovered-approval/, 30_000)
    expect(s.spans.waiting(child.id)).toHaveLength(1)

    // The approval modal does not accept /quit. Closing its terminal must not answer it or kill the runner.
    await direct.close()
    expect(s.spans.waiting(child.id)).toHaveLength(1)

    const restarted = await s.tui(["-s", child.id])

    await restarted.waitFor(/Allow bash[\s\S]*echo recovered-approval/, 30_000)
    await restarted.key("y")
    await s.spans.settledTurns(child.id, 2)

    const allowed = s.spans.tools(child.id).filter((call) => call.name === "bash")

    expect(allowed).toHaveLength(1)
    expect(allowed[0]?.output).toContain("recovered-approval")
    expect(readMetadata(allowed[0]!.span).approval?.decision).toBe("allow")
    // Wait for the runner's result before sending more work: one runner can batch several prompts.
    await s.spans.settledTurns(parent, 3)

    // Keep the same approval owner across detach/attach, without re-running the task or duplicating requests.
    await restarted.line("/detach")
    await restarted.waitFor(new RegExp(`session ${parent.slice(0, 13)}`))
    await restarted.line(`/attach ${task}`)
    await restarted.waitFor(new RegExp(`task ${task} · /detach to return`))
    await restarted.line(`${callBash("echo denied-approval")} Then reply with just: done.`)
    await restarted.waitFor(/Allow bash[\s\S]*echo denied-approval/, 30_000)
    await restarted.key("n")
    await s.spans.settledTurns(child.id, 3)

    const calls = s.spans.tools(child.id).filter((call) => call.name === "bash")

    expect(calls).toHaveLength(2)
    expect(readMetadata(calls[1]!.span).approval?.decision).toBe("deny")
    expect(s.spans.waiting(child.id)).toHaveLength(0)
    await restarted.line("/detach")
    await restarted.waitFor(new RegExp(`session ${parent.slice(0, 13)}`))
    await s.spans.settledTurns(parent, 4)
    expect(s.spans.turns(parent).flatMap((turn) => readMetadata(turn.root).delivers ?? [])).toHaveLength(3)
    await restarted.line("/quit")
    expect(await restarted.exited()).toBe(0)
  },
)
