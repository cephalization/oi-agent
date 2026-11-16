import { readMetadata } from "@oi-agent/engine"
import { expect } from "vite-plus/test"
import {
  CASES,
  modeOf,
  prepare,
  reportedInvestigations,
  tokens,
  verifyWorkingCopy,
} from "../src/delegation-quality.ts"
import { positiveInteger } from "../src/samples.ts"
import { expectOk, scenario } from "../src/scenario.ts"

const repetitions = positiveInteger("OI_E2E_SAMPLES", 3)

for (const policy of ["auto", "off"]) {
  scenario(
    `unprescribed delegation quality (${policy})`,
    { liveOnly: true, samples: true, config: new Map([["delegation", policy]]), timeoutMs: 900_000 },
    async (s) => {
      const jobs = Array.from({ length: repetitions }, (_, sample) =>
        CASES.map((kind) => ({ kind, sample })),
      ).flat()

      const rows = await s.samples(jobs, async (child, job, retries) => {
        const prompt = prepare(child, job.kind)
        const started = Date.now()
        const result = await child.run(["run", "--yolo", prompt])

        expectOk(result)

        const durationMs = Date.now() - started
        const sessions = child.spans.sessions()
        const parents = sessions.filter((id) => child.spans.store.readHeader(id)?.task === undefined)

        expect(parents).toHaveLength(1)

        const parent = parents[0] ?? ""
        const calls = child.spans.tools(parent).filter((call) => call.name === "delegate")

        const evidence = sessions
          .flatMap((id) => child.spans.tools(id))
          .map((call) => ({
            session: String(call.span.attributes["session.id"] ?? ""),
            span: call.span.context.span_id,
            name: call.name,
            input: call.input,
            output: call.output,
          }))

        const parentReports = child.spans
          .turns(parent)
          .map((turn) => ({ trace: turn.trace_id, output: turn.output ?? "" }))

        const output = parentReports.at(-1)?.output ?? ""
        const observed = evidence.map((entry) => entry.output).join("\n")
        const independent = job.kind === "independent-investigations"

        const marker = `VERIFIED:${modeOf(job.kind)}`

        const facts = ["100", "75", "east-cache", "west-cache"]

        const evidenceAccurate = independent
          ? parentReports.some((report) => reportedInvestigations(report.output)) &&
            facts.every((fact) => observed.includes(fact))
          : output.includes(marker) &&
            output.includes("verify.cjs") &&
            evidence.some(
              (entry) =>
                entry.name === "bash" &&
                entry.input.includes("verify.cjs") &&
                entry.output.split("\n").includes(marker),
            )

        const provisioned = evidence.some(
          (entry) =>
            entry.name === "bash" &&
            /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|ci)\b|\b(?:curl|wget)\b/.test(entry.input),
        )

        const completed =
          verifyWorkingCopy(child, job.kind) &&
          evidenceAccurate &&
          (job.kind !== "warm-dependencies" || !provisioned)

        const tasks = calls.flatMap((call) => {
          const task = readMetadata(call.span).task

          return task === undefined
            ? []
            : [{ id: task.id, session: task.session_id, span: call.span.context.span_id }]
        })

        const delivered = child.spans.turns(parent).flatMap((turn) => readMetadata(turn.root).delivers ?? [])

        const allDelivered =
          tasks.length === calls.length &&
          tasks.every(
            (task) =>
              delivered.some((entry) => entry.id === task.id) &&
              child.spans.store.readHeader(task.session)?.parent?.span_id === task.span,
          )

        const intervals = tasks.flatMap((task) =>
          child.spans.turns(task.session).map((turn) => ({
            session: task.session,
            start: Date.parse(turn.root.start_time),
            end: Date.parse(turn.root.end_time ?? turn.root.start_time),
          })),
        )

        const overlapped = intervals.some((left) =>
          intervals.some(
            (right) => left.session !== right.session && left.start < right.end && right.start < left.end,
          ),
        )

        const choiceCorrect =
          policy === "off" || (independent ? calls.length >= 2 && overlapped : calls.length === 0)

        const row = {
          case: job.kind,
          policy,
          sample: job.sample,
          retries,
          durationMs,
          completed,
          evidenceAccurate,
          choiceCorrect,
          unnecessaryDelegations: independent ? 0 : calls.length,
          allDelivered,
          delegates: calls.length,
          overlapped,
          intervals,
          modelCalls: sessions.reduce((n, id) => n + child.spans.ofKind(id, "LLM").length, 0),
          tokens: tokens(child),
          models: [...new Set(sessions.map((id) => child.spans.lastModel(id)?.model ?? "?"))],
          sessions,
          tasks,
          evidence,
          parentOutput: output,
          parentReports,
          provisioned,
        }

        s.results([row])

        return row
      })

      for (const kind of CASES) {
        const group = rows.filter((row) => row.case === kind)

        const count = (key: "completed" | "evidenceAccurate" | "choiceCorrect"): number =>
          group.filter((row) => row[key]).length

        s.note(
          `${kind}: completion ${count("completed")}/${group.length}; evidence ${count("evidenceAccurate")}/${group.length}; choice ${count("choiceCorrect")}/${group.length}; tokens ${group.reduce((n, row) => n + row.tokens, 0)}; wall ms ${group.map((row) => row.durationMs).join(",")}`,
        )
      }

      // Completion/evidence must hold on every sample; a policy score cannot mask wrong work.
      expect(rows.every((row) => row.completed && row.allDelivered)).toBe(true)
      expect(rows.every((row) => row.tokens > 0 && row.modelCalls > 0)).toBe(true)

      if (policy === "off") expect(rows.every((row) => row.delegates === 0)).toBe(true)

      // Per-case bars prevent easy edits from hiding a failure to split independent work.
      for (const kind of CASES) {
        const group = rows.filter((row) => row.case === kind)

        expect(group.filter((row) => row.choiceCorrect).length / group.length).toBeGreaterThanOrEqual(2 / 3)
      }
    },
  )
}
