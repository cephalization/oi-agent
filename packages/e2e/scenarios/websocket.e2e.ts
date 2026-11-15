/**
 * OpenAI's Responses API over a WebSocket. Over plain HTTP each request can
 * reach a different machine and miss the prompt cache; one connection per
 * conversation keeps later calls on the machine that cached the prefix.
 */
import { OI } from "@oi-agent/engine"
import type { EndedSpan } from "@oi-agent/engine"
import { describe, expect } from "vite-plus/test"
import { expectOk, scenario } from "../src/scenario.ts"

/** OpenTelemetry's attribute for the protocol a model call travelled over. */
const PROTOCOL = "network.protocol.name"

/** Several model calls in one turn, each a separate request with a longer prefix. */
const STEPS =
  "Do these one at a time, as separate tool calls, never in parallel. " +
  "First call read_file on answer.txt. Then call bash with the command `ls`. " +
  "Then call bash with the command `pwd`. Then call bash with the command `ls src`. " +
  "Then call read_file on README.md. Then reply with just the magic number."

const cachedTokens = (span: EndedSpan): number => Number(span.attributes[OI.TOKENS_CACHE_READ] ?? 0)

describe("OpenAI over a WebSocket", () => {
  scenario(
    "sends every call of a turn over a WebSocket, and later calls read the prompt cache",
    { approvals: "allow" },
    async ({ run, spans, note }) => {
      const result = await run(["run", STEPS])

      expectOk(result)
      expect(result.stdout).toContain("4817")

      const session = spans.onlySession()

      await spans.settledTurns(session, 1)

      const calls = spans.ofKind(session, "LLM")
      const cached = calls.slice(1).map(cachedTokens)

      note(`cache read per call after the first: ${cached.join(", ")}`)
      // Five tool calls and the answer: enough later calls that a stray cache miss cannot empty the sample.
      expect(calls.length).toBeGreaterThanOrEqual(5)
      expect(calls.map((span) => span.attributes[PROTOCOL])).toEqual(calls.map(() => "websocket"))
      // The stored request is the HTTP body, so it replays the same on either transport.
      expect(String(calls[0]?.attributes[OI.INPUT_VALUE])).toContain('"stream":true')
      // The first call writes the cache; at least one later call must have read it.
      expect(Math.max(...cached)).toBeGreaterThan(0)
    },
  )

  scenario(
    "OI_AGENT_OPENAI_TRANSPORT=http keeps every call on plain HTTP",
    { approvals: "allow", env: new Map([["OI_AGENT_OPENAI_TRANSPORT", "http"]]) },
    async ({ run, spans }) => {
      const result = await run(["run", "Use read_file on answer.txt, then reply with just the magic number."])

      expectOk(result)
      expect(result.stdout).toContain("4817")

      const session = spans.onlySession()

      await spans.settledTurns(session, 1)

      const calls = spans.ofKind(session, "LLM")

      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls.map((span) => span.attributes[PROTOCOL])).toEqual(calls.map(() => "http"))
    },
  )
})
