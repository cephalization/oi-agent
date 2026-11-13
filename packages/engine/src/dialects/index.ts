/** Every dialect, by the `api` an `LLM` span records. */
import type { Dialect } from "../dialect.ts"
import type { Api } from "../format.ts"
import type { Json } from "../wire.ts"
import { anthropicMessages } from "./anthropic.ts"
import { openaiChat } from "./openai-chat.ts"
import { openaiResponses } from "./openai-responses.ts"

export { anthropicMessages, openaiChat, openaiResponses }

const DIALECTS = new Map<Api, Dialect>([
  ["anthropic-messages", anthropicMessages],
  ["openai-chat", openaiChat],
  ["openai-responses", openaiResponses],
])

/** The dialect for an `api`; spans from before dialects were recorded are Anthropic Messages. */
export const dialectFor = (api: Api | undefined): Dialect =>
  DIALECTS.get(api ?? "anthropic-messages") ?? anthropicMessages

/** Messages in one dialect, re-expressed in another. Same dialect: unchanged. */
export const translate = (from: Dialect, to: Dialect, messages: ReadonlyArray<Json>): Array<Json> =>
  from.api === to.api ? [...messages] : to.fromTranscript(from.toTranscript(messages))
