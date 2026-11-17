/**
 * `oi run`: one prompt, no terminal. The cheapest check that a turn works
 * end to end and is recorded as the expected span tree.
 */
import { kindOf, OI, readMetadata, stringAttr } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, MODELS, scenario } from "../src/scenario.ts"

describe("oi run", () => {
  scenario("answers and records one AGENT turn with an LLM child", {}, async ({ run, spans }) => {
    const result = await run(["run", "Reply with exactly the word: pong"])

    expectOk(result)
    expect(result.stdout.toLowerCase()).toContain("pong")
    expect(result.stdout).not.toContain("\u001B]7501;")

    const session = spans.onlySession()
    const [turn] = await spans.settledTurns(session, 1)

    expect(turn?.state).toBe("complete")

    const kinds = spans.trace(session, turn?.trace_id ?? "").map(kindOf)

    expect(kinds).toContain("AGENT")
    expect(kinds).toContain("LLM")
    expect(spans.lastModel(session)?.model).toBe(MODELS.main)

    // The provider id is oi's name for a way of reaching models. Live, the default is the ChatGPT
    // plan sign-in: OpenAI serves it and the plan pays. Replayed, it is OpenAI's API by key.
    const provider = MODELS.main.split("/")[0]
    const llm = spans.ofKind(session, "LLM")[0]

    expect(["chatgpt", "openai"]).toContain(provider)
    expect(llm === undefined ? undefined : stringAttr(llm, OI.LLM_PROVIDER)).toBe("openai")
    expect(llm === undefined ? undefined : stringAttr(llm, OI.LLM_SYSTEM)).toBe("openai")
    expect(llm === undefined ? undefined : readMetadata(llm)).toMatchObject({
      provider,
      billing: provider === "chatgpt" ? "plan" : "api",
    })
  })

  scenario("reads a file with a tool and answers from it", {}, async ({ run, spans }) => {
    const result = await run(["run", "Use read_file on answer.txt, then tell me the magic number."])

    expectOk(result)
    expect(result.stdout).toContain("4817")

    const session = spans.onlySession()
    const reads = spans.tools(session).filter((tool) => tool.name === "read_file")

    expect(reads.length).toBeGreaterThan(0)
    expect(reads[0]?.input).toContain("answer.txt")
  })
})
