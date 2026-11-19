/** Native Gemini GenerateContent. Inspect parts through schemas, but replay the original JSON. */
import { Option, Schema } from "effect"
import type { Image } from "../attachments.ts"
import {
  type Attrs,
  type Dialect,
  effortIn,
  flattenTranscript,
  INTERRUPTED_RESULT,
  type ToolCall,
  type TranscriptEntry,
  userEntry,
} from "../dialect.ts"
import { ImageType, OI } from "../format.ts"
import type { Json } from "../wire.ts"

const opt = Schema.optionalKey
const Content = Schema.Struct({ role: opt(Schema.String), parts: Schema.Array(Schema.Json) })
const FunctionCall = Schema.Struct({ id: opt(Schema.String), name: Schema.String, args: opt(Schema.Json) })

const Part = Schema.Struct({
  text: opt(Schema.String),
  thought: opt(Schema.Boolean),
  inlineData: opt(Schema.Struct({ mimeType: ImageType, data: Schema.String })),
  functionCall: opt(FunctionCall),
  functionResponse: opt(
    Schema.Struct({
      id: opt(Schema.String),
      name: Schema.String,
      response: Schema.Struct({ output: opt(Schema.String), error: opt(Schema.String) }),
    }),
  ),
})

const Request = Schema.Struct({
  contents: Schema.Array(Schema.Json),
  systemInstruction: opt(Content),
  generationConfig: opt(
    Schema.Struct({
      maxOutputTokens: opt(Schema.Int),
      thinkingConfig: opt(Schema.Struct({ thinkingLevel: opt(Schema.String) })),
    }),
  ),
  tools: opt(Schema.Array(Schema.Struct({ functionDeclarations: Schema.Array(Schema.Json) }))),
})

export const GoogleResponse = Schema.Struct({
  candidates: opt(
    Schema.Array(Schema.Struct({ content: opt(Schema.Json), finishReason: opt(Schema.String) })),
  ),
  usageMetadata: opt(
    Schema.Struct({
      promptTokenCount: opt(Schema.Int),
      candidatesTokenCount: opt(Schema.Int),
      thoughtsTokenCount: opt(Schema.Int),
      cachedContentTokenCount: opt(Schema.Int),
      totalTokenCount: opt(Schema.Int),
    }),
  ),
  promptFeedback: opt(Schema.Struct({ blockReason: opt(Schema.String) })),
})

const parseRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request))
const parseResponse = Schema.decodeUnknownOption(Schema.fromJsonString(GoogleResponse))
export const googleContent = (value: Json | undefined) => Option.getOrUndefined(decodeContent(value))
export const googlePart = (value: Json) => Option.getOrUndefined(decodePart(value))
const decodeContent = Schema.decodeUnknownOption(Content)
const decodePart = Schema.decodeUnknownOption(Part)

const visibleText = (parts: ReadonlyArray<Json>): string =>
  parts
    .map((json) => {
      const part = googlePart(json)

      return part?.thought === true ? "" : (part?.text ?? "")
    })
    .join("")

interface NativeCall extends ToolCall {
  readonly wireId: string | undefined
}

const callsIn = (parts: ReadonlyArray<Json>): Array<NativeCall> =>
  parts.flatMap((part, index) => {
    const call = googlePart(part)?.functionCall

    return call === undefined
      ? []
      : [{ id: call.id ?? `gemini-part-${index}`, wireId: call.id, name: call.name, input: call.args ?? {} }]
  })

const userMessage: Dialect["userMessage"] = (texts, images = []) => ({
  role: "user",
  parts: [
    ...texts.map((text) => ({ text })),
    ...images.map(({ media_type, data }) => ({ inlineData: { mimeType: media_type, data } })),
  ],
})

const functionResponse = (call: NativeCall, output: string, isError: boolean): Json => {
  const fields: Array<[string, Json]> = [
    ["name", call.name],
    ["response", isError ? { error: output } : { output }],
  ]

  if (call.wireId !== undefined) fields.push(["id", call.wireId])

  return { functionResponse: Object.fromEntries(fields) }
}

const continueWith: Dialect["continueWith"] = (messages, raw, results) => {
  const content = Option.getOrUndefined(parseResponse(raw))?.candidates?.[0]?.content
  const body = googleContent(content)

  if (content === undefined || body === undefined) return [...messages]

  const calls = callsIn(body.parts)

  if (calls.length === 0) return [...messages, content]

  const parts = calls.map((call) => {
    const result = results.find((entry) => entry.id === call.id)

    return functionResponse(call, result?.output ?? INTERRUPTED_RESULT, result?.isError ?? true)
  })

  // All calls first, then all responses in call order (including same-name parallel calls).
  return [...messages, content, { role: "user", parts }]
}

const toTranscript: Dialect["toTranscript"] = (messages) => {
  const entries: Array<TranscriptEntry> = []
  let pending: Array<NativeCall> = []

  for (const value of messages) {
    const content = googleContent(value)

    if (content === undefined) continue

    const text = visibleText(content.parts)

    if (content.role === "model") {
      pending = callsIn(content.parts)
      entries.push({ role: "assistant", text, calls: pending })
      continue
    }

    const images: Array<Image> = []

    for (const json of content.parts) {
      const part = googlePart(json)
      const response = part?.functionResponse

      if (part?.inlineData !== undefined)
        images.push({ media_type: part.inlineData.mimeType, data: part.inlineData.data })

      if (response === undefined) continue

      const index = pending.findIndex((call) =>
        response.id === undefined ? call.name === response.name : call.wireId === response.id,
      )

      const call = index < 0 ? undefined : pending.splice(index, 1)[0]
      const id = call?.id ?? response.id

      if (id !== undefined)
        entries.push({
          role: "tool",
          id,
          output: response.response.error ?? response.response.output ?? "",
          isError: response.response.error !== undefined,
        })
    }

    if (text !== "" || images.length > 0) entries.push(userEntry(text, images))
  }

  return entries
}

const fromTranscript: Dialect["fromTranscript"] = (entries) => {
  const messages: Array<Json> = []
  let pending: ReadonlyArray<ToolCall> = []
  let results: Array<Json> = []

  const flush = (): void => {
    if (results.length > 0) messages.push({ role: "user", parts: results })

    results = []
  }

  for (const entry of entries) {
    if (entry.role === "tool") {
      const call = pending.find((call) => call.id === entry.id)

      if (call !== undefined)
        results.push(functionResponse({ ...call, wireId: call.id }, entry.output, entry.isError))

      continue
    }

    flush()

    if (entry.role === "user") {
      messages.push(userMessage(entry.text === "" ? [] : [entry.text], entry.images))
      pending = []
    } else {
      pending = entry.calls
      const parts: Array<Json> = entry.text === "" ? [] : [{ text: entry.text }]

      for (const [i, call] of entry.calls.entries()) {
        const functionCall = { id: call.id, name: call.name, args: call.input }

        // Google's migration marker for a foreign function call. Never used on native history.
        parts.push(
          i === 0 ? { functionCall, thoughtSignature: "skip_thought_signature_validator" } : { functionCall },
        )
      }

      if (parts.length > 0) messages.push({ role: "model", parts })
    }
  }

  flush()

  return messages
}

const reply: Dialect["reply"] = (raw) => {
  const response = Option.getOrUndefined(parseResponse(raw))
  const candidate = response?.candidates?.[0]

  if (candidate === undefined) return undefined

  const parts = googleContent(candidate.content)?.parts ?? []
  const calls = callsIn(parts)
  const finish = candidate.finishReason ?? ""

  return {
    text: visibleText(parts),
    calls,
    wantsTools: calls.length > 0,
    paused: false,
    stopReason: finish === "STOP" ? "stop" : finish,
  }
}

const requestAttributes: Dialect["requestAttributes"] = (raw, vendor) => {
  const out: Attrs = new Map([
    [OI.SPAN_KIND, "LLM"],
    [OI.LLM_SYSTEM, "google"],
    [OI.LLM_PROVIDER, vendor],
    [OI.INPUT_VALUE, raw],
    [OI.INPUT_MIME, "application/json"],
  ])

  const request = Option.getOrUndefined(parseRequest(raw))

  if (request === undefined) return out

  const prefix = OI.LLM_INPUT_MESSAGES

  out.set(`${prefix}.0.message.role`, "system")
  out.set(`${prefix}.0.message.content`, visibleText(request.systemInstruction?.parts ?? []))
  out.set(OI.LLM_INVOCATION_PARAMETERS, JSON.stringify(request.generationConfig ?? {}))
  flattenTranscript(prefix, 1, toTranscript(request.contents), out)

  for (const [i, tool] of (request.tools?.flatMap((group) => group.functionDeclarations) ?? []).entries())
    out.set(`${OI.LLM_TOOLS}.${i}.tool.json_schema`, JSON.stringify(tool))

  return out
}

const responseAttributes: Dialect["responseAttributes"] = (raw) => {
  const out: Attrs = new Map([
    [OI.OUTPUT_VALUE, raw],
    [OI.OUTPUT_MIME, "application/json"],
  ])

  const response = Option.getOrUndefined(parseResponse(raw))
  const parsed = reply(raw)

  if (parsed !== undefined) {
    flattenTranscript(
      OI.LLM_OUTPUT_MESSAGES,
      0,
      [{ role: "assistant", text: parsed.text, calls: parsed.calls }],
      out,
    )
    out.set(OI.LLM_FINISH_REASON, response?.candidates?.[0]?.finishReason ?? "")
  }

  const usage = response?.usageMetadata

  if (usage !== undefined) {
    const prompt = usage.promptTokenCount ?? 0
    const completion = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)

    out.set(OI.TOKENS_PROMPT, prompt)
    out.set(OI.TOKENS_COMPLETION, completion)
    out.set(OI.TOKENS_TOTAL, usage.totalTokenCount ?? prompt + completion)
    out.set(OI.TOKENS_CACHE_READ, usage.cachedContentTokenCount ?? 0)
  }

  return out
}

export const googleGenerateContent: Dialect = {
  api: "google-generate-content",
  reply,
  continueWith,
  userMessage,
  toTranscript,
  fromTranscript,
  requestAttributes,
  responseAttributes,
  requestMessages: (raw) => Option.getOrUndefined(parseRequest(raw))?.contents.slice(),
  effort: (raw) =>
    effortIn(
      Option.getOrUndefined(
        parseRequest(raw),
      )?.generationConfig?.thinkingConfig?.thinkingLevel?.toLowerCase(),
    ),
}
