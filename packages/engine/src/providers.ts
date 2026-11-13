/**
 * Model providers: where a model is served and how to authenticate.
 *
 * Three are built in: Anthropic, OpenAI (API key) and ChatGPT (sign in with
 * a ChatGPT plan). Any number of OpenAI-compatible servers can be added; they
 * live in the config file as `providers`. No provider entry holds a secret:
 * API keys and ChatGPT tokens are in the keychain, one account per provider.
 */
import { Schema } from "effect"
import type { ModelOption } from "./model.ts"

export const ProviderKind = Schema.Literals(["anthropic", "openai", "chatgpt", "openai-compatible"])

export type ProviderKind = typeof ProviderKind.Type

/** A model a provider entry names itself, for servers whose list is missing or too long. */
export const ProviderModel = Schema.Struct({
  id: Schema.String,
  /** Shown in `/model`, for example "DeepSeek V4 Flash". */
  name: Schema.optionalKey(Schema.String),
  /** The most tokens it writes in one reply. Requests ask for no more than this. */
  max_output: Schema.optionalKey(Schema.Int),
})

export type ProviderModel = typeof ProviderModel.Type

export const ProviderConfig = Schema.Struct({
  /** Short name used in `provider/model` and in commands, for example `ollama`. */
  id: Schema.String,
  /** Shown in lists, for example "Ollama on this machine". */
  name: Schema.String,
  kind: ProviderKind,
  /** The API root, for example `http://localhost:11434/v1`. */
  base_url: Schema.optionalKey(Schema.String),
  /** Which OpenAI API to speak. Compatible servers default to Chat Completions. */
  api: Schema.optionalKey(Schema.Literals(["chat", "responses"])),
  /** The models to offer. Without it, the server's own `/models` list is used. */
  models: Schema.optionalKey(Schema.Array(ProviderModel)),
})

export type ProviderConfig = typeof ProviderConfig.Type

/**
 * OpenAI's API root, for the OpenAI and ChatGPT providers. `$OPENAI_BASE_URL`
 * overrides it, as it does for OpenAI's own SDKs (Anthropic's SDK reads
 * `$ANTHROPIC_BASE_URL` the same way); the end-to-end tests use both to put
 * a recording proxy in front of the real APIs.
 */
export const OPENAI_BASE_URL = process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"

export const BUILTIN_PROVIDERS: ReadonlyArray<ProviderConfig> = [
  { id: "anthropic", name: "Anthropic", kind: "anthropic" },
  { id: "openai", name: "OpenAI", kind: "openai", base_url: OPENAI_BASE_URL, api: "responses" },
  { id: "chatgpt", name: "ChatGPT plan", kind: "chatgpt", base_url: OPENAI_BASE_URL, api: "responses" },
]

/** Built-in providers, then the configured ones (which cannot replace a built-in). */
export const allProviders = (configured: ReadonlyArray<ProviderConfig>): Array<ProviderConfig> => {
  const builtin = new Set(BUILTIN_PROVIDERS.map((provider) => provider.id))

  return [...BUILTIN_PROVIDERS, ...configured.filter((provider) => !builtin.has(provider.id))]
}

export const findProvider = (
  configured: ReadonlyArray<ProviderConfig>,
  id: string,
): ProviderConfig | undefined => allProviders(configured).find((provider) => provider.id === id)

/** The keychain account holding a provider's API key, or its ChatGPT sign-in. */
export const secretAccount = (provider: ProviderConfig): string =>
  provider.kind === "openai-compatible" ? `provider:${provider.id}` : provider.id

/** A provider id: lower case letters, digits and dashes, so it reads well in `provider/model`. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * A provider id made from a display name: "DwarfStar" becomes `dwarfstar`,
 * "My vLLM box" becomes `my-vllm-box`. Undefined when nothing usable is left.
 */
export const providerIdFrom = (name: string): string | undefined => {
  const id = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "")

  return PROVIDER_ID.test(id) ? id : undefined
}

/** Model ids from a comma-separated list, trimmed, without blanks or repeats. */
export const parseModelIds = (text: string): Array<string> => [
  ...new Set(
    text
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== ""),
  ),
]

/** A `ProviderModel` while it is being filled in. */
interface DraftModel {
  id: string
  name?: string
  max_output?: number
}

/**
 * The models to save for a server: the ids the user typed, with the name and
 * output limit the server reports for each, when it reports them.
 */
export const describeModels = (
  ids: ReadonlyArray<string>,
  listed: ReadonlyArray<ModelOption>,
): Array<ProviderModel> =>
  ids.map((id) => {
    const known = listed.find((option) => option.id === id)
    const model: DraftModel = { id }

    if (known !== undefined && known.name !== id) model.name = known.name

    if (known?.maxOutput !== undefined) model.max_output = known.maxOutput

    return model
  })

export interface ModelRef {
  readonly provider: string
  readonly model: string
}

/**
 * Split `provider/model` when the prefix names a provider; otherwise the
 * whole string is a model of `fallback`. Model ids may contain `/` themselves
 * (`openrouter/anthropic/claude-x`), so only the first segment is considered.
 */
export const splitModel = (
  configured: ReadonlyArray<ProviderConfig>,
  text: string,
  fallback: string,
): ModelRef => {
  const slash = text.indexOf("/")
  const prefix = slash === -1 ? "" : text.slice(0, slash)

  if (prefix !== "" && findProvider(configured, prefix) !== undefined)
    return { provider: prefix, model: text.slice(slash + 1) }

  return { provider: fallback, model: text }
}
