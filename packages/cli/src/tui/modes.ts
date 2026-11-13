/** Effort-level rules for Shift+Tab and `/model`, kept pure for tests. */
import { type Effort, EFFORTS, type ModelOption } from "@oi-agent/engine"

/** The levels a model accepts. Unknown models (or no catalog yet) get the full ladder. */
export const effortsFor = (catalog: ReadonlyArray<ModelOption>, model: string): ReadonlyArray<Effort> =>
  catalog.find((option) => option.id === model)?.efforts ?? EFFORTS

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
