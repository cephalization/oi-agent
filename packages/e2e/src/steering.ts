/**
 * The steering cases and how one is run, shared by the pass/fail scenarios
 * (`scenarios/steering.e2e.ts`) and the scored experiment
 * (`scenarios/steering.scored.ts`).
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { parser, projectDir } from "@oi-agent/engine"
import { Schema } from "effect"
import { expectOk, type Sample } from "./scenario.ts"

export interface Case {
  /** A first prompt that sets up something to correct. */
  readonly setup: string
  readonly steer: string
}

/** Corrections that apply beyond the current task: each should become an evaluator. */
export const DURABLE: ReadonlyArray<Case> = [
  {
    setup: "What command installs this project's dependencies? Reply with just the command.",
    steer: "From now on, always use pnpm instead of npm in this project.",
  },
  {
    setup: "Add a one-line comment above greet in src/greet.js.",
    steer: "Don't add comments like that to my code, ever. Keep it uncommented.",
  },
]

/** Durable, but implicit, and worded unlike anything in the system prompt (held out). */
export const IMPLICIT: ReadonlyArray<Case> = [
  {
    setup: "Show me the contents of src/greet.js.",
    steer: "you don't need to print whole files back at me, it's just noise. a summary is fine.",
  },
  {
    setup: "Add a function farewell(name) to src/greet.js that returns a goodbye string.",
    steer: "hmm, var? it's not 2010. this codebase is const/let only.",
  },
  {
    setup: "Explain what src/greet.js does in two sentences.",
    steer: "bit wordy again. I prefer answers short and to the point.",
  },
  {
    setup: "Write a one-line description of this project for its README. Reply with just the line.",
    steer:
      "you keep writing these like marketing copy. plain and factual, please, for anything you write here.",
  },
]

/** Product behavior is the task to fix, not a preference for how the coding agent works. */
export const PRODUCT_BUGS: ReadonlyArray<Case> = [
  {
    setup:
      "We are developing a coding-agent CLI with configurable decision models and auto/ask/yolo permission modes. Summarize those features in one sentence without using tools.",
    steer:
      "i asked that question in auto mode and it still asked for permission to run bash and switched to yolo after",
  },
  {
    setup: "We are debugging a text editor's settings screen. Reply with just: ready",
    steer: "the preview pane keeps reopening after I close it; the app should remember that it was closed",
  },
  {
    setup: "We are implementing a CSV export button in a web app. Reply with just: ready",
    steer: "the download still repeats the column headings on every row, that needs fixing",
  },
]

/** Corrections about this task only: none should become an evaluator. */
export const ONE_OFF: ReadonlyArray<Case> = [
  ...PRODUCT_BUGS,
  {
    setup: "Suggest a new name for the greet function. Reply with just the name.",
    steer: "No, call it sayHello for this change.",
  },
  {
    setup: "What does src/greet.js export? One sentence.",
    steer: "Shorter, please. Just the function name.",
  },
  {
    setup: "Write an error message for when the name passed to greet is empty. Reply with just the message.",
    steer: "make that friendlier, it sounds like a stack trace.",
  },
  {
    setup: "Suggest a variable name for the greeting text inside greet. Reply with just the name.",
    steer: "no, too long. use msg here.",
  },
  {
    setup: "Add a function farewell(name) to src/greet.js that returns a goodbye string.",
    steer: "actually say 'See you' instead of 'Goodbye' in that one.",
  },
  {
    setup: "Write a one-line description of this project for its README. Reply with just the line.",
    steer: "can you make that one a bit more formal?",
  },
]

/** Evaluator files for this project and the user, by name. */
const evalFiles = (s: Sample): Array<string> => {
  const env = { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }
  const dirs = [path.join(projectDir(s.sandbox.cwd, env), "evals"), path.join(s.sandbox.configDir, "evals")]

  return dirs.flatMap((dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : [],
  )
}

const parseOrigin = parser(
  Schema.Struct({ origin: Schema.optionalKey(Schema.Struct({ kind: Schema.String })) }),
)

/** An evaluator a case left behind. */
export interface Learned {
  /** The evaluator's file name. */
  readonly file: string
  /**
   * Who wrote it: the steering detector, or the agent itself with
   * `create_eval`, which it sometimes does for the same correction.
   */
  readonly producer: "detector" | "agent"
}

const describe = (file: string): Learned => {
  const definition = parseOrigin(fs.readFileSync(file, "utf8"))

  if (definition === undefined) throw new Error(`${file} is not an evaluator definition`)

  return {
    file: path.basename(file),
    producer: definition.origin?.kind === "steering" ? "detector" : "agent",
  }
}

/** Run one case in a fresh session; return the evaluators it created, then remove them unless `retain`. */
export const learned = async (s: Sample, entry: Case, retain = false): Promise<Array<Learned>> => {
  // Rules learned in an earlier case go into every later system prompt: start each case without them.
  fs.rmSync(path.join(projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir }), "rules.md"), {
    force: true,
  })

  const before = new Set(evalFiles(s))
  const first = await s.run(["run", entry.setup])

  expectOk(first)

  const session = s.spans.sessions().at(-1) ?? ""
  const second = await s.run(["run", "-s", session, entry.steer])

  expectOk(second)

  const files = evalFiles(s).filter((file) => !before.has(file))
  const created = files.map(describe)

  if (!retain) for (const file of files) fs.rmSync(file)

  return created
}
