/**
 * Learning from steering (issue #10), scored. Whether a correction is durable
 * is a judgement call by a model, so this is not pass/fail on one try:
 * explicit and implicit durable corrections should become evaluators, and
 * one-off ones should not, whether they are a turn's prompt or said to a
 * turn while it runs (issue #62). The implicit and later one-off cases are worded
 * unlike anything in the system prompt, so a prompt cannot pass by echoing
 * them (see docs/experiments/steering.md).
 * Each case runs `OI_E2E_SAMPLES` times (default 3) and the scenario fails
 * when the rate falls below a bar. The scores go into the failure message
 * and the scenario's span in Phoenix.
 *
 * It takes minutes, so it is not part of `pnpm e2e`: run `pnpm e2e:scored`.
 */
import { expect } from "vite-plus/test"
import { positiveInteger } from "../src/samples.ts"
import { scenario } from "../src/scenario.ts"
import {
  DURABLE,
  IMPLICIT,
  learned,
  learnedMidTurn,
  MID_TURN_DURABLE,
  MID_TURN_ONE_OFF,
  ONE_OFF,
} from "../src/steering.ts"

const SAMPLES = positiveInteger("OI_E2E_SAMPLES", 3)

const rate = (hits: number, total: number): string =>
  `${hits}/${total} (${Math.round((hits / total) * 100)}%)`

scenario(
  "durable corrections become evaluators; one-off ones do not",
  {
    liveOnly: true,
    samples: true,
    config: new Map([["steering", "auto"]]),
    timeoutMs: 900_000,
  },
  async (s) => {
    const cases = [
      ...[...DURABLE, ...IMPLICIT].map((entry, index) => ({
        entry,
        key: `durable-${index}`,
        durable: true,
      })),
      ...ONE_OFF.map((entry, index) => ({ entry, key: `one-off-${index}`, durable: false })),
    ].map((job) => ({ ...job, midTurn: false }))

    // The same judgement on corrections given to a running turn (issue #62), scored apart:
    // few cases, and a different path into the detector.
    const steered = [
      ...MID_TURN_DURABLE.map((entry, index) => ({ entry, key: `mid-turn-durable-${index}`, durable: true })),
      ...MID_TURN_ONE_OFF.map((entry, index) => ({
        entry,
        key: `mid-turn-one-off-${index}`,
        durable: false,
      })),
    ].map((job) => ({ ...job, midTurn: true }))

    const jobs = Array.from({ length: SAMPLES }, (_, sample) =>
      [...cases, ...steered].map((entry) => ({ ...entry, sample })),
    ).flat()

    const rows = await s.samples(jobs, async (child, job, retries) => {
      const started = Date.now()
      const created = await (job.midTurn ? learnedMidTurn : learned)(child, job.entry, true)

      const row = {
        case: job.key,
        sample: job.sample,
        durable: job.durable,
        mid_turn: job.midTurn,
        learned: created.length > 0,
        // Copies: a results row is plain JSON.
        evaluators: created.map((entry) => ({ ...entry })),
        producers: created.map((entry) => entry.producer).join(", "),
        retries,
        durationMs: Date.now() - started,
        sandbox: child.sandbox.root,
        sessions: child.spans.sessions(),
      }

      s.results([row])

      return row
    })

    const hits = (durable: boolean, midTurn: boolean): number =>
      rows.filter((row) => row.durable === durable && row.mid_turn === midTurn && row.learned).length

    const durableTotal = SAMPLES * (DURABLE.length + IMPLICIT.length)
    const oneOffTotal = SAMPLES * ONE_OFF.length
    const midDurableTotal = SAMPLES * MID_TURN_DURABLE.length
    const midOneOffTotal = SAMPLES * MID_TURN_ONE_OFF.length

    s.note(
      `durable learned: ${rate(hits(true, false), durableTotal)}; one-off learned: ${rate(hits(false, false), oneOffTotal)}`,
    )
    s.note(
      `said mid-turn: durable learned: ${rate(hits(true, true), midDurableTotal)}; one-off learned: ${rate(hits(false, true), midOneOffTotal)}`,
    )

    expect(hits(true, false) / durableTotal).toBeGreaterThanOrEqual(2 / 3)
    expect(hits(false, false) / oneOffTotal).toBeLessThanOrEqual(1 / 6)
    expect(hits(true, true) / midDurableTotal).toBeGreaterThanOrEqual(2 / 3)
    expect(hits(false, true) / midOneOffTotal).toBeLessThanOrEqual(1 / 6)
  },
)
