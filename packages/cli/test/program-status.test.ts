import { type EndedSpan, OI, Redactor } from "@oi-agent/engine"
import { describe, expect, it } from "vite-plus/test"
import { ProgramStatus } from "../src/program-status.ts"
import { programStatus } from "../src/tui/ansi.ts"

const turn: EndedSpan = {
  name: "turn",
  context: { trace_id: "t", span_id: "s" },
  parent_id: null,
  span_kind: "SPAN_KIND_INTERNAL",
  start_time: "2026-11-15T00:00:00.000Z",
  end_time: "2026-11-15T00:00:01.000Z",
  status_code: "OK",
  status_message: "",
  events: [],
  attributes: { [OI.SPAN_KIND]: "AGENT", [OI.INPUT_VALUE]: "hello", [OI.OUTPUT_VALUE]: "answer" },
}

const decoded = (encoded: string, key: string): string => {
  const value = new RegExp(`${key}=([A-Za-z0-9+/=]*)`).exec(encoded)?.[1] ?? ""

  return Buffer.from(value, "base64").toString("utf8")
}

describe("OSC 7501 encoding", () => {
  it("uses the protocol grammar and ST terminator, encoding arbitrary text as base64", () => {
    const encoded = programStatus({ state: "blocked", kind: "permission", msg: "日本: a=b;?", title: "oi" })

    expect(encoded).toMatch(
      // oxlint-disable-next-line no-control-regex
      /^\u001B\]7501;[a-z]+=[A-Za-z0-9_.,+/=-]*(?::[a-z]+=[A-Za-z0-9_.,+/=-]*)*\u001B\\$/,
    )
    expect(encoded).toContain("state=blocked:app=oi:kind=permission:")
    expect(decoded(encoded, "msg")).toBe("日本: a=b;?")
    expect(decoded(encoded, "title")).toBe("oi")
    expect(programStatus({ state: "clear" })).toBe("\u001B]7501;state=clear:app=oi\u001B\\")
  })

  it("strips all C0, DEL and C1 controls before encoding", () => {
    const controls = Array.from({ length: 160 }, (_, code) => String.fromCodePoint(code)).join("")
    const encoded = programStatus({ state: "working", msg: controls, title: controls })
    const printable = Array.from({ length: 95 }, (_, code) => String.fromCodePoint(code + 32)).join("")

    expect(decoded(encoded, "msg")).toBe(printable)
    expect(decoded(encoded, "title")).toBe(printable)
  })

  it("caps UTF-8 byte lengths without cutting multibyte characters", () => {
    const encoded = programStatus({ state: "done", msg: "😀".repeat(1000), title: "日".repeat(1000) })

    expect(decoded(encoded, "msg")).toBe("😀".repeat(512))
    expect(decoded(encoded, "title")).toBe("日".repeat(64))
    expect(encoded.length).toBeLessThan(4096)
  })
})

describe("program status projection", () => {
  it("reports only root agent events, suppresses duplicates and acknowledges results", () => {
    const output: Array<string> = []
    const status = new ProgramStatus((text) => output.push(text))

    status.event({ type: "span_open", session_id: "session", span: turn })
    status.event({ type: "span_open", session_id: "session", span: turn })
    status.event({ type: "span_end", session_id: "session", span: { ...turn, parent_id: "parent" } })
    status.event({
      type: "span_end",
      session_id: "session",
      span: { ...turn, attributes: { [OI.SPAN_KIND]: "EVALUATOR" } },
    })
    status.acknowledge()
    expect(output).toHaveLength(1)
    status.event({ type: "span_end", session_id: "session", span: turn })
    expect(output.at(-1)).toContain("state=done:app=oi")
    expect(decoded(output.at(-1) ?? "", "msg")).toBe("answer")
    status.acknowledge()
    expect(output.at(-1)).toContain("state=idle:app=oi")
    status.clear()
    status.event({ type: "span_end", session_id: "session", span: turn })
    expect(output.at(-1)).toContain("state=clear:app=oi")
    expect(output).toHaveLength(4)
  })

  it("reports errors and treats cancellation as idle", () => {
    const output: Array<string> = []
    const status = new ProgramStatus((text) => output.push(text))

    status.event({
      type: "span_end",
      session_id: "session",
      span: { ...turn, status_code: "ERROR", status_message: "failed" },
    })
    expect(output.at(-1)).toContain("state=error:app=oi")
    status.event({
      type: "span_end",
      session_id: "session",
      span: { ...turn, status_code: "ERROR", status_message: "interrupted" },
    })
    expect(output.at(-1)).toContain("state=idle:app=oi")
  })

  it("scrubs known secrets and patterns before truncation and does not acknowledge blocked", () => {
    const output: Array<string> = []
    const redactor = new Redactor()
    const secret = ["sk", "ant", "test", "x".repeat(28)].join("-")

    redactor.add("private-test-token")
    const status = new ProgramStatus((text) => output.push(text), redactor)

    status.report("blocked", `bash ${secret} private-test-token`, "permission")
    status.acknowledge()
    expect(output).toHaveLength(1)
    expect(decoded(output[0] ?? "", "msg")).toBe("bash [redacted] [redacted]")
  })
})
