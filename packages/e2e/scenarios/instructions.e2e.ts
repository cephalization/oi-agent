/**
 * Project instruction files and skills (issue #9). The fixture repo has a
 * CLAUDE.md whose marker the agent must repeat, a `release-notes` skill in
 * `.claude/skills` and a `sql-style` skill in `.agents/skills`.
 *
 * The system prompt must stay byte-identical across turns, since a
 * stable prompt is what keeps prompt caching working.
 */
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect } from "vite-plus/test"
import { expectOk, scenario } from "../src/scenario.ts"
import type { ToolCall } from "../src/spans.ts"

/** Whether a tool call reads a file whose path ends with `suffix` (by read_file, or cat/head/sed in bash). */
const reads = (tool: ToolCall, suffix: string): boolean =>
  (tool.name === "read_file" || tool.name === "bash") && tool.input.includes(suffix)

describe("instructions and skills", () => {
  scenario("the system prompt is byte-identical across turns", {}, async ({ run, spans }) => {
    expectOk(await run(["run", "Reply with just: one"]))

    const session = spans.onlySession()

    expectOk(await run(["run", "-s", session, "Reply with just: two"]))

    const prompts = spans.ofKind(session, "LLM").map((span) => spans.systemPrompt(span))

    expect(prompts.length).toBeGreaterThanOrEqual(2)
    expect(new Set(prompts).size).toBe(1)
  })

  scenario(
    "reads CLAUDE.md before other work and follows it",
    { fixture: "agents" },
    async ({ run, spans }) => {
      const result = await run(["run", "What does README.md say? Answer in one sentence."])

      expectOk(result)
      expect(result.stdout).toMatch(/-- HALIBUT-7\s*$/)

      const tools = spans.tools(spans.onlySession())
      const instructions = tools.findIndex((tool) => reads(tool, "CLAUDE.md"))
      const readme = tools.findIndex((tool) => reads(tool, "README.md") && !reads(tool, "CLAUDE.md"))

      expect(instructions).toBeGreaterThanOrEqual(0)

      if (readme >= 0) expect(instructions).toBeLessThan(readme)
    },
  )

  scenario(
    "reads a skill in full only when the task matches it",
    { fixture: "agents" },
    async ({ run, spans }) => {
      const notes = await run([
        "run",
        "Write release notes for a change that adds a --verbose flag. Print them only.",
      ])

      expectOk(notes)
      expect(notes.stdout).toContain("## Fresh off the press")

      const session = spans.onlySession()
      const first = spans.tools(session)

      expect(
        first.some((tool) => tool.name === "read_file" && tool.input.includes("release-notes/SKILL.md")),
      ).toBe(true)
      // Discovery may skim front matter, but the unrelated skill is never read in full.
      expect(
        first.some((tool) => tool.name === "read_file" && tool.input.includes("sql-style/SKILL.md")),
      ).toBe(false)

      const before = first.length
      const unrelated = await run(["run", "-s", session, "What is 2 + 2? Reply with just the number."])

      expectOk(unrelated)

      const later = spans.tools(session).slice(before)

      expect(later.filter((tool) => tool.input.includes("SKILL.md"))).toEqual([])
      // Pointing at instruction files and skills must not cost the prompt cache.
      const prompts = new Set(spans.ofKind(session, "LLM").map((span) => spans.systemPrompt(span)))

      expect(prompts.size).toBe(1)

      // The fixture's skills are listed; the developer's own (hidden by the sandbox) are not.
      const [prompt = ""] = prompts

      expect(prompt).toContain("- sql-style: Use when writing or reviewing SQL queries.")
      expect(prompt).not.toContain(path.join(os.homedir(), ".claude"))
      expect(prompt).not.toContain(path.join(os.homedir(), ".agents"))
    },
  )
})
