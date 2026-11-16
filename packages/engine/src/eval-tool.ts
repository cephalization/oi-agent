/**
 * `create_eval`: how the agent turns a sentence from the user into a
 * standing evaluator. This is what "prompt an eval into existence" means.
 */
import { Effect, Schema } from "effect"
import { definitionFrom, EvalInput, type EvalRuntime, pendingFeedback, runEvals, saveEval } from "./evals.ts"
import type { Engine } from "./engine.ts"
import { readMetadata } from "./format.ts"
import { detectSteering } from "./steering.ts"
import { defineTool, failed, ok, type ToolSpec } from "./tools.ts"

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
      applicability: {
        type: "object",
        description:
          "When this check applies: any is OR, all is AND. Predicates: writes (observed workspace content change), commit (observed Git commit), tool:<name> (tool invoked), always. Unknown evidence runs the check. Omit/empty for every turn. Split obligations with different triggers into separate checks.",
        properties: {
          any: { type: "array", items: { type: "string" } },
          all: { type: "array", items: { type: "string" } },
        },
        required: ["any"],
        additionalProperties: false,
      },
      kind: { type: "string", enum: ["llm", "code", "threshold"] },
      wait_for_background: {
        type: "boolean",
        description:
          "LLM outcome checks only: stay pending until results of this turn's directly launched jobs/tasks are delivered. Defaults to false. Never enable for launch prohibitions or obligations that must be checked immediately.",
      },
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
  input: EvalInput,
  run: (input, context) =>
    Effect.sync(() => {
      const definition = definitionFrom(input)

      if (isMessage(definition)) return failed(definition)

      return ok(
        `Created evaluator "${definition.name}" at ${saveEval(context.cwd, definition)}. Trigger: ${JSON.stringify(definition.applicability ?? "always (legacy)")}.`,
      )
    }),
})

/** Run evaluators after each turn and feed failures into the next one. */
export const attachEvals = (engine: Engine, runtime: EvalRuntime): void => {
  engine.hooks = {
    pendingFeedback: (sessionId) => pendingFeedback(runtime.store, sessionId),
    afterTurn: async (sessionId, traceId) => {
      await runEvals(runtime, sessionId, traceId)

      // After the evaluators, so an evaluator learned from this prompt does not judge the turn that taught it.
      if (runtime.detect === undefined) return

      const root = runtime.store.readTrace(sessionId, traceId).ended.find((span) => span.parent_id === null)

      // A turn oi started to deliver results has no words from a person to learn from.
      if (root !== undefined && readMetadata(root).delivers !== undefined) return

      await detectSteering(runtime, runtime.detect, sessionId, traceId)
    },
  }
}
