import * as fs from "node:fs"
import { describe, expect, it } from "vite-plus/test"
import { type EndedSpan, OI, readMetadata, writeMetadata } from "../src/format.ts"
import {
  annotationFromRemote,
  parsePhoenixLink,
  restoreAttributes,
  spanFromOtlp,
} from "../src/remote/phoenix.ts"
import { forgetMarker, keepInPhoenix, listMarkers, readMarker } from "../src/remote/storage.ts"
import { publicRemote, workspaceDrift } from "../src/workspace.ts"
import { tempStore } from "./helpers.ts"

const TRACE = "01a1d34cb6719f8f28fb7151fab0e637"

const span = (spanId: string, start: string, attributes: EndedSpan["attributes"] = {}): EndedSpan => ({
  name: "turn",
  context: { trace_id: TRACE, span_id: spanId },
  span_kind: "SPAN_KIND_INTERNAL",
  parent_id: null,
  start_time: start,
  end_time: start,
  status_code: "OK",
  status_message: "",
  attributes,
  events: [],
})

describe("reading spans back from Phoenix", () => {
  it("re-nests JSON-string attributes Phoenix flattened, and leaves the rest alone", () => {
    const metadata = writeMetadata(undefined, {
      device: "d1",
      injected: [{ annotation_id: "a1", name: "size" }],
      approval: { decision: "allow", by: "host" },
    })

    const restored = restoreAttributes([
      ["input.value", '{"messages":[]}'],
      ["llm.input_messages.0.message.role", "user"],
      ["metadata.oi_agent.device", "d1"],
      ["metadata.oi_agent.injected.0.annotation_id", "a1"],
      ["metadata.oi_agent.injected.0.name", "size"],
      ["metadata.oi_agent.approval.decision", "allow"],
      ["metadata.oi_agent.approval.by", "host"],
      ["tool.parameters.type", "object"],
      ["tool.parameters.required", ["command"]],
    ])

    expect(restored["metadata"]).toBe(metadata)
    expect(restored["tool.parameters"]).toBe('{"type":"object","required":["command"]}')
    expect(restored["input.value"]).toBe('{"messages":[]}')
    expect(restored["llm.input_messages.0.message.role"]).toBe("user")
  })

  it("rounds times to the microsecond Phoenix stores and keeps status and parent", () => {
    const ended = spanFromOtlp({
      trace_id: TRACE,
      span_id: "24f4afcd432993d4",
      parent_span_id: "e49d98b7a17bc40d",
      name: "bash",
      start_time_unix_nano: "1794546398781126144",
      end_time_unix_nano: "1794546398799124992",
      attributes: [{ key: OI.SPAN_KIND, value: { string_value: "TOOL" } }],
      events: null,
      status: { code: 2, message: "interrupted" },
    })

    expect(ended?.start_time).toBe("2026-11-13T05:06:38.781126000Z")
    expect(ended?.end_time).toBe("2026-11-13T05:06:38.799125000Z")
    expect(ended?.parent_id).toBe("e49d98b7a17bc40d")
    expect(ended?.status_code).toBe("ERROR")
    expect(ended?.status_message).toBe("interrupted")
    expect(ended?.attributes[OI.SPAN_KIND]).toBe("TOOL")
  })

  it("skips a span that has not ended", () => {
    const open = spanFromOtlp({
      trace_id: TRACE,
      span_id: "24f4afcd432993d4",
      name: "turn",
      start_time_unix_nano: "1794546398781126144",
      end_time_unix_nano: null,
    })

    expect(open).toBeUndefined()
  })

  it("restores an annotation's local id and drops the bookkeeping from its metadata", () => {
    const remote = {
      id: "VHJhY2VBbm5vdGF0aW9uOjEw",
      trace_id: TRACE,
      name: "size",
      annotator_kind: "CODE" as const,
      identifier: "oi-agent",
      metadata: { failed: true, oi_agent: { id: "local-1" } },
      created_at: "2026-11-13T05:11:06+00:00",
      result: { label: "fail", score: null, explanation: "too big" },
    }

    const file = annotationFromRemote("s1", remote)

    expect(file.id).toBe("local-1")
    expect(file.annotation).toEqual({
      name: "size",
      annotator_kind: "CODE",
      identifier: "oi-agent",
      label: "fail",
      explanation: "too big",
      metadata: { failed: true },
    })
    expect(file.target).toEqual({ session_id: "s1", trace_id: TRACE })

    // Exported before local ids were sent: Phoenix's id stands in.
    expect(annotationFromRemote("s1", { ...remote, metadata: null }).id).toBe(remote.id)
  })

  it("parses session and trace links from the Phoenix UI", () => {
    expect(
      parsePhoenixLink("http://localhost:6006/projects/UHJvamVjdDo4/sessions/UHJvamVjdFNlc3Npb246MjE%3D"),
    ).toEqual({ kind: "session", id: "UHJvamVjdFNlc3Npb246MjE=" })
    expect(
      parsePhoenixLink(`https://app.phoenix.arize.com/s/me/projects/UHJvamVjdDo4/traces/${TRACE}?x=1`),
    ).toEqual({
      kind: "trace",
      id: TRACE,
      project: "UHJvamVjdDo4",
    })
    expect(parsePhoenixLink(`http://localhost:6006/redirects/traces/${TRACE}`)).toEqual({
      kind: "trace",
      id: TRACE,
      project: undefined,
    })
    expect(parsePhoenixLink("01a1d34c")).toBeUndefined()
  })
})

describe("importing into the store", () => {
  it("writes a span once, and reads one span per id even when it exists under two names", () => {
    const store = tempStore()
    const session = store.createSession("/tmp/project")
    const original = span("e49d98b7a17bc40d", "2026-11-13T05:06:22.449000123Z", { [OI.SPAN_KIND]: "AGENT" })

    store.endSpan(session.id, original)

    // Phoenix rounds the time, so the imported copy would get another file name.
    const imported = { ...original, start_time: "2026-11-13T05:06:22.449000000Z" }

    expect(store.importSpan(session.id, imported)).toBe(false)
    expect(store.importSpan(session.id, span("7bf6c23170b2039d", "2026-11-13T05:06:23Z"))).toBe(true)

    // A merged tree (from sync, say) can hold both names; the reader keeps one.
    const dir = store.traceDir(session.id, TRACE)

    fs.writeFileSync(`${dir}/01794546382449000000-e49d98b7a17bc40d.json`, JSON.stringify(imported))

    expect(store.readTrace(session.id, TRACE).ended.map((ended) => ended.context.span_id)).toEqual([
      "e49d98b7a17bc40d",
      "7bf6c23170b2039d",
    ])
  })

  it("keeps the Phoenix-only marker outside the session tree", () => {
    const store = tempStore()
    const session = store.createSession("/tmp/project")

    keepInPhoenix(store, session.id, { endpoint: "http://localhost:6006", project: "oi-agent" })

    expect(readMarker(store, session.id)?.header).toEqual(session)
    expect(store.manifest(session.id)).toEqual(["session.json"])

    store.removeSession(session.id)

    expect(store.listSessionIds()).toEqual([])
    expect(listMarkers(store).map((marker) => marker.summary.id)).toEqual([session.id])

    forgetMarker(store, session.id)

    expect(listMarkers(store)).toEqual([])
  })
})

describe("workspace", () => {
  it("strips credentials from a remote URL", () => {
    expect(publicRemote("https://user:token@github.com/o/r.git")).toBe("https://github.com/o/r.git")
    expect(publicRemote("git@github.com:o/r.git")).toBe("git@github.com:o/r.git")
  })

  it("says how the checkout differs from where the session last ran", () => {
    const then = { cwd: "/a", git: { commit: "aaaaaaa1", dirty: true } }

    expect(workspaceDrift(then, { cwd: "/a", git: { commit: "aaaaaaa1", dirty: true } })).toHaveLength(1)
    expect(workspaceDrift({ ...then, git: { commit: "aaaaaaa1", dirty: false } }, then)).toEqual([])
    expect(workspaceDrift(then, { cwd: "/b" })).toEqual([
      "It ran in /a; it will run in /b now.",
      "It ran in a git checkout at aaaaaaa; this directory is not one.",
    ])
    expect(workspaceDrift(undefined, { cwd: "/b" })).toEqual([])
  })

  it("is recorded on a turn's root span", () => {
    expect(
      readMetadata(
        span("e49d98b7a17bc40d", "2026-11-13T05:06:22Z", {
          [OI.METADATA]: writeMetadata(undefined, { workspace: { cwd: "/a" } }),
        }),
      ).workspace,
    ).toEqual({ cwd: "/a" })
  })
})
