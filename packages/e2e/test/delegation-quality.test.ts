import * as fs from "node:fs"
import { expect, it } from "vite-plus/test"
import {
  prepare,
  reportedInvestigations,
  verifyWorkingCopy,
  type QualityCase,
} from "../src/delegation-quality.ts"
import { Sandbox } from "../src/sandbox.ts"
import type { Sample } from "../src/scenario.ts"
import { Spans } from "../src/spans.ts"

it("accepts a structured report in ordinary prose or markdown", () => {
  expect(
    reportedInvestigations(
      'Observed results:\n```json\n{"east":{"errors":100,"backend":"east-cache"},"west":{"errors":75,"backend":"west-cache"}}\n```',
    ),
  ).toBe(true)
})

it("rejects swapped counts even when all expected facts are present", () => {
  expect(
    reportedInvestigations(
      '{"east":{"errors":75,"backend":"east-cache"},"west":{"errors":100,"backend":"west-cache"}}',
    ),
  ).toBe(false)
})

it("rejects swapped backend attribution", () => {
  expect(
    reportedInvestigations(
      '{"east":{"errors":100,"backend":"west-cache"},"west":{"errors":75,"backend":"east-cache"}}',
    ),
  ).toBe(false)
})

it("rejects an incomplete delivery report", () => {
  expect(reportedInvestigations('{"west":{"errors":75,"backend":"west-cache"}}')).toBe(false)
})

it("rejects prose-only and malformed evidence rather than guessing", () => {
  expect(reportedInvestigations("east-cache 100; west-cache 75")).toBe(false)
  expect(reportedInvestigations("{not JSON}")).toBe(false)
})

const withFixture = (kind: QualityCase, body: (s: Sample) => void): void => {
  const sandbox = new Sandbox("quality-oracle", {
    fixture: "basic",
    confine: false,
    env: new Map(),
    config: {
      model: "unused/test",
      effort: "low",
      approvals: "allow",
      extra: new Map(),
      phoenixEndpoint: "",
      phoenixProject: "unused",
    },
  })

  const spans = new Spans(sandbox.home)
  const sample: Sample = { sandbox, spans, run: (args, env) => sandbox.run(args, env) }

  try {
    prepare(sample, kind)
    body(sample)
  } finally {
    spans.close()
    sandbox.dispose(false)
  }
}

it("checks the dirty working copy independently of the agent-editable test", () => {
  withFixture("dirty-dependency", (s) => {
    expect(verifyWorkingCopy(s, "dirty-dependency")).toBe(false)
    fs.writeFileSync(s.sandbox.file("price.cjs"), "module.exports = { cents:725, currency:'EUR' }\n")
    expect(verifyWorkingCopy(s, "dirty-dependency")).toBe(true)
    fs.writeFileSync(s.sandbox.file("price.cjs"), "module.exports = { cents:100, currency:'EUR' }\n")
    fs.writeFileSync(s.sandbox.file("verify.cjs"), "console.log('VERIFIED:dirty')\n")
    expect(verifyWorkingCopy(s, "dirty-dependency")).toBe(false)
  })
})

it("rejects a broken installed dependency and a tampered verification script", () => {
  withFixture("warm-dependencies", (s) => {
    expect(verifyWorkingCopy(s, "warm-dependencies")).toBe(true)
    fs.writeFileSync(s.sandbox.file("node_modules/local-rate/index.js"), "exports.value = 0\n")
    expect(verifyWorkingCopy(s, "warm-dependencies")).toBe(false)
  })
  withFixture("quick-edit", (s) => {
    fs.writeFileSync(s.sandbox.file("label.txt"), "receive\n")
    expect(verifyWorkingCopy(s, "quick-edit")).toBe(true)
    fs.writeFileSync(s.sandbox.file("verify.cjs"), "console.log('VERIFIED:quick')\n")
    expect(verifyWorkingCopy(s, "quick-edit")).toBe(false)
  })
})

it("does not mistake braces in a reported shell command for the summary", () => {
  expect(
    reportedInvestigations(
      'Command: `node -e "console.log({})"`\n```json\n{"east":{"errors":100,"backend":"east-cache"},"west":{"errors":75,"backend":"west-cache"}}\n```',
    ),
  ).toBe(true)
})
