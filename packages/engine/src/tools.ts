/**
 * The built-in tools. Each tool pairs the JSON schema the model sees with a
 * schema that validates what the model actually sent before anything runs.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import type { EngineMetadata } from "./format.ts"
import { describeState, type Job, jobReport, LogReader } from "./jobs.ts"
import type { Jobs } from "./jobs.ts"
import type { Json } from "./wire.ts"

export interface ToolContext {
  readonly cwd: string
  /** Live output for viewers of the in-flight span. */
  readonly emit: (chunk: string) => void
  readonly sessionId: string
  /** The `TOOL` span this call runs under. */
  readonly span: Job["tool"]
  readonly jobs: Jobs
}

export interface ToolOutcome {
  readonly output: string
  readonly isError: boolean
  /** The background job the call left running, for the `TOOL` span's metadata. */
  readonly job?: NonNullable<EngineMetadata["job"]>
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** JSON schema for the tool input, as sent to the model. */
  readonly parameters: Json
  /** Whether the tool can change the machine, and so needs approval. */
  readonly mutates: boolean
  readonly run: (input: Json, context: ToolContext) => Effect.Effect<ToolOutcome>
}

export const ok = (output: string): ToolOutcome => ({ output, isError: false })
export const failed = (output: string): ToolOutcome => ({ output, isError: true })

export interface ToolDefinition<S extends Schema.Codec<unknown, unknown>> {
  readonly name: string
  readonly description: string
  readonly parameters: Json
  readonly mutates: boolean
  readonly input: S
  readonly run: (input: S["Type"], context: ToolContext) => Effect.Effect<ToolOutcome>
}

export const defineTool = <S extends Schema.Codec<unknown, unknown>>(
  definition: ToolDefinition<S>,
): ToolSpec => {
  const decode = Schema.decodeUnknownOption(definition.input)

  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    mutates: definition.mutates,
    run: (input, context) =>
      Option.match(decode(input), {
        // With eager input streaming the API does not validate tool input, so this check is the only one.
        onNone: () =>
          Effect.succeed(failed(`Invalid input for ${definition.name}: ${JSON.stringify(input)}`)),
        onSome: (parsed) =>
          definition
            .run(parsed, context)
            .pipe(Effect.catchDefect((defect) => Effect.succeed(failed(String(defect))))),
      }),
  }
}

const MAX_OUTPUT = 30_000

/** Keep the head and tail of long output; the middle is rarely what matters. */
export const truncate = (text: string, limit: number = MAX_OUTPUT): string => {
  if (text.length <= limit) return text

  const half = Math.floor(limit / 2)

  return `${text.slice(0, half)}\n\n[... ${text.length - limit} characters omitted ...]\n\n${text.slice(-half)}`
}

const resolve = (context: ToolContext, file: string): string => path.resolve(context.cwd, file)

// --- read_file -------------------------------------------------------------

const readFile = defineTool({
  name: "read_file",
  description:
    "Read a text file. Returns the contents with line numbers. Use offset and limit to read part of a large file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      offset: { type: "integer", description: "First line to read, starting at 1." },
      limit: { type: "integer", description: "Maximum number of lines to read. Defaults to 2000." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  mutates: false,
  input: Schema.Struct({
    path: Schema.String,
    offset: Schema.optionalKey(Schema.Int),
    limit: Schema.optionalKey(Schema.Int),
  }),
  run: (input, context) =>
    Effect.sync(() => {
      const lines = fs.readFileSync(resolve(context, input.path), "utf8").split("\n")
      const start = Math.max((input.offset ?? 1) - 1, 0)
      const selected = lines.slice(start, start + (input.limit ?? 2000))
      const numbered = selected.map((line, index) => `${String(start + index + 1).padStart(5)}\t${line}`)
      const remaining = lines.length - start - selected.length
      const footer = remaining > 0 ? `\n[${remaining} more lines; use offset to continue]` : ""

      return ok(truncate(numbered.join("\n") + footer, 100_000))
    }),
})

// --- write_file ------------------------------------------------------------

const writeFile = defineTool({
  name: "write_file",
  description: "Create a file or replace its entire contents. Parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      content: { type: "string", description: "The full new contents of the file." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  mutates: true,
  input: Schema.Struct({ path: Schema.String, content: Schema.String }),
  run: (input, context) =>
    Effect.sync(() => {
      const file = resolve(context, input.path)

      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, input.content)

      return ok(`Wrote ${input.content.length} characters to ${input.path}`)
    }),
})

// --- edit_file -------------------------------------------------------------

const editFile = defineTool({
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match the file exactly and, unless replace_all is set, exactly once.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      old_string: { type: "string", description: "The exact text to replace." },
      new_string: { type: "string", description: "The text to replace it with." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  mutates: true,
  input: Schema.Struct({
    path: Schema.String,
    old_string: Schema.String,
    new_string: Schema.String,
    replace_all: Schema.optionalKey(Schema.Boolean),
  }),
  run: (input, context) =>
    Effect.sync(() => {
      const file = resolve(context, input.path)
      const before = fs.readFileSync(file, "utf8")
      const count = before.split(input.old_string).length - 1

      if (input.old_string === "" || count === 0) return failed(`old_string was not found in ${input.path}`)

      if (count > 1 && input.replace_all !== true) {
        return failed(`old_string matches ${count} places in ${input.path}; add context or set replace_all`)
      }

      // A function replacement keeps `$` sequences in new_string literal.
      const after =
        input.replace_all === true
          ? before.replaceAll(input.old_string, () => input.new_string)
          : before.replace(input.old_string, () => input.new_string)

      fs.writeFileSync(file, after)

      return ok(`Replaced ${count === 1 ? "1 occurrence" : `${count} occurrences`} in ${input.path}`)
    }),
})

// --- bash ------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000

/** How often a running command's log is read for live output. */
const PUMP_MS = 50

/** A command started in the background is watched this long first, so one that fails at once says so. */
const BACKGROUND_GRACE_MS = 1000

const MAX_WAIT_MS = 600_000

const withStatus = (output: string, status: string): string =>
  `${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${status}`

/**
 * Told to a model whose command is still running: what happens next, and
 * that waiting for it is not its job.
 */
export const backgroundStatus = (job: Job, log: string, timeoutMs: number | undefined): string =>
  [
    timeoutMs === undefined
      ? `[running in the background as job ${job.id}.`
      : `[still running after ${timeoutMs} ms, so it continues in the background as job ${job.id}; it was not killed.`,
    "Its result will be delivered to you when it finishes: do not sleep, poll or run it again.",
    `job_status shows progress, job_kill stops it. Full output: ${log}]`,
  ].join(" ")

const bash = defineTool({
  name: "bash",
  description:
    "Run a shell command in the working directory and return its combined stdout and stderr with the exit code. Use it for searching (rg), listing files, running tests and builds, and git. A command still running after timeout_ms (two minutes by default) is not killed: it continues as a background job, you get its output so far, and its result is delivered to you when it finishes. Start slow commands (full test suites, builds, servers) with background: true instead of waiting for them.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run with bash -c." },
      timeout_ms: {
        type: "integer",
        description:
          "How long to wait for the command, in milliseconds, before it continues in the background. Defaults to 120000 (two minutes).",
      },
      background: {
        type: "boolean",
        description:
          "Start the command as a background job and return at once. Its result is delivered to you when it finishes.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  mutates: true,
  input: Schema.Struct({
    command: Schema.String,
    timeout_ms: Schema.optionalKey(Schema.Int),
    background: Schema.optionalKey(Schema.Boolean),
  }),
  run: (input, context) =>
    Effect.callback<ToolOutcome>((resume) => {
      const { jobs } = context

      const job = jobs.start({
        sessionId: context.sessionId,
        command: input.command,
        cwd: context.cwd,
        tool: context.span,
      })

      const reader = new LogReader(jobs.logPath(job))
      const chunks: Array<string> = []
      const background = input.background === true
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS
      let settled = false

      const pump = (): void => {
        const chunk = reader.read()

        if (chunk === "") return

        chunks.push(chunk)
        context.emit(chunk)
      }

      const pumping = setInterval(pump, PUMP_MS)

      const settle = (outcome: () => ToolOutcome): void => {
        if (settled) return

        settled = true
        clearInterval(pumping)
        clearTimeout(timer)
        pump()
        resume(Effect.succeed(outcome()))
      }

      const timer = setTimeout(
        () =>
          settle(() => {
            const reason = background ? "requested" : "timeout"
            const log = jobs.logPath(job)

            jobs.toBackground(job, reason)

            return {
              output: withStatus(
                truncate(chunks.join("")),
                backgroundStatus(job, log, background ? undefined : timeoutMs),
              ),
              isError: false,
              job: { id: job.id, log, reason },
            }
          }),
        background ? BACKGROUND_GRACE_MS : timeoutMs,
      )

      void jobs.ended(job).then((state) =>
        settle(() => {
          jobs.discard(job)

          return {
            output: withStatus(
              truncate(chunks.join("")),
              state.state === "exited" ? `[exit code ${state.code}]` : "[killed]",
            ),
            isError: state.state !== "exited" || state.code !== 0,
          }
        }),
      )

      // The turn was interrupted while the command ran in the foreground: stop it.
      return Effect.sync(() => {
        if (settled) return

        settled = true
        clearInterval(pumping)
        clearTimeout(timer)
        jobs.kill(job)
        jobs.discard(job)
      })
    }),
})

// --- jobs ------------------------------------------------------------------

const unknownJob = (id: string): ToolOutcome =>
  failed(`No background job ${id} in this session. Call job_status without an id to list them.`)

const jobStatus = defineTool({
  name: "job_status",
  description:
    "Check on background jobs: the state, command and latest output of one job, or a list of this session's jobs when no id is given. A finished job's result is delivered to you without asking, so call this only to look at progress. With wait_ms, wait up to that long for the job to finish first.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The job id. Omit to list every background job." },
      wait_ms: {
        type: "integer",
        description: `Wait up to this many milliseconds for the job to finish (at most ${MAX_WAIT_MS}).`,
      },
    },
    additionalProperties: false,
  },
  mutates: false,
  input: Schema.Struct({ id: Schema.optionalKey(Schema.String), wait_ms: Schema.optionalKey(Schema.Int) }),
  run: (input, context) =>
    Effect.promise(async () => {
      const { jobs } = context

      if (input.id === undefined) {
        const lines = jobs
          .list(context.sessionId)
          .map((job) => `${job.id}  ${describeState(job, jobs.state(job))}  ${job.command}`)

        return ok(lines.length === 0 ? "No background jobs in this session." : lines.join("\n"))
      }

      const job = jobs.read(context.sessionId, input.id)

      if (job === undefined || !jobs.isBackground(job)) return unknownJob(input.id)

      const state =
        input.wait_ms === undefined
          ? jobs.state(job)
          : await jobs.wait(job, Math.min(Math.max(input.wait_ms, 0), MAX_WAIT_MS))

      // Seen here, so it is not delivered a second time as a result.
      if (state.state !== "running") jobs.claim(job)

      return ok(jobReport(jobs, job, state))
    }),
})

const jobKill = defineTool({
  name: "job_kill",
  description: "Stop a background job this session started, and everything it started.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The job id." } },
    required: ["id"],
    additionalProperties: false,
  },
  // It can only stop a command that an approved bash call started.
  mutates: false,
  input: Schema.Struct({ id: Schema.String }),
  run: (input, context) =>
    Effect.sync(() => {
      const { jobs } = context
      const job = jobs.read(context.sessionId, input.id)

      if (job === undefined || !jobs.isBackground(job)) return unknownJob(input.id)

      jobs.kill(job)
      jobs.claim(job)

      return ok(jobReport(jobs, job, jobs.state(job)))
    }),
})

export const builtinTools: ReadonlyArray<ToolSpec> = [readFile, writeFile, editFile, bash, jobStatus, jobKill]
