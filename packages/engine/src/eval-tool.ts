/**
 * `create_eval`: how the agent turns a sentence from the user into a
 * standing evaluator. This is what "prompt an eval into existence" means.
 */
import { Effect, Schema } from "effect"
import {
  type EvalDefinition,
  type EvalRuntime,
  Metric,
  pendingFeedback,
  runEvals,
  saveEval,
} from "./evals.ts"
import type { Engine } from "./engine.ts"
import { defineTool, failed, ok, type ToolSpec } from "./tools.ts"

const Input = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["llm", "code", "threshold"]),
  metric: Schema.optionalKey(Metric),
  max: Schema.optionalKey(Schema.Finite),
  instructions: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.Literals(["output", "tool_input", "tool_output", "transcript"])),
  learn: Schema.optionalKey(Schema.Boolean),
})

const toDefinition = (input: typeof Input.Type): EvalDefinition | string => {
  const common = {
    name: input.name,
    description: input.description,
    fail_labels: ["fail"],
    feedback: true,
    learn: input.learn ?? true,
  }

  if (input.kind === "llm") {
    return input.instructions === undefined
      ? "An llm evaluator needs instructions."
      : { ...common, kind: "llm", instructions: input.instructions, choices: { pass: 1, fail: 0 } }
  }

  if (input.kind === "threshold") {
    return input.metric === undefined || input.max === undefined
      ? "A threshold evaluator needs a metric and a max."
      : // A limit is not something the agent can learn its way under, so it only gives feedback.
        { ...common, learn: input.learn ?? false, kind: "threshold", metric: input.metric, max: input.max }
  }

  if (input.pattern === undefined) return "A code evaluator needs a pattern."

  try {
    new RegExp(input.pattern, "m")
  } catch {
    return `Not a valid regular expression: ${input.pattern}`
  }

  return {
    ...common,
    kind: "code",
    pattern: input.pattern,
    target: input.target ?? "transcript",
    match_label: "fail",
    otherwise_label: "pass",
  }
}

const isMessage = Schema.is(Schema.String)

export const createEvalTool: ToolSpec = defineTool({
  name: "create_eval",
  description:
    'Create a standing evaluator that reviews every later turn of your work in this project. A failing result is shown to you at the start of your next turn and, when learn is true, distilled into a permanent rule. Use kind "code" with a regular expression that matches a violation, or kind "llm" with instructions for a judge that answers pass or fail.',
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short snake_case name, for example ran_tests." },
      description: { type: "string", description: "One sentence saying what the evaluator checks." },
      kind: { type: "string", enum: ["llm", "code", "threshold"] },
      metric: {
        type: "string",
        enum: ["session_bytes", "tool_calls"],
        description:
          "For kind threshold: session_bytes is the size of this session's span files on disk, in bytes; tool_calls is the number of tool calls in the turn.",
      },
      max: {
        type: "number",
        description:
          "For kind threshold: the turn fails when the metric is greater than this. Use bytes for session_bytes (100 MB is 100000000).",
      },
      instructions: {
        type: "string",
        description:
          "For kind llm: the criterion the judge applies to a turn, phrased so pass means it was met.",
      },
      pattern: {
        type: "string",
        description: "For kind code: a regular expression that matches when the turn violates the rule.",
      },
      target: {
        type: "string",
        enum: ["output", "tool_input", "tool_output", "transcript"],
        description: "For kind code: the text the pattern is tested against. Defaults to transcript.",
      },
      learn: {
        type: "boolean",
        description: "Turn failures into permanent rules. Defaults to true.",
      },
    },
    required: ["name", "description", "kind"],
    additionalProperties: false,
  },
  mutates: false,
  input: Input,
  run: (input, context) =>
    Effect.sync(() => {
      const definition = toDefinition(input)

      if (isMessage(definition)) return failed(definition)

      return ok(
        `Created evaluator "${definition.name}" at ${saveEval(context.cwd, definition)}. It runs after every turn from now on.`,
      )
    }),
})

/** Run evaluators after each turn and feed failures into the next one. */
export const attachEvals = (engine: Engine, runtime: EvalRuntime): void => {
  engine.hooks = {
    pendingFeedback: (sessionId) => pendingFeedback(runtime.store, sessionId),
    afterTurn: async (sessionId, traceId) => {
      await runEvals(runtime, sessionId, traceId)
    },
  }
}
