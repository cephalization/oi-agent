/** Effort-level rules for Shift+Tab and `/model`, kept pure for tests. */
import { type Effort, EFFORTS, type ModelOption, type ModelRef, openaiEfforts } from "@oi-agent/engine"

/**
 * The levels a model accepts. A model the catalog has not listed (yet) gets
 * Claude's full ladder, OpenAI's reasoning levels, or none for other servers.
 */
export const effortsFor = (catalog: ReadonlyArray<ModelOption>, ref: ModelRef): ReadonlyArray<Effort> => {
  const listed = catalog.find((option) => option.provider === ref.provider && option.id === ref.model)

  if (listed !== undefined) return listed.efforts

  if (ref.provider === "anthropic") return EFFORTS

  return ref.provider === "openai" || ref.provider === "chatgpt" ? openaiEfforts(ref.model) : []
}

/** The next level up, wrapping to the lowest. Undefined when the model has no effort setting. */
export const nextEffort = (current: Effort, levels: ReadonlyArray<Effort>): Effort | undefined => {
  if (levels.length === 0) return undefined

  return levels[(levels.indexOf(current) + 1) % levels.length]
}

/**
 * The level to keep after switching to a model that accepts `levels`: the
 * current one if it is accepted, else the highest accepted level below it,
 * else the lowest accepted level.
 */
export const fitEffort = (current: Effort, levels: ReadonlyArray<Effort>): Effort | undefined => {
  if (levels.includes(current)) return current

  const rank = EFFORTS.indexOf(current)

  return levels.findLast((level) => EFFORTS.indexOf(level) < rank) ?? levels[0]
}

/** `/model`'s argument: the model, and whether `--temp` asked to leave the saved default alone. */
export interface ModelArgument {
  readonly argument: string
  readonly temporary: boolean
}

/** Split `--temp` (before or after the model) from the rest of `/model`'s argument. */
export const parseModelArgument = (input: string): ModelArgument => {
  const words = input.split(/\s+/).filter((word) => word !== "")
  const rest = words.filter((word) => word !== "--temp")

  return { argument: rest.join(" "), temporary: rest.length !== words.length }
}
