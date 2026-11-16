import { describe, expect, it } from "vite-plus/test"
import { mapSamples } from "../src/samples.ts"

describe("sample workers", () => {
  it("bounds overlap and returns input order", async () => {
    let active = 0
    let peak = 0

    const rows = await mapSamples([3, 2, 1, 0], 2, async (entry) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, entry * 5))
      active -= 1

      return entry
    })

    expect(rows).toEqual([3, 2, 1, 0])
    expect(peak).toBe(2)
    expect(active).toBe(0)
  })

  it("drains in-flight work and stops scheduling after failure", async () => {
    const started: Array<number> = []
    let completed = false

    const work = mapSamples([0, 1, 2], 2, async (entry) => {
      started.push(entry)

      if (entry === 0) throw new Error("sample failed")
      await new Promise((resolve) => setTimeout(resolve, 10))
      completed = true

      return entry
    })

    await expect(work).rejects.toThrow("sample failed")
    expect(started).toEqual([0, 1])
    expect(completed).toBe(true)
  })

  it("rejects invalid concurrency and handles no jobs", async () => {
    await expect(mapSamples([], 0, async () => 0)).rejects.toThrow("positive integer")
    await expect(mapSamples([], 4, async () => 0)).resolves.toEqual([])
  })
})
