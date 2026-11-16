import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { OI } from "@oi-agent/engine"
import { Option, Schema } from "effect"
import type { Sample } from "./scenario.ts"

export const CASES = [
  "quick-edit",
  "independent-investigations",
  "dirty-dependency",
  "warm-dependencies",
] as const

export type QualityCase = (typeof CASES)[number]

export const modeOf = (kind: QualityCase): string => {
  switch (kind) {
    case "quick-edit":
      return "quick"
    case "dirty-dependency":
      return "dirty"
    default:
      return "warm"
  }
}

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

/** No AGENTS file or delegation instructions: these are ordinary work requests. */
export const prepare = (s: Sample, kind: QualityCase): string => {
  const put = (file: string, text: string): void => {
    const target = path.join(s.sandbox.cwd, file)

    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }

  put(".gitignore", "node_modules/\n")
  put("label.txt", "recieve\n")
  put("price.cjs", "module.exports = { cents: 100, currency: 'USD' }\n")
  put(
    "verify.cjs",
    `const assert = require('node:assert/strict'); const fs = require('node:fs');\nconst mode = process.argv[2];\nif (mode === 'quick') assert.equal(fs.readFileSync('label.txt','utf8').trim(), 'receive');\nif (mode === 'dirty') { const p = require('./price.cjs'); assert.equal(p.cents, 725); assert.equal(p.currency, 'EUR'); }\nif (mode === 'warm') assert.equal(require('local-rate').value, 42);\nconsole.log('VERIFIED:' + mode);\n`,
  )

  for (const [index, name] of ["east", "west"].entries()) {
    const records = Array.from({ length: 300 }, (_, n) => ({
      status: n % (index + 3) === 0 ? 503 : 200,
      backend: n % (index + 3) === 0 ? `${name}-cache` : `${name}-api`,
    }))

    put(`${name}.json`, JSON.stringify(records))
  }

  git(s.sandbox.cwd, "add", "-A")
  git(
    s.sandbox.cwd,
    "-c",
    "user.name=e2e",
    "-c",
    "user.email=e2e@example.invalid",
    "commit",
    "-qm",
    "quality fixture",
  )

  if (kind === "dirty-dependency") put("price.cjs", "module.exports = { cents: 725, currency: 'USD' }\n")

  if (kind === "warm-dependencies") put("node_modules/local-rate/index.js", "exports.value = 42;\n")

  const report =
    " Report the observed command and its result, including the verification marker; do not claim checks you did not run."

  switch (kind) {
    case "quick-edit":
      return (
        "Fix the spelling in label.txt and run node verify.cjs quick. Leave the change in this checkout." +
        report
      )
    case "dirty-dependency":
      return (
        "Change price.cjs currency to EUR, preserving my uncommitted cents change. Run node verify.cjs dirty against the resulting working copy. Do not commit or discard my work." +
        report
      )
    case "warm-dependencies":
      return (
        "Check the installed local-rate package with node verify.cjs warm. Dependencies are already installed here but provisioning a fresh checkout is expensive and unavailable offline. Do not install or download anything and do not change files." +
        report
      )
    case "independent-investigations":
      return "Investigate east.json and west.json separately: for each, count 503 responses and identify the backend responsible. Use executable checks on the data, not guesses; do not change files. Finish with one consolidated summary of both counts and backends, with the commands that produced them. Include a JSON object with east and west keys, each containing errors (a number) and backend (a string)."
  }
}

/** Numeric usage is read only from LLM spans, never double counted from roots. */
export const tokens = (s: Sample): number =>
  s.spans
    .sessions()
    .flatMap((id) => s.spans.ofKind(id, "LLM"))
    .reduce((sum, span) => {
      const prompt = span.attributes[OI.TOKENS_PROMPT]
      const completion = span.attributes[OI.TOKENS_COMPLETION]

      return sum + (Number(prompt) || 0) + (Number(completion) || 0)
    }, 0)

export const verifyWorkingCopy = (s: Sample, kind: QualityCase): boolean => {
  if (kind === "independent-investigations") return git(s.sandbox.cwd, "status", "--porcelain") === ""

  try {
    // Independent oracle: never trust the agent-editable verification script.
    const checks = new Map([
      ["quick-edit", "assert.equal(fs.readFileSync('label.txt','utf8').trim(), 'receive')"],
      [
        "dirty-dependency",
        "const p = require('./price.cjs'); assert.equal(p.cents,725); assert.equal(p.currency,'EUR')",
      ],
      ["warm-dependencies", "assert.equal(require('local-rate').value,42)"],
    ])

    execFileSync(
      "node",
      [
        "-e",
        `const assert = require('node:assert/strict'); const fs = require('node:fs'); ${checks.get(kind)}`,
      ],
      { cwd: s.sandbox.cwd, stdio: "pipe" },
    )

    const allowed = kind === "quick-edit" ? "label.txt" : "price.cjs"
    const changed = git(s.sandbox.cwd, "diff", "--name-only").split("\n").filter(Boolean)

    const untouchedCheck =
      fs.readFileSync(s.sandbox.file("verify.cjs"), "utf8") ===
      git(s.sandbox.cwd, "show", "HEAD:verify.cjs") + "\n"

    const noCommit = git(s.sandbox.cwd, "log", "-1", "--format=%s") === "quality fixture"

    return (
      untouchedCheck &&
      noCommit &&
      (kind === "warm-dependencies" ? changed.length === 0 : changed.length === 1 && changed[0] === allowed)
    )
  } catch {
    return false
  }
}

const Region = Schema.Struct({ errors: Schema.Number, backend: Schema.String })

const decodeReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ east: Region, west: Region })),
)

/** Validate the association, not just the presence of four unrelated strings. */
export const reportedInvestigations = (text: string): boolean => {
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1] ?? "")

  candidates.push(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))

  return candidates.some((json) =>
    Option.match(decodeReport(json), {
      onNone: () => false,
      onSome: (report) =>
        report.east.errors === 100 &&
        report.east.backend === "east-cache" &&
        report.west.errors === 75 &&
        report.west.backend === "west-cache",
    }),
  )
}
