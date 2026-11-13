import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { findInstructions, instructionsSection } from "../src/index.ts"

const tree = (files: ReadonlyArray<readonly [string, string]>): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oi-instructions-")))

  for (const [file, text] of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }

  return root
}

const skill = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: "${description}"\n---\n\nBody of ${name}.\n`

describe("instruction files and skills", () => {
  it("finds instruction files from the working directory up to the repository root, nearest first", () => {
    const root = tree([
      ["outside/CLAUDE.md", "not in the repo"],
      ["outside/repo/AGENTS.md", "root"],
      ["outside/repo/CLAUDE.md", "root, claude"],
      ["outside/repo/pkg/AGENT.md", "package"],
      ["home/.claude/CLAUDE.md", "user"],
    ])

    const repo = path.join(root, "outside", "repo")

    execFileSync("git", ["init", "-q"], { cwd: repo })

    const found = findInstructions(path.join(repo, "pkg"), path.join(root, "home"))

    expect(found.files).toEqual([
      path.join(repo, "pkg", "AGENT.md"),
      path.join(repo, "AGENTS.md"),
      path.join(repo, "CLAUDE.md"),
      path.join(root, "home", ".claude", "CLAUDE.md"),
    ])
  })

  it("looks only in the working directory outside a repository", () => {
    const root = tree([
      ["CLAUDE.md", "parent"],
      ["here/AGENTS.md", "here"],
    ])

    expect(findInstructions(path.join(root, "here"), path.join(root, "nohome")).files).toEqual([
      path.join(root, "here", "AGENTS.md"),
    ])
  })

  it("lists project and user skills by their front matter", () => {
    const root = tree([
      ["project/.claude/skills/release-notes/SKILL.md", skill("release-notes", "Use for release notes.")],
      ["project/.agents/skills/sql-style/SKILL.md", skill("sql-style", "Use for SQL.")],
      ["project/.agents/skills/bare/SKILL.md", "No front matter."],
      ["project/.agents/skills/empty/README.md", "not a skill"],
      ["home/.claude/skills/rex/SKILL.md", skill("rex", "Use for terminals.")],
    ])

    const found = findInstructions(path.join(root, "project"), path.join(root, "home"))

    expect(found.skills.map((s) => [s.name, s.description])).toEqual([
      ["bare", "(no description)"],
      ["sql-style", "Use for SQL."],
      ["release-notes", "Use for release notes."],
      ["rex", "Use for terminals."],
    ])

    const section = instructionsSection(found) ?? ""

    expect(section).toContain(
      `- sql-style: Use for SQL. (${path.join(root, "project", ".agents", "skills", "sql-style", "SKILL.md")})`,
    )
    // The prompt points at skills; their bodies stay out of it.
    expect(section).not.toContain("Body of")
  })

  it("adds nothing to the prompt when there is nothing to find", () => {
    const root = tree([])

    expect(instructionsSection(findInstructions(root, root))).toBeUndefined()
  })
})
