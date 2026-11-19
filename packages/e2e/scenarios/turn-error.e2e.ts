import { expect } from "vite-plus/test"
import { serveWeb } from "../src/fakes.ts"
import { scenario } from "../src/scenario.ts"

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

scenario("a failed turn shows its error once", { needs: ["rex"] }, async (s) => {
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
    await term.waitFor(/⎿ error: openai: not found/)
    const session = s.spans.onlySession()
    const [turn] = await s.spans.settledTurns(session, 1)

    expect(turn?.root.status_code).toBe("ERROR")
    const message = turn?.root.status_message ?? ""

    expect(message).toBe("openai: not found")
    // A command's output is committed after anything the failed submit printed: a barrier, not a sleep.
    await term.line("/session")
    const screen = await term.waitFor(/Resume: oi -s/)

    expect(screen).toContain(`⎿ error: ${message}`)
    expect(occurrences(screen, message)).toBe(1)
    await term.line("/quit")
    expect(await term.exited()).toBe(0)
  } finally {
    await web.close()
  }
})
