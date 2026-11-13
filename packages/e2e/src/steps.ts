/**
 * Steps several scenarios share.
 */
import type { Scenario } from "./scenario.ts"
import type { Terminal } from "./term.ts"

/**
 * A prompt that gets a model to call bash. Models often ask in prose whether
 * they may run something; saying that oi does the asking stops that.
 */
export const callBash = (command: string): string =>
  `Call the bash tool now with the command \`${command}\`. Don't ask me first: oi asks me itself.`

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/**
 * Wait for oi's approval prompt for a bash `command` and return the screen.
 * Fails at once if the turn that asked for it ends without calling the tool,
 * so a model answering in prose reads as that, not as a timeout.
 */
export const awaitApproval = (s: Scenario, term: Terminal, command: string): Promise<string> => {
  const prompt = new RegExp(`Allow bash[\\s\\S]*${escapeRegExp(command)}`)

  return s.spans.waitFor(`oi to ask before running ${command}`, async () => {
    const screen = await term.screen()

    if (prompt.test(screen)) return screen

    for (const session of s.spans.sessions()) {
      const turn = s.spans.turns(session).at(-1)

      if (turn !== undefined && turn.state !== "running" && turn.input.includes(command))
        throw new Error(
          `The model answered without calling bash for ${command}: ${turn.output ?? "(no output)"}`,
        )
    }

    return undefined
  })
}
