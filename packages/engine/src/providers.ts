/**
 * Model providers: where a model is served and how to authenticate.
 *
 * Three are built in: Anthropic, OpenAI (API key) and ChatGPT (sign in with
 * a ChatGPT plan). Any number of OpenAI-compatible servers can be added; they
 * live in the config file as `providers`. No provider entry holds a secret:
 * API keys and ChatGPT tokens are in the keychain, one account per provider.
 */
import { Schema } from "effect"

export const ProviderKind = Schema.Literals(["anthropic", "openai", "chatgpt", "openai-compatible"])

export type ProviderKind = typeof ProviderKind.Type

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
})

export type ProviderConfig = typeof ProviderConfig.Type

export const OPENAI_BASE_URL = "https://api.openai.com/v1"

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
