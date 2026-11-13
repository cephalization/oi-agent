/**
 * OpenInference attributes for a model call.
 *
 * The raw request and response bodies go in `input.value` / `output.value`
 * and are what the fold replays. The flattened `llm.*` attributes here are the
 * normalized view every OpenInference consumer understands.
 */
import type { Attrs } from "./dialect.ts"
import { OI } from "./format.ts"
import {
  asBlock,
  asMessage,
  asParts,
  isText,
  type Json,
  type RequestBody,
  type ResponseBody,
} from "./wire.ts"

const text = (json: Json | undefined): string => {
  if (json === undefined || json === null) return ""

  const content = asMessage({ role: "", content: json })?.content

  if (content === undefined) return JSON.stringify(json)

  return asParts(content)
    .map((part) => {
      const block = asBlock(part)

      return block !== undefined && "text" in block ? block.text : JSON.stringify(part)
    })
    .join("")
}

/** Flatten one wire message into one or more OpenInference messages. */
const flattenMessage = (prefix: string, start: number, role: string, content: Json, out: Attrs): number => {
  let index = start
  const key = (): string => `${prefix}.${index}.message`
  const message = asMessage({ role, content })

  if (message === undefined || isText(message.content)) {
    out.set(`${key()}.role`, role)
    out.set(`${key()}.content`, text(content))

    return index + 1
  }

  let parts = 0
  let calls = 0

  for (const json of message.content) {
    const block = asBlock(json)

    if (block === undefined) continue

    if ("tool_use_id" in block) {
      // A tool result is its own message in OpenInference.
      if (parts > 0 || calls > 0) index += 1

      out.set(`${key()}.role`, "tool")
      out.set(`${key()}.tool_call_id`, block.tool_use_id)
      out.set(`${key()}.content`, text(block.content))
      index += 1
      parts = 0
      calls = 0
      continue
    }

    const part = `${key()}.contents.${parts}.message_content`

    out.set(`${key()}.role`, role)
    parts += 1

    if ("thinking" in block) {
      out.set(`${part}.type`, "reasoning")
      out.set(`${part}.text`, block.thinking)

      if (block.signature !== undefined) out.set(`${part}.signature`, block.signature)
    } else if ("data" in block) {
      out.set(`${part}.type`, "reasoning")
      out.set(`${part}.data`, block.data)
    } else if ("input" in block) {
      const call = `${key()}.tool_calls.${calls}.tool_call`

      out.set(`${part}.type`, "tool_use")
      out.set(`${part}.id`, block.id)
      out.set(`${call}.id`, block.id)
      out.set(`${call}.function.name`, block.name)
      out.set(`${call}.function.arguments`, JSON.stringify(block.input))
      calls += 1
    } else if ("text" in block) {
      out.set(`${part}.type`, "text")
      out.set(`${part}.text`, block.text)
    } else {
      out.set(`${part}.type`, block.type)
    }
  }

  return parts > 0 || calls > 0 ? index + 1 : index
}

export const requestAttributes = (body: RequestBody, raw: string): Attrs => {
  const out: Attrs = new Map([
    [OI.SPAN_KIND, "LLM"],
    [OI.LLM_SYSTEM, "anthropic"],
    [OI.LLM_PROVIDER, "anthropic"],
    [OI.LLM_MODEL, body.model],
    [OI.INPUT_VALUE, raw],
    [OI.INPUT_MIME, "application/json"],
  ])

  let index = 0

  out.set(
    OI.LLM_INVOCATION_PARAMETERS,
    JSON.stringify({
      max_tokens: body.max_tokens,
      thinking: body.thinking,
      output_config: body.output_config,
    }),
  )

  if (body.system !== undefined) {
    out.set(`${OI.LLM_INPUT_MESSAGES}.0.message.role`, "system")
    out.set(`${OI.LLM_INPUT_MESSAGES}.0.message.content`, text(body.system))
    index = 1
  }

  for (const json of body.messages) {
    const message = asMessage(json)

    if (message !== undefined) {
      index = flattenMessage(OI.LLM_INPUT_MESSAGES, index, message.role, message.content, out)
    }
  }

  for (const [position, tool] of (body.tools ?? []).entries()) {
    out.set(`${OI.LLM_TOOLS}.${position}.tool.json_schema`, JSON.stringify(tool))
  }

  return out
}

export const responseAttributes = (body: ResponseBody, raw: string): Attrs => {
  const out: Attrs = new Map([
    [OI.OUTPUT_VALUE, raw],
    [OI.OUTPUT_MIME, "application/json"],
  ])

  const usage = body.usage ?? {}
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  // OpenInference counts cached tokens inside the prompt total; Anthropic reports them beside it.
  const prompt = (usage.input_tokens ?? 0) + cacheRead + cacheWrite
  const completion = usage.output_tokens ?? 0

  flattenMessage(OI.LLM_OUTPUT_MESSAGES, 0, "assistant", [...body.content], out)
  out.set(OI.TOKENS_PROMPT, prompt)
  out.set(OI.TOKENS_COMPLETION, completion)
  out.set(OI.TOKENS_TOTAL, prompt + completion)
  out.set(OI.TOKENS_CACHE_READ, cacheRead)
  out.set(OI.TOKENS_CACHE_WRITE, cacheWrite)

  if (body.model !== undefined) out.set(OI.LLM_MODEL, body.model)

  if (body.stop_reason !== undefined && body.stop_reason !== null)
    out.set(OI.LLM_FINISH_REASON, body.stop_reason)

  return out
}
