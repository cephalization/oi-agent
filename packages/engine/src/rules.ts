/**
 * Learned rules: the standing prompt section that evaluators write to.
 *
 * Every change snapshots the previous file first, so any version can be
 * restored. The file lives in the project (`.oi/rules.md`) so it is visible,
 * editable and versioned with the code it applies to.
 */
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { rulesPath } from "./prompt.ts"

export interface Rule {
  readonly text: string
  /** Evaluator that produced the rule. */
  readonly source: string
}

const historyDir = (cwd: string): string => path.join(cwd, ".oi", "rules.history")

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

export const readRules = (cwd: string): string => read(rulesPath(cwd))

/** A short content hash identifying the rules in effect for a turn. */
export const rulesVersion = (cwd: string): string =>
  createHash("sha256").update(readRules(cwd)).digest("hex").slice(0, 12)

const snapshot = (cwd: string): void => {
  const current = readRules(cwd)
  const stamp = new Date().toISOString().replaceAll(":", "-")

  fs.mkdirSync(historyDir(cwd), { recursive: true })
  fs.writeFileSync(path.join(historyDir(cwd), `${stamp}.md`), current)
}

/** Append a rule. Returns the new version. */
export const addRule = (cwd: string, rule: Rule): string => {
  const current = readRules(cwd)
  const text = rule.text.replaceAll("\n", " ").trim()
  const line = `- ${text} <!-- from eval: ${rule.source} -->`

  if (current.includes(`- ${text} <!--`)) return rulesVersion(cwd)

  snapshot(cwd)
  fs.mkdirSync(path.dirname(rulesPath(cwd)), { recursive: true })
  fs.writeFileSync(rulesPath(cwd), `${current.trimEnd()}${current.trim() === "" ? "" : "\n"}${line}\n`)

  return rulesVersion(cwd)
}

export const listRuleVersions = (cwd: string): Array<string> => {
  try {
    return fs.readdirSync(historyDir(cwd)).sort()
  } catch {
    return []
  }
}

/**
 * Restore the rules as they were before the most recent change. The current
 * rules are snapshotted first, so a revert can itself be reverted.
 */
export const revertRules = (cwd: string): boolean => {
  const latest = listRuleVersions(cwd).at(-1)

  if (latest === undefined) return false

  const previous = read(path.join(historyDir(cwd), latest))

  fs.rmSync(path.join(historyDir(cwd), latest))
  fs.writeFileSync(rulesPath(cwd), previous)

  return true
}
