/**
 * Wire dialects: the request and response formats of the model APIs the
 * engine can drive.
 *
 * An `LLM` span stores the exact request and response bodies of one call,
 * and records which dialect they are in (`metadata.oi_agent.api`). The fold
 * continues a conversation in the dialect its last call used, replaying the
 * stored bodies verbatim. Only when the next model speaks a different dialect
 * is the conversation translated, through the neutral `Transcript` below,
 * which keeps text, tool calls and tool results and drops what one provider
 * cannot read from another (reasoning, signatures, provider-specific blocks).
 */
import { Option, Schema } from "effect"
import type { Api, AttrValue } from "./format.ts"
import type { Json } from "./wire.ts"

/** Span attributes under construction. */
export type Attrs = Map<string, AttrValue>

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: Json
}

/** What the loop needs from a response, whatever the dialect. */
export interface Reply {
  readonly text: string
  readonly calls: ReadonlyArray<ToolCall>
  /** The model is waiting for tool results. */
  readonly wantsTools: boolean
  /** A server-side tool paused; sending the conversation back resumes it. */
  readonly paused: boolean
  readonly stopReason: string
}

export interface ToolResult {
  readonly id: string
  readonly output: string
  readonly isError: boolean
}

/** A conversation in no particular dialect: what survives a change of provider. */
export type TranscriptEntry =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text: string; readonly calls: ReadonlyArray<ToolCall> }
  | { readonly role: "tool"; readonly id: string; readonly output: string; readonly isError: boolean }

export type Transcript = ReadonlyArray<TranscriptEntry>

export interface Dialect {
  readonly api: Api
  /** The conversation messages of a stored request body, without the system prompt. */
  readonly requestMessages: (raw: string) => Array<Json> | undefined
  readonly reply: (raw: string) => Reply | undefined
  /** The messages to send next: the request's, then the response, then the tool results. */
  readonly continueWith: (
    messages: ReadonlyArray<Json>,
    rawResponse: string,
    results: ReadonlyArray<ToolResult>,
  ) => Array<Json>
  /** A user message made of these text parts. */
  readonly userMessage: (parts: ReadonlyArray<string>) => Json
  readonly toTranscript: (messages: ReadonlyArray<Json>) => Transcript
  readonly fromTranscript: (transcript: Transcript) => Array<Json>
  /** OpenInference attributes for the request; `provider` is `llm.provider`. */
  readonly requestAttributes: (raw: string, provider: string) => Attrs
  readonly responseAttributes: (raw: string) => Attrs
}

/** Tool results as the model reads them when one never finished. */
export const INTERRUPTED_RESULT =
  "This tool call was interrupted before it completed. Its effects are unknown."

// --- shared helpers for flattening a transcript into OpenInference messages -------

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** Tool arguments as an object, from a JSON string that may be malformed. */
export const parseArguments = (text: string): Json =>
  Option.match(decodeObject(text === "" ? "{}" : text), {
    onNone: () => ({ unparsed_arguments: text }),
    onSome: (value) => value,
  })

/**
 * Flatten transcript entries as `llm.input_messages` / `llm.output_messages`.
 * Returns the next free index.
 */
export const flattenTranscript = (prefix: string, start: number, entries: Transcript, out: Attrs): number => {
  let index = start

  for (const entry of entries) {
    const key = `${prefix}.${index}.message`

    out.set(`${key}.role`, entry.role)

    if (entry.role === "tool") {
      out.set(`${key}.tool_call_id`, entry.id)
      out.set(`${key}.content`, entry.output)
    } else {
      out.set(`${key}.content`, entry.text)
    }

    if (entry.role === "assistant") {
      for (const [position, call] of entry.calls.entries()) {
        const tool = `${key}.tool_calls.${position}.tool_call`

        out.set(`${tool}.id`, call.id)
        out.set(`${tool}.function.name`, call.name)
        out.set(`${tool}.function.arguments`, JSON.stringify(call.input))
      }
    }

    index += 1
  }

  return index
}

/** Merge adjacent assistant entries (text, then its tool calls) into one. */
export const mergeAssistant = (entries: Array<TranscriptEntry>, next: TranscriptEntry): void => {
  const last = entries.at(-1)

  if (next.role === "assistant" && last?.role === "assistant") {
    entries[entries.length - 1] = {
      role: "assistant",
      text: [last.text, next.text].filter((text) => text !== "").join("\n"),
      calls: [...last.calls, ...next.calls],
    }

    return
  }

  entries.push(next)
}
