import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { TurnEnv } from "../src/agent.ts"
import { jobsOf } from "../src/jobs.ts"
import { Redactor } from "../src/redact.ts"
import { Store } from "../src/store.ts"
import { Tasks } from "../src/tasks.ts"
import { builtinTools, type ToolContext, type ToolSpec } from "../src/tools.ts"

/** A store in a fresh temporary directory. */
export const tempStore = (): Store => new Store(fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-test-")))

/** Every file under a directory, as sorted paths relative to it. */
export const tree = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort()

/** The models a test session's subagents would run on. */
export const MODELS: ToolContext["models"] = () => ({ default: "scripted/scripted", cheap: "" })

/** A session in a fresh store, ready for `runTurn`. */
export const tempEnv = (
  tools: ReadonlyArray<ToolSpec> = builtinTools,
  cwd: string = fs.mkdtempSync(path.join(os.tmpdir(), "oi-agent-cwd-")),
): TurnEnv => {
  const store = tempStore()
  const jobs = jobsOf(store)

  return {
    store,
    sessionId: store.createSession(cwd).id,
    cwd,
    tools,
    jobs,
    tasks: new Tasks(store, jobs, {}),
    models: MODELS,
    redactor: new Redactor(),
  }
}

/** Bytes that start like a PNG and differ by `seed`: all an attachment's checks look at. */
export const png = (seed: string): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)])
