/**
 * Web access (issue #13): oi has no web tools of its own. With `web: auto`
 * a request offers the provider's, which run on the provider's servers
 * inside the model call, so the search is in the `LLM` span's response and
 * nothing here runs or needs approval.
 *
 * Every scenario makes a second model call after the search (a file write, or
 * another turn), so the stored search blocks are replayed to the provider.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { OI, stringAttr } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, MODELS, scenario } from "../src/scenario.ts"

const WEB = new Map([["web", "auto"]])

const SEARCH_THEN_WRITE =
  "Search the web for the release date of Node.js 22.0.0. Then use write_file to save just that date, as YYYY-MM-DD, in node22.txt. Reply with just the date."

describe("web", () => {
  for (const [provider, model, block] of [
    ["Anthropic", MODELS.anthropic, "server_tool_use"],
    ["OpenAI", MODELS.main, "web_search_call"],
  ] as const) {
    scenario(
      `${provider}'s built-in search runs inside the model call and its results are replayed`,
      { model, config: WEB },
      async ({ run, spans, sandbox }) => {
        const result = await run(["run", "--yolo", SEARCH_THEN_WRITE])

        expectOk(result)
        expect(result.stdout).toContain("2024-04-24")
        expect(fs.readFileSync(path.join(sandbox.cwd, "node22.txt"), "utf8")).toContain("2024-04-24")

        const session = spans.onlySession()
        const llm = spans.ofKind(session, "LLM")
        const searched = llm.findIndex((span) => (stringAttr(span, OI.OUTPUT_VALUE) ?? "").includes(block))

        // The search is in a response, and a later request sent it back.
        expect(searched).toBeGreaterThanOrEqual(0)
        expect(llm.length).toBeGreaterThan(searched + 1)
        expect(stringAttr(llm.at(-1)!, OI.INPUT_VALUE)).toContain(block)
        // Nothing ran here: the only tool oi executed is the file write.
        expect(spans.tools(session).map((tool) => tool.name)).toEqual(["write_file"])
      },
    )
  }

  scenario(
    "a search needs no approval, and web: off offers no web tools",
    { model: MODELS.anthropic, config: WEB },
    async ({ run, spans }) => {
      // No --yolo: `oi run` denies anything that needs approval.
      const result = await run([
        "run",
        "Search the web for the release date of Node.js 22.0.0. Reply with just the date, as YYYY-MM-DD.",
      ])

      expectOk(result)
      expect(result.stdout).toContain("2024-04-24")

      const offered = stringAttr(spans.ofKind(spans.onlySession(), "LLM")[0]!, OI.INPUT_VALUE) ?? ""

      expect(offered).toMatch(/"type":"web_search_\d+"/)
      expect(offered).toMatch(/"type":"web_fetch_\d+"/)

      expectOk(await run(["run", "Reply with just the word heron."], new Map([["OI_AGENT_WEB", "off"]])))

      const plain = spans
        .sessions()
        .flatMap((session) => spans.ofKind(session, "LLM"))
        .at(-1)

      expect(stringAttr(plain!, OI.INPUT_VALUE)).not.toMatch(/web_search|web_fetch/)
    },
  )

  scenario(
    "after a built-in search, switching to OpenAI keeps the results as text",
    { model: MODELS.anthropic, needs: ["rex", "second-model"], config: WEB },
    async ({ tui, spans }) => {
      const term = await tui()

      await term.waitFor(/›/)
      await term.line(
        "Search the web for the release date of Node.js 22.0.0. Reply with just the date, as YYYY-MM-DD.",
      )

      const session = await spans.waitFor("a session", () => spans.sessions()[0])

      await spans.settledTurns(session, 1)
      await term.line(`/model ${MODELS.main}`)
      await term.waitFor(/Model is now/)
      await term.line("Which URLs did that search return? List two of them.")
      await spans.settledTurns(session, 2)

      const request = spans.ofKind(session, "LLM").at(-1)

      expect(spans.modelOf(request!).model).toBe(MODELS.main)
      expect(stringAttr(request!, OI.INPUT_VALUE)).toMatch(/\[web_search: .*https?:\/\//)
    },
  )
})
