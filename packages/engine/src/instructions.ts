/**
 * Instruction files (AGENTS.md, CLAUDE.md) and skills that other coding
 * agents use, found so the system prompt can point the model at them.
 *
 * Only paths and each skill's front matter go in the prompt. The model reads
 * the files itself with read_file, so what it took in shows up as TOOL spans,
 * and nothing it reads needs a bash approval. The listing changes only when
 * such files are added or removed, which keeps the prompt cache prefix stable.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Names checked in each directory, in the order to list them when several sit side by side. */
const INSTRUCTION_NAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"]

const SKILL_DIRS = [path.join(".agents", "skills"), path.join(".claude", "skills")]

export interface Skill {
  readonly name: string
  readonly description: string
  /** The skill's SKILL.md. */
  readonly file: string
}

export interface Instructions {
  /** Instruction files, nearest first; user-level ones last. */
  readonly files: ReadonlyArray<string>
  readonly skills: ReadonlyArray<Skill>
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile()
  } catch {
    // Missing, or unreadable (a sandbox may deny it): either way, not there for us.
    return false
  }
}

const listDir = (dir: string): ReadonlyArray<string> => {
  try {
    return fs.readdirSync(dir).toSorted()
  } catch {
    return []
  }
}

/** The nearest directory at or above `cwd` holding `.git` (a directory, or a file in a worktree). */
export const repoRoot = (cwd: string): string | undefined => {
  let dir = path.resolve(cwd)

  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir

    const parent = path.dirname(dir)

    if (parent === dir) return undefined

    dir = parent
  }
}

/** `cwd` and each parent up to the repository root; just `cwd` outside a repository. */
const projectDirs = (cwd: string): ReadonlyArray<string> => {
  const root = repoRoot(cwd)
  const dirs = [path.resolve(cwd)]

  if (root === undefined) return dirs

  while (dirs.at(-1) !== root) dirs.push(path.dirname(dirs.at(-1) ?? root))

  return dirs
}

/** The value of `key:` in a SKILL.md's front matter, unquoted. */
const frontMatterValue = (lines: ReadonlyArray<string>, key: string): string | undefined => {
  const line = lines.find((candidate) => candidate.startsWith(`${key}:`))

  return line
    ?.slice(key.length + 1)
    .trim()
    .replaceAll(/^["']|["']$/g, "")
}

const readSkill = (file: string): Skill | undefined => {
  let text: string

  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }

  const lines = text.split("\n")
  const end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1
  const header = end > 0 ? lines.slice(1, end) : []

  return {
    name: frontMatterValue(header, "name") ?? path.basename(path.dirname(file)),
    description: frontMatterValue(header, "description") ?? "(no description)",
    file,
  }
}

export const findInstructions = (cwd: string, home: string = os.homedir()): Instructions => {
  const dirs = projectDirs(cwd)
  const userFiles = [path.join(home, ".claude", "CLAUDE.md"), path.join(home, ".config", "AGENTS.md")]

  const files = [
    ...dirs.flatMap((dir) => INSTRUCTION_NAMES.map((name) => path.join(dir, name))),
    ...userFiles,
  ].filter((file) => isFile(file))

  // Skills live at the top of a project (or in the working directory) and in the home directory.
  const skillRoots = [...new Set([path.resolve(cwd), dirs.at(-1) ?? path.resolve(cwd), home])]

  const skillFiles = skillRoots.flatMap((root) =>
    SKILL_DIRS.flatMap((skillDir) =>
      listDir(path.join(root, skillDir)).map((name) => path.join(root, skillDir, name, "SKILL.md")),
    ),
  )

  const skills = [...new Set(skillFiles)].flatMap((file) => {
    const skill = isFile(file) ? readSkill(file) : undefined

    return skill === undefined ? [] : [skill]
  })

  return { files, skills }
}

/** The system prompt section, or undefined when there is nothing to point at. */
export const instructionsSection = (found: Instructions): string | undefined => {
  if (found.files.length === 0 && found.skills.length === 0) return undefined

  const parts = ["Project instructions and skills:"]

  if (found.files.length > 0) {
    parts.push(
      [
        "The user keeps instructions for coding agents in the files below. At the start of the session, before any other tool call, read each of them with read_file, then follow them. Nearer files take precedence over farther ones and over the user-level ones in your home directory; where AGENTS.md and CLAUDE.md sit side by side and disagree, follow AGENTS.md; the user's explicit requests take precedence over all of them. Once read, they stay in this conversation: do not read them again unless the user asks.",
        ...found.files.map((file) => `- ${file}`),
      ].join("\n"),
    )
  }

  if (found.skills.length > 0) {
    parts.push(
      [
        "Skills: each is a SKILL.md with instructions for one kind of task. When a task matches a skill's description, read its SKILL.md in full with read_file (and any files it points to) before doing the task, and follow it. Do not read skills that do not match the task.",
        ...found.skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.file})`),
      ].join("\n"),
    )
  }

  return parts.join("\n")
}
