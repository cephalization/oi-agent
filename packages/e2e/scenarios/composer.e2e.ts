import { expect } from "vite-plus/test"
import { scenario } from "../src/scenario.ts"

scenario(
  "keeps typing that arrives in the same PTY write as Enter or Escape",
  { needs: ["rex"] },
  async (s) => {
    const term = await s.tui()

    await term.waitFor(/^›\s*$/m)
    // A local slash command, so no model call is needed.
    await term.send("/session\rNEXT DRAFT")
    await term.waitFor(/^› NEXT DRAFT\s*$/m, 5_000)
    expect(await term.screen()).toContain("Resume: oi -s")

    // Rex emits CSI 27 u for Escape in modified-key mode, but sends Shift+letters as plain text.
    await term.send("\u001B[27u UPPER")
    await term.waitFor(/^› NEXT DRAFT UPPER\s*$/m, 5_000)

    await term.key("ctrl+u")
    await term.line("/quit")
    expect(await term.exited()).toBe(0)
  },
)
