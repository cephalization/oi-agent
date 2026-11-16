import * as fs from "node:fs"
import { describe, expect, it } from "vite-plus/test"
import { attributionExamples } from "./fixtures/eval-attribution.ts"
import { tempStore } from "./helpers.ts"

describe("async evaluator attribution", () => {
  it("separates current launches, delivered results and historical reports without changing regex targets", () => {
    const store = tempStore()

    try {
      const examples = attributionExamples(store, store.home)
      const [launch, delivery, history, repeat, child, missing] = examples.map((entry) => entry.record)

      expect(launch?.judged).toContain('"initiated_this_turn": [\n    {')
      expect(launch?.tool_input).toContain("Run pnpm test")
      expect(delivery?.judged).toContain('"initiated_this_turn": []')
      expect(delivery?.judged).toContain('"role": "delivered_results"')
      expect(delivery?.judged).toContain('"launch": {')
      expect(delivery?.judged).toContain('"result": {')
      expect(delivery?.judged).toContain("42 passed")
      expect(delivery?.judged).not.toContain("prompt_origin")
      expect(delivery?.judged).not.toContain("CHILD_MODEL_HISTORY_MUST_NOT_BE_DUMPED")
      expect(missing?.judged).toContain('"available": false')
      expect(delivery?.tool_input).toBe("")
      expect(delivery?.transcript).toContain("[assistant] The delegated tests completed")
      expect(history?.judged).toContain('"delivered_now": []')
      expect(history?.judged).toContain('"initiated_this_turn": []')
      expect(repeat?.tool_input).toContain("Run pnpm test again")
      expect(child?.judged).toContain('"prompt_origin": {')
      expect(child?.judged).toContain('"initiated_this_turn": []')
    } finally {
      fs.rmSync(store.home, { recursive: true, force: true })
    }
  })
})
