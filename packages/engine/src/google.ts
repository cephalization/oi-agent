/** Gemini Developer API: stateless streaming GenerateContent and a curated model catalog. */
import { Effect, Layer, Option, Schema } from "effect"
import type { Effort } from "./config.ts"
import { googleContent, googleGenerateContent, googlePart, GoogleResponse } from "./dialects/google.ts"
import { OI } from "./format.ts"
import {
  Model,
  type ModelCall,
  ModelError,
  type ModelHooks,
  type ModelOption,
  type ModelSettings,
} from "./model.ts"
import { serverEvents } from "./sse.ts"
import type { Json } from "./wire.ts"

const baseUrl = (): string =>
  (process.env["GOOGLE_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "")

const LEVELS: ReadonlyArray<Effort> = ["low", "medium", "high"]
const EXTENDED: ReadonlyArray<Effort> = [...LEVELS, "xhigh"]
const MAX_OUTPUT = 65_536

export const GOOGLE_MODELS: ReadonlyArray<ModelOption> = [
  {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    provider: "google",
    efforts: EXTENDED,
    maxOutput: MAX_OUTPUT,
  },
  {
    id: "gemini-4-neon",
    name: "Gemini 4 Neon",
    provider: "google",
    efforts: EXTENDED,
    maxOutput: MAX_OUTPUT,
  },
  {
    id: "gemini-4-carbon",
    name: "Gemini 4 Carbon",
    provider: "google",
    efforts: LEVELS,
    // Conservative limit reported by models.list for the synchronous API.
    maxOutput: 32_768,
  },
]

const modelId = (model: string): string => model.replace(/^models\//, "")

const googleOption = (model: string): ModelOption | undefined =>
  GOOGLE_MODELS.find((option) => option.id === modelId(model))

export const googleEfforts = (model: string): ReadonlyArray<Effort> => googleOption(model)?.efforts ?? []

const requestBody = (settings: ModelSettings, call: ModelCall): string => {
  const generationConfig: Array<[string, Json]> = [
    ["maxOutputTokens", Math.min(settings.maxTokens, googleOption(settings.model)?.maxOutput ?? MAX_OUTPUT)],
  ]

  const efforts = googleEfforts(settings.model)
  const effort = efforts.includes(settings.effort) ? settings.effort : efforts.at(-1)

  if (effort !== undefined)
    generationConfig.push(["thinkingConfig", { thinkingLevel: effort, includeThoughts: true }])

  const fields: Array<[string, Json]> = [
    ["contents", [...call.messages]],
    ["systemInstruction", { parts: [{ text: call.system }] }],
    ["generationConfig", Object.fromEntries(generationConfig)],
  ]

  if (call.tools.length > 0)
    fields.push([
      "tools",
      [
        {
          functionDeclarations: call.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
          })),
        },
      ],
    ])

  return JSON.stringify(Object.fromEntries(fields))
}

const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))
const parseError = Schema.decodeUnknownOption(ErrorBody)
const parseChunk = Schema.decodeUnknownOption(Schema.fromJsonString(GoogleResponse))

const parseInfo = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ displayName: Schema.String })),
)

const fetchGoogle = async (key: string, route: string, init: RequestInit): Promise<Response> => {
  const headers = new Headers(init.headers)

  headers.set("x-goog-api-key", key)

  const response = await fetch(`${baseUrl()}/${route}`, { ...init, headers, redirect: "error" })

  if (!response.ok) {
    const message = Option.getOrUndefined(parseError(await response.text()))?.error.message
    const detail = message?.replaceAll(key, "[REDACTED]") ?? `HTTP ${response.status}`

    throw new ModelError({ message: `Google Gemini: ${detail}`, status: response.status })
  }

  return response
}

const routeFor = (model: string): string => `models/${encodeURIComponent(modelId(model))}`

/** Confirm a custom model id without needing to generate tokens. */
export const checkGoogleModel = async (apiKey: string, model: string): Promise<string> => {
  const response = await fetchGoogle(apiKey, routeFor(model), { signal: AbortSignal.timeout(8000) })

  return parseInfo(await response.text()).displayName
}

const runGoogle = async (
  settings: ModelSettings,
  call: ModelCall,
  hooks: ModelHooks,
  signal: AbortSignal,
): Promise<string> => {
  const body = requestBody(settings, call)

  hooks.onRequest(body)

  const response = await fetchGoogle(
    settings.apiKey,
    `${routeFor(settings.model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body,
      signal,
    },
  )

  if (response.body === null) throw new ModelError({ message: "Google Gemini returned no response body." })

  const parts: Array<Json> = []
  let finishReason: string | undefined
  let usage: typeof GoogleResponse.Type.usageMetadata
  let role = "model"

  for await (const data of serverEvents(response.body)) {
    const error = Option.getOrUndefined(parseError(data))

    if (error !== undefined)
      throw new ModelError({
        message: `Google Gemini: ${error.error.message.replaceAll(settings.apiKey, "[REDACTED]")}`,
      })

    const chunk = Option.getOrUndefined(parseChunk(data))

    if (chunk === undefined) throw new ModelError({ message: "Google Gemini sent an invalid stream event." })

    if (chunk.promptFeedback?.blockReason !== undefined)
      throw new ModelError({
        message: `Google Gemini blocked the prompt: ${chunk.promptFeedback.blockReason}.`,
      })

    const candidate = chunk.candidates?.[0]
    const content = googleContent(candidate?.content)

    role = content?.role ?? role
    finishReason = candidate?.finishReason ?? finishReason
    usage = chunk.usageMetadata ?? usage

    for (const rawPart of content?.parts ?? []) {
      const i = parts.length
      const part = googlePart(rawPart)

      parts.push(rawPart)

      if (part?.text !== undefined && part.text !== "")
        hooks.onDelta({ k: part.thought === true ? "thinking" : "text", i, d: part.text })

      if (part?.functionCall !== undefined)
        hooks.onDelta({ k: "tool_input", i, d: JSON.stringify(part.functionCall.args ?? {}) })
    }
  }

  if (finishReason === undefined)
    throw new ModelError({ message: "Google Gemini disconnected before finishing the response." })

  // Assemble a native response from the stream without merging parts or moving signatures.
  return JSON.stringify({ candidates: [{ content: { role, parts }, finishReason }], usageMetadata: usage })
}

export const googleModel = (settings: ModelSettings): Layer.Layer<Model> =>
  Layer.succeed(Model, {
    provider: "google",
    vendor: "google",
    billing: "api",
    dialect: {
      ...googleGenerateContent,
      requestAttributes: (raw, vendor) =>
        googleGenerateContent.requestAttributes(raw, vendor).set(OI.LLM_MODEL, modelId(settings.model)),
    },
    run: (call, hooks) =>
      Effect.tryPromise({
        try: (signal) => runGoogle(settings, call, hooks, signal),
        catch: (cause) =>
          cause instanceof ModelError
            ? cause
            : new ModelError({ message: "Could not read the Google Gemini stream." }),
      }),
  })
