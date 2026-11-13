/**
 * Web search and fetch (issue #13), from its acceptance list.
 *
 * Custom `web_fetch` is exercised on the main (OpenAI Responses) model,
 * which has built-in search but no built-in fetch, against the local
 * fixture site, so the scenario sees exactly what was requested. Built-in
 * search runs on Anthropic and needs the real web and a live model.
 */
import { OI, stringAttr } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { FAKE_SECRET, serveWeb } from "../src/fakes.ts"
import { expectOk, MODELS, scenario } from "../src/scenario.ts"

describe("web", () => {
  scenario(
    "web_fetch prefers a page's markdown and needs no approval",
    { pending: 13 },
    async ({ run, spans }) => {
      const web = await serveWeb()

      try {
        // No --yolo: `oi run` denies mutating tools, so a fetch that needed approval would fail.
        const result = await run([
          "run",
          `Use web_fetch to read ${web.url}/docs/page and tell me the widget's default port. Reply with just the number.`,
        ])

        expectOk(result)
        expect(result.stdout).toContain("7319")

        const fetches = spans.tools(spans.onlySession()).filter((tool) => tool.name === "web_fetch")

        expect(fetches.length).toBeGreaterThan(0)
        expect(fetches[0]?.output).not.toMatch(/<html/i)
        expect(fetches[0]?.span.attributes[OI.METADATA]).toMatch(/"web":\{[^}]*"format":"markdown"/)

        // It asked for markdown: the .md variant, or Accept: text/markdown.
        const markdown = web.requests.some(
          (request) =>
            request.url.endsWith(".md") || String(request.headers["accept"]).includes("text/markdown"),
        )

        expect(markdown).toBe(true)
      } finally {
        await web.close()
      }
    },
  )

  scenario(
    "secrets are redacted from fetched pages and from outgoing URLs",
    { pending: 13 },
    async ({ run, spans }) => {
      const web = await serveWeb()

      try {
        expectOk(await run(["run", `Use web_fetch on ${web.url}/secret and summarize it in one sentence.`]))

        // The secret is in the prompt (oi does not scrub what the user types), so the
        // model may well put it in the URL; the fetch must neither send nor record it.
        expectOk(
          await run([
            "run",
            `Use web_fetch on ${web.url}/docs/page?key=${FAKE_SECRET} and summarize it in one sentence.`,
          ]),
        )

        const fetches = spans
          .sessions()
          .flatMap((session) => spans.tools(session))
          .filter((tool) => tool.name === "web_fetch")

        expect(fetches.length).toBeGreaterThanOrEqual(2)
        expect(web.requests.map((request) => request.url).join("\n")).not.toContain(FAKE_SECRET)
        expect(JSON.stringify(fetches.map((tool) => tool.span))).not.toContain(FAKE_SECRET)
      } finally {
        await web.close()
      }
    },
  )

  scenario(
    "built-in search on Anthropic is traced as RETRIEVER children of the LLM span",
    { model: MODELS.anthropic, pending: 13, liveOnly: true },
    async ({ run, spans }) => {
      const result = await run([
        "run",
        "Search the web for the latest released version of Node.js and tell me the version number.",
      ])

      expectOk(result)

      const session = spans.onlySession()
      const llm = spans.ofKind(session, "LLM")

      expect(llm.some((span) => (stringAttr(span, OI.OUTPUT_VALUE) ?? "").includes("server_tool_use"))).toBe(
        true,
      )

      // By the raw attribute: SpanKind has no RETRIEVER yet, so kindOf would say CHAIN.
      const retrievers = spans.ended(session).filter((span) => span.attributes[OI.SPAN_KIND] === "RETRIEVER")

      expect(retrievers.length).toBeGreaterThan(0)
      expect(
        retrievers.every((span) => llm.some((parent) => parent.context.span_id === span.parent_id)),
      ).toBe(true)
      expect(retrievers[0]?.attributes["retrieval.documents.0.document.id"]).toMatch(/^https?:\/\//)
      expect(retrievers[0]?.attributes[OI.METADATA]).toMatch(/"synthesized":true/)
    },
  )

  scenario(
    "after a built-in search, switching to OpenAI keeps the results as text",
    { model: MODELS.anthropic, needs: ["rex"], pending: 13, liveOnly: true },
    async ({ tui, spans }) => {
      const term = await tui()

      await term.waitFor(/›/)
      await term.line(
        "Search the web for the latest released version of Node.js. Reply with just the version.",
      )

      const session = await spans.waitFor("a session", () => spans.sessions()[0])

      await spans.settledTurns(session, 1)
      await term.line(`/model ${MODELS.main}`)
      await term.waitFor(/Model is now/)
      await term.line("Which URLs did that search return? List them.")
      await spans.settledTurns(session, 2)

      const request = spans.ofKind(session, "LLM").at(-1)

      expect(spans.modelOf(request!).model).toBe(MODELS.main)
      expect(stringAttr(request!, OI.INPUT_VALUE)).toContain("[web search:")
    },
  )
})
