import { expect } from "vite-plus/test"
import { serveWeb } from "../src/fakes.ts"
import { scenario } from "../src/scenario.ts"
import { awaitApproval, callBash } from "../src/steps.ts"
import type { Terminal } from "../src/term.ts"
import type { Scenario } from "../src/scenario.ts"

const status = (s: Scenario, term: Terminal, state: string) =>
  s.spans.waitFor(`terminal status ${state}`, async () =>
    (await term.programStatus()).find((record) => record.app === "oi" && record.state === state),
  )

scenario("reports program status to Rex", { needs: ["rex"] }, async (s) => {
  const term = await s.tui(["--yolo"])

  await term.waitFor(/Every step is an OpenInference span/)
  // A real sleeping tool keeps working observable even with instantaneous replayed model replies.
  await term.line(callBash("sleep 3; echo initial-work"))
  await status(s, term, "working")
  const session = s.spans.onlySession()

  await s.spans.settledTurns(session, 1)
  await status(s, term, "done")
  await term.key("tab")
  await term.line(callBash("sleep 3; echo status-complete"))
  await awaitApproval(s, term, "sleep 3; echo status-complete")
  const blocked = await status(s, term, "blocked")

  expect(blocked.kind).toBe("permission")
  expect(blocked.msg).toContain("sleep 3")
  await term.key("y")
  await status(s, term, "working")
  await s.spans.settledTurns(session, 2)
  await status(s, term, "done")
  await term.send("x")
  await status(s, term, "idle")
  await term.key("ctrl+u")
  await term.line(callBash("sleep 30"))
  await awaitApproval(s, term, "sleep 30")
  await term.key("y")
  await status(s, term, "working")
  await term.key("escape")
  await status(s, term, "idle")
  await s.spans.waitFor("interrupted turn", () =>
    s.spans.turns(session).at(-1)?.state === "interrupted" ? true : undefined,
  )
  await term.line("/quit")
  expect(await term.exited()).toBe(0)
  expect(await term.programStatus()).toEqual([])
})

scenario("oi run leaves a completed terminal status", { needs: ["rex"] }, async (s) => {
  const term = await s.tui(["run", "Reply with exactly the word: pong"])

  expect(await term.exited(60_000)).toBe(0)
  const done = await status(s, term, "done")

  expect(done.msg?.toLowerCase()).toContain("pong")
})

scenario("reports a failed turn to Rex", { needs: ["rex"] }, async (s) => {
  // A local website is not a model endpoint: its 404 is a deterministic provider failure.
  const web = await serveWeb()

  try {
    const term = await s.tui(["-m", "openai/gpt-5.6-luna"], {
      env: new Map([
        ["OPENAI_API_KEY", "e2e-not-a-real-key"],
        ["OPENAI_BASE_URL", web.url],
        ["OI_AGENT_OPENAI_TRANSPORT", "http"],
      ]),
    })

    await term.waitFor(/Every step is an OpenInference span/)
    await term.line("Reply with exactly the word: pong")
    const failed = await status(s, term, "error")

    expect(failed.msg).toBe("openai: not found")
    expect(s.spans.turns(s.spans.onlySession()).at(-1)?.root.status_message).toBe(failed.msg)
    await term.send("x")
    await status(s, term, "idle")
    await term.key("ctrl+u")
    await term.line("/quit")
    expect(await term.exited()).toBe(0)
    expect(await term.programStatus()).toEqual([])
  } finally {
    await web.close()
  }
})
