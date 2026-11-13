/**
 * The built-in tools. Each tool pairs the JSON schema the model sees with a
 * schema that validates what the model actually sent before anything runs.
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import type { Json } from "./wire.ts"

export interface ToolContext {
  readonly cwd: string
  /** Live output for viewers of the in-flight span. */
  readonly emit: (chunk: string) => void
}

export interface ToolOutcome {
  readonly output: string
  readonly isError: boolean
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

const bash = defineTool({
  name: "bash",
  description:
    "Run a shell command in the working directory and return its combined stdout and stderr with the exit code. Use it for searching (rg), listing files, running tests and builds, and git.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run with bash -c." },
      timeout_ms: { type: "integer", description: "Kill the command after this long. Defaults to 120000." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  mutates: true,
  input: Schema.Struct({ command: Schema.String, timeout_ms: Schema.optionalKey(Schema.Int) }),
  run: (input, context) =>
    Effect.callback<ToolOutcome>((resume) => {
      const chunks: Array<string> = []
      const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS

      const child = spawn("bash", ["-c", input.command], {
        cwd: context.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // A process group, so a timeout or interrupt also stops grandchildren.
        detached: true,
      })

      let timedOut = false

      const kill = (): void => {
        if (child.pid === undefined) return

        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          // The process group already exited.
        }
      }

      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)

      const onData = (data: Buffer): void => {
        const chunk = data.toString("utf8")

        chunks.push(chunk)
        context.emit(chunk)
      }

      child.stdout.on("data", onData)
      child.stderr.on("data", onData)
      child.on("error", (error) => {
        clearTimeout(timer)
        resume(Effect.succeed(failed(`Failed to start command: ${error.message}`)))
      })
      child.on("close", (code) => {
        clearTimeout(timer)

        const output = truncate(chunks.join(""))
        const status = timedOut ? `[timed out after ${timeoutMs} ms]` : `[exit code ${code ?? "unknown"}]`

        resume(
          Effect.succeed({
            output: `${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${status}`,
            isError: timedOut || code !== 0,
          }),
        )
      })

      return Effect.sync(() => {
        clearTimeout(timer)
        kill()
      })
    }),
})

export const builtinTools: ReadonlyArray<ToolSpec> = [readFile, writeFile, editFile, bash]
