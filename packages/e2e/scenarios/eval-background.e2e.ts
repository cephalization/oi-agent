/** Real CLI, real agent/judge: a file gate makes pending observable before completion. */
import * as fs from "node:fs"
import * as path from "node:path"
import {
  DEFAULT_JUDGE_MODEL,
  type EndedSpan,
  kindOf,
  OI,
  projectDir,
  readMetadata,
  stringAttr,
} from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import type { RunResult } from "../src/sandbox.ts"
import { expectOk, MODELS, type Scenario, scenario } from "../src/scenario.ts"

const NAME = "background_outcome"
const COMMAND = "until [ -f eval-background-go ]; do sleep 0.2; done; printf 'EVAL_BACKGROUND_OK\\n'"
const START = `Call bash exactly once now with command \`${COMMAND}\` and background true. Then call no more tools and reply that verification is running. Do not poll, cancel, or release the gate. When a background result is delivered later, report it without calling any tools.`

const project = (s: Scenario): string =>
  projectDir(s.sandbox.cwd, { OI_AGENT_CONFIG_DIR: s.sandbox.configDir })

const release = (s: Scenario): void => fs.writeFileSync(s.sandbox.file("eval-background-go"), "")

const seed = (s: Scenario): void => {
  const dir = path.join(project(s), "evals")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${NAME}.json`),
    JSON.stringify(
      {
        name: NAME,
        description: "The original background verification finished successfully.",
        kind: "llm",
        instructions:
          "Pass only if the verification command launched in the original turn finished successfully and printed EVAL_BACKGROUND_OK. A launch, promise, or report that it is still running is not success. If it was killed or canceled, fail. Use the original launch and its attributed outcome evidence.",
        wait_for_background: true,
        applicability: { any: ["tool:bash"] },
        choices: { pass: 1, fail: 0 },
        fail_labels: ["fail"],
        feedback: true,
        learn: true,
      },
      null,
      2,
    ),
  )
}

const verdicts = (s: Scenario, session: string) =>
  s.spans.store.listAnnotations(session).filter((file) => file.annotation.name === NAME)

/** Count only this evaluator's judge calls, not the agent, steering, or rule distillation. */
const judgeCalls = (s: Scenario, session: string): Array<EndedSpan> =>
  s.spans
    .ended(session)
    .filter((span) => span.parent_id === null && span.name === `eval ${NAME}`)
    .flatMap((root) => s.spans.trace(session, root.context.trace_id).filter((span) => kindOf(span) === "LLM"))

interface Progress {
  result?: RunResult
}

const pending = async (s: Scenario, progress: Progress = {}): Promise<string> => {
  const session = await s.spans.waitFor("a real CLI session with an outcome annotation", () => {
    if (progress.result !== undefined) expectOk(progress.result)
    const id = s.spans.sessions()[0]

    return id !== undefined && verdicts(s, id).length > 0 ? id : undefined
  })

  const [initial] = verdicts(s, session)
  expect(initial?.annotation).toMatchObject({
    label: "pending",
    metadata: { pending: true, failed: false, feedback: false },
  })
  expect(initial?.annotation.score).toBeUndefined()
  expect(judgeCalls(s, session)).toHaveLength(0)
  expect(s.spans.ended(session).filter((span) => span.name === `learn ${NAME}`)).toHaveLength(0)
  expect(fs.existsSync(path.join(project(s), "rules.md"))).toBe(false)
  expect(s.spans.tools(session).filter((tool) => tool.name === "bash")).toHaveLength(1)

  return session
}

const launched = (s: Scenario, session: string) => {
  const tool = s.spans.tools(session).find((call) => readMetadata(call.span).job !== undefined)?.span
  const job = tool === undefined ? undefined : readMetadata(tool).job

  if (tool === undefined || job === undefined) throw new Error("The CLI did not launch the gated job")

  return { tool, job }
}

/** Don't leave a gate-waiting process behind when an assertion fails. */
const cleanGate = async (s: Scenario): Promise<void> => {
  release(s)

  for (const session of s.spans.sessions()) {
    for (const call of s.spans.tools(session)) {
      const job = readMetadata(call.span).job

      if (job === undefined) continue
      const dir = path.dirname(job.log)
      await s.spans.waitFor("the gated job to exit or be killed", () =>
        fs.existsSync(path.join(dir, "exit")) || fs.existsSync(path.join(dir, "killed")) ? true : undefined,
      )
    }
  }
}

const resolved = (s: Scenario, session: string, label: "pass" | "fail"): void => {
  // The outcome check's own results. The turn that observed the result is also judged in its own right.
  const results = verdicts(s, session).filter(
    (file) => file.annotation.metadata?.["deferred_from"] !== undefined,
  )

  expect(results.map((file) => file.annotation.label)).toEqual(["pending", label])
  expect(results.map((file) => file.annotation.identifier)).toEqual(
    results.map(() => `oi-agent:deferred:${s.spans.turns(session)[0]?.trace_id}`),
  )
  expect(results[1]?.annotation.metadata?.["deferred_from"]).toBe(s.spans.turns(session)[0]?.trace_id)
  expect(results[1]?.annotation.metadata?.["pending"]).toBe(false)
  const calls = judgeCalls(s, session)
  expect(calls).toHaveLength(1)
  const evidence = calls.map((span) => stringAttr(span, OI.INPUT_VALUE) ?? "").join("\n")
  expect(evidence).toContain("[original launch turn]")
  expect(evidence).toContain(label === "pass" ? "exited with code 0" : "killed after")
  expect(evidence).toContain(COMMAND.split(";")[0])
}

const options = {
  model: MODELS.anthropic,
  liveOnly: true,
  config: new Map([
    ["steering", "off"],
    ["judge_model", DEFAULT_JUDGE_MODEL],
  ]),
}

scenario("outcome check stays pending without a judge until a gated job is delivered", options, async (s) => {
  seed(s)
  const progress: Progress = {}

  const running = s.run(["run", "--yolo", START]).then((result) => {
    progress.result = result

    return result
  })

  let session = ""

  try {
    session = await pending(s, progress)
    const { job } = launched(s, session)
    expect(fs.existsSync(path.join(path.dirname(job.log), "exit"))).toBe(false)
  } finally {
    release(s)

    try {
      expectOk(await running)
    } finally {
      await cleanGate(s)
    }
  }

  const turns = await s.spans.settledTurns(session, 2)
  expect(turns).toHaveLength(2)
  const { tool, job } = launched(s, session)
  expect(readMetadata(turns[1]!.root).delivers).toEqual([
    { kind: "job", id: job.id, ...tool.context, inbox_id: `job-${job.id}` },
  ])
  resolved(s, session, "pass")
})

for (const observer of ["job_status", "job_kill"]) {
  scenario(
    `outcome check resolves through real CLI ${observer} without duplicate delivery`,
    options,
    async (s) => {
      seed(s)

      try {
        expectOk(await s.run(["run", "--yolo", "--no-wait", START]))
        const session = await pending(s)
        const { tool, job } = launched(s, session)
        const progress: Progress = {}

        const prompt =
          observer === "job_status"
            ? `Call job_status exactly once now with id "${job.id}" and wait_ms 600000. Do not call bash or any other tool. After it returns, report its result and stop.`
            : `Call job_kill exactly once now with id "${job.id}". Do not call bash or any other tool. After it returns, report the cancellation and stop.`

        const observing = s.run(["run", "--yolo", "--no-wait", "-s", session, prompt]).then((result) => {
          progress.result = result

          return result
        })

        try {
          if (observer === "job_status") {
            await s.spans.waitFor("job_status waiting while the gate is still closed", () => {
              const call = s.spans.open(session).find((span) => stringAttr(span, OI.TOOL_NAME) === observer)

              if (call !== undefined) return call

              if (progress.result !== undefined) {
                expectOk(progress.result)
                throw new Error("The CLI ended without the requested waiting job_status call")
              }

              return undefined
            })
            expect(verdicts(s, session).map((file) => file.annotation.label)).toEqual(["pending"])
            expect(judgeCalls(s, session)).toHaveLength(0)
          }
        } finally {
          if (observer === "job_status") release(s)
          expectOk(await observing)
        }

        const turns = await s.spans.settledTurns(session, 2)
        expect(turns).toHaveLength(2)
        const call = s.spans.tools(session).find((entry) => entry.name === observer)
        expect(call).toBeDefined()
        expect(readMetadata(call!.span).delivers).toEqual([
          { kind: "job", id: job.id, ...tool.context, inbox_id: `job-${job.id}` },
        ])
        expect(readMetadata(turns[1]!.root).observed_results).toEqual([`job-${job.id}`])
        expect(turns.flatMap((turn) => readMetadata(turn.root).delivers ?? [])).toEqual([])
        expect(s.spans.store.listInbox(session)).toHaveLength(1)
        resolved(s, session, observer === "job_status" ? "pass" : "fail")
      } finally {
        await cleanGate(s)
      }
    },
  )
}
